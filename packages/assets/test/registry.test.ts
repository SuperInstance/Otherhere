import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCapture, readRegistry, registryManifest, sha256 } from '../src/registry';
import { createCaptureService } from '../src/server';

const PAYLOAD = Buffer.from('a gaussian field, more or less');
const CARD = Buffer.from('a photograph of a building');
const MODEL = Buffer.from('glTF\u0000\u0000\u0000 a triangle mesh');

/** Build a capture directory the way the capture pipeline writes one. */
const makeCapture = (
  root: string,
  family: string,
  version: string,
  opts: { corrupt?: boolean } = {},
): void => {
  const dir = join(root, family, version);
  mkdirSync(join(dir, 'tiers'), { recursive: true });
  const meshHash = sha256(PAYLOAD);
  const cardHash = sha256(CARD);
  const modelHash = sha256(MODEL);
  writeFileSync(join(dir, 'tiers', 'mesh.spz'), PAYLOAD);
  writeFileSync(join(dir, 'tiers', 'card.webp'), CARD);
  writeFileSync(join(dir, 'tiers', 'model.glb'), MODEL);
  writeFileSync(
    join(dir, 'tiers', 'mesh.spz.receipt.json'),
    JSON.stringify({ file: 'mesh.spz', tier: 'mesh', hash: meshHash, bytes: PAYLOAD.byteLength }),
  );
  writeFileSync(
    join(dir, 'tiers', 'card.webp.receipt.json'),
    JSON.stringify({ file: 'card.webp', tier: 'card', hash: cardHash, bytes: CARD.byteLength }),
  );
  writeFileSync(
    join(dir, 'tiers', 'model.glb.receipt.json'),
    JSON.stringify({ file: 'model.glb', tier: 'model', hash: modelHash, bytes: MODEL.byteLength }),
  );
  writeFileSync(
    join(dir, 'asset.capture.json'),
    JSON.stringify({
      family,
      version,
      contentHash: sha256(Buffer.from(`${family}/${version}`)),
      kind: 'distilled',
      approval: 'draft',
      tiers: {
        mesh: { hash: meshHash, bytes: PAYLOAD.byteLength },
        card: { hash: cardHash, bytes: CARD.byteLength },
        model: { hash: modelHash, bytes: MODEL.byteLength },
      },
      params: { subject: { name: family } },
      provenance: { source: 'capture' },
    }),
  );
  if (opts.corrupt) {
    // A payload that no longer matches its receipt — the half-written-file case.
    writeFileSync(join(dir, 'tiers', 'card.webp'), Buffer.from('tampered'));
  }
};

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'captures-'));
  makeCapture(root, 'sitka-dock-boat', '1.0.0');
  makeCapture(root, 'st-michaels-cathedral', '1.0.0');
  makeCapture(root, 'broken-capture', '1.0.0', { corrupt: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readCapture', () => {
  it('reads the tiers and translates the pipeline tier names to the client names', () => {
    const { entry, problems } = readCapture(join(root, 'sitka-dock-boat', '1.0.0'));
    expect(problems).toEqual([]);
    expect(Object.keys(entry.tiers).sort()).toEqual(['card', 'model', 'splat']);
    // The pipeline calls it "mesh"; the client calls it "splat".
    expect(entry.tiers.splat?.file).toBe('mesh.spz');
    expect(entry.tiers.splat?.path).toBe('assets/sitka-dock-boat/1.0.0/splat.spz');
    expect(entry.tiers.card?.path).toBe('assets/sitka-dock-boat/1.0.0/card.webp');
    expect(entry.tiers.splat?.contentType).toBe('model/gaussian-splat');
    // A real triangle mesh keeps its own name in both vocabularies: the
    // pipeline writes `model.glb`, the client calls the tier `model`.
    expect(entry.tiers.model?.file).toBe('model.glb');
    expect(entry.tiers.model?.path).toBe('assets/sitka-dock-boat/1.0.0/model.glb');
    expect(entry.tiers.model?.contentType).toBe('model/gltf-binary');
  });

  it('refuses a payload that does not match its receipt', () => {
    const { entry, problems } = readCapture(join(root, 'broken-capture', '1.0.0'));
    expect(entry.tiers.card).toBeUndefined();
    expect(entry.tiers.splat).toBeDefined();
    expect(problems.join(' ')).toMatch(/card: .* hashes /);
  });
});

describe('readRegistry', () => {
  it('lists every capture and reports the broken one as a problem', () => {
    const registry = readRegistry(root);
    expect(registry.captures.map((c) => c.family).sort()).toEqual([
      'broken-capture',
      'sitka-dock-boat',
      'st-michaels-cathedral',
    ]);
    expect(registry.problems.length).toBe(1);
    expect(registry.problems[0]?.capture).toBe('broken-capture/1.0.0');
  });

  it('reports a missing root rather than throwing', () => {
    const registry = readRegistry(join(root, 'no-such-place'));
    expect(registry.captures).toEqual([]);
    expect(registry.problems.length).toBe(1);
  });
});

describe('registryManifest', () => {
  it('gives the renderer the path, the byte count and the hash for each tier', () => {
    const manifest = registryManifest(readRegistry(root));
    expect(manifest.format).toBe('otherhere.capture-registry.v1');
    const dock = manifest.captures.find((c) => c.family === 'sitka-dock-boat');
    const splat = dock?.tiers.find((t) => t.tier === 'splat');
    expect(splat?.path).toBe('assets/sitka-dock-boat/1.0.0/splat.spz');
    expect(splat?.bytes).toBe(PAYLOAD.byteLength);
    expect(splat?.hash).toBe(sha256(PAYLOAD));
  });
});

describe('the capture service', () => {
  it('serves a verified tier at the path the manifest names, with its hash', async () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    await service.listen();
    const address = service.address();
    expect(address).not.toBeNull();
    const base = `http://127.0.0.1:${address!.port}`;

    const res = await fetch(`${base}/places/assets/sitka-dock-boat/1.0.0/splat.spz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gaussian-splat');
    expect(res.headers.get('x-content-sha256')).toBe(sha256(PAYLOAD));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.byteLength).toBe(PAYLOAD.byteLength);
    expect(sha256(body)).toBe(sha256(PAYLOAD));

    await service.close();
  });

  it('serves a real triangle mesh at its own tier path', async () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    await service.listen();
    const base = `http://127.0.0.1:${service.address()!.port}`;

    const res = await fetch(`${base}/places/assets/sitka-dock-boat/1.0.0/model.glb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('x-content-sha256')).toBe(sha256(MODEL));
    const body = Buffer.from(await res.arrayBuffer());
    expect(sha256(body)).toBe(sha256(MODEL));

    await service.close();
  });

  it('serves the manifest and a health line', async () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    await service.listen();
    const base = `http://127.0.0.1:${service.address()!.port}`;

    const health = (await (await fetch(`${base}/health`)).json()) as {
      status: string;
      problems: number;
    };
    expect(health.status).toBe('ok');
    expect(health.problems).toBe(1);

    const manifest = (await (await fetch(`${base}/places/registry.json`)).json()) as {
      format: string;
    };
    expect(manifest.format).toBe('otherhere.capture-registry.v1');

    await service.close();
  });

  it('does not serve a payload that failed verification', async () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    await service.listen();
    const base = `http://127.0.0.1:${service.address()!.port}`;

    const res = await fetch(`${base}/places/assets/broken-capture/1.0.0/card.webp`);
    expect(res.status).toBe(404);

    await service.close();
  });

  it('indexes only the verified tiers', () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    // The broken capture's card tier must not be servable.
    expect(service.files.has('assets/broken-capture/1.0.0/card.webp')).toBe(false);
    expect(service.files.has('assets/broken-capture/1.0.0/splat.spz')).toBe(true);
    expect(service.files.has('assets/sitka-dock-boat/1.0.0/splat.spz')).toBe(true);
  });
});
