import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPlaceAssets } from '../src/places';
import { readRegistry, sha256 } from '../src/registry';
import { createCaptureService } from '../src/server';

const PAYLOAD = Buffer.from('a gaussian field, baked into a place');
const CARD = Buffer.from('a photograph of a building');

/**
 * Build a places directory the way the client ships one: the place file, and
 * the `assets/` tree beside it, with the place file naming every tier.
 */
const makePlace = (
  placesDir: string,
  family: string,
  opts: { corrupt?: boolean; missing?: boolean } = {},
): void => {
  const dir = join(placesDir, 'assets', family, '1.0.0');
  mkdirSync(dir, { recursive: true });
  const splatHash = sha256(PAYLOAD);
  const cardHash = sha256(CARD);
  writeFileSync(join(dir, 'splat.spz'), opts.corrupt ? Buffer.from('tampered') : PAYLOAD);
  if (!opts.missing) writeFileSync(join(dir, 'card.webp'), CARD);

  writeFileSync(
    join(placesDir, 'sitka.json'),
    JSON.stringify({
      format: 'otherhere.capsule',
      cells: [],
      snapshot: {
        facts: {
          '275': {
            value: {
              family,
              version: '1.0.0',
              tiers: {
                splat: {
                  path: `assets/${family}/1.0.0/splat.spz`,
                  hash: splatHash,
                  bytes: PAYLOAD.byteLength,
                  contentType: 'application/octet-stream',
                },
                card: {
                  path: `assets/${family}/1.0.0/card.webp`,
                  hash: cardHash,
                  bytes: CARD.byteLength,
                  contentType: 'image/webp',
                },
              },
            },
          },
        },
      },
    }),
  );
};

let placesDir: string;
let root: string;

beforeAll(() => {
  placesDir = mkdtempSync(join(tmpdir(), 'places-'));
  root = mkdtempSync(join(tmpdir(), 'captures-'));
  makePlace(placesDir, 'st-michaels-cathedral');
});

afterAll(() => {
  rmSync(placesDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('readPlaceAssets', () => {
  it('verifies the payloads the place file vouches for', () => {
    const assets = readPlaceAssets(placesDir);
    expect(assets.problems).toEqual([]);
    expect(assets.files.size).toBe(2);
    const splat = assets.files.get('assets/st-michaels-cathedral/1.0.0/splat.spz');
    expect(splat?.hash).toBe(sha256(PAYLOAD));
    expect(splat?.bytes).toBe(PAYLOAD.byteLength);
    expect(splat?.contentType).toBe('model/gaussian-splat');
    expect(splat?.place).toBe('sitka.json');
  });

  it('refuses a payload whose bytes do not match the place file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'places-bad-'));
    makePlace(dir, 'broken-place', { corrupt: true });
    const assets = readPlaceAssets(dir);
    expect(assets.files.has('assets/broken-place/1.0.0/splat.spz')).toBe(false);
    expect(assets.problems.map((p) => p.reason).join(' ')).toMatch(/splat: .* hashes /);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a payload the place file names but that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'places-gone-'));
    makePlace(dir, 'gone-place', { missing: true });
    const assets = readPlaceAssets(dir);
    expect(assets.files.has('assets/gone-place/1.0.0/card.webp')).toBe(false);
    expect(assets.problems.map((p) => p.reason).join(' ')).toMatch(/card: payload missing/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing places directory rather than throwing', () => {
    const assets = readPlaceAssets(join(placesDir, 'no-such-place'));
    expect(assets.files.size).toBe(0);
    expect(assets.problems.length).toBe(1);
  });
});

describe('the capture service, with place assets', () => {
  it('serves a place-vouched payload at the path the place file names', async () => {
    const service = createCaptureService({
      root,
      placesDir,
      port: 0,
      host: '127.0.0.1',
    });
    await service.listen();
    const base = `http://127.0.0.1:${service.address()!.port}`;

    const res = await fetch(`${base}/places/assets/st-michaels-cathedral/1.0.0/splat.spz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gaussian-splat');
    expect(res.headers.get('x-content-sha256')).toBe(sha256(PAYLOAD));
    expect(res.headers.get('x-content-source')).toBe('place sitka.json');
    const body = Buffer.from(await res.arrayBuffer());
    expect(sha256(body)).toBe(sha256(PAYLOAD));

    await service.close();
  });

  it('counts the place assets in the health line', async () => {
    const service = createCaptureService({
      root,
      placesDir,
      port: 0,
      host: '127.0.0.1',
    });
    await service.listen();
    const health = (await (
      await fetch(`http://127.0.0.1:${service.address()!.port}/health`)
    ).json()) as { placeAssets: number; tiers: number };
    expect(health.placeAssets).toBe(2);
    expect(health.tiers).toBe(2);

    await service.close();
  });

  it('does not serve a place payload that failed verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'places-bad2-'));
    makePlace(dir, 'broken-place', { corrupt: true });
    const service = createCaptureService({
      root,
      placesDir: dir,
      port: 0,
      host: '127.0.0.1',
    });
    await service.listen();
    const res = await fetch(
      `http://127.0.0.1:${service.address()!.port}/places/assets/broken-place/1.0.0/splat.spz`,
    );
    expect(res.status).toBe(404);

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the capture registry unchanged when there is no places directory', () => {
    const service = createCaptureService({ root, port: 0, host: '127.0.0.1' });
    expect(service.placeAssets.files.size).toBe(0);
    expect(service.files.size).toBe(0);
    expect(readRegistry(root).captures.length).toBe(0);
  });
});
