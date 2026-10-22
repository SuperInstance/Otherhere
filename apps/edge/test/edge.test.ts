import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  buildBundle,
  cellAt,
  cellsOfBlock,
  demoLot,
  DEMO_CELL,
  GOLDEN_DEMO,
  ingestBlockOf,
  sha256Hex,
  townOf,
  type Feature,
  type OverpassResponse,
  type ResolvedAttrs,
} from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const town = (cell: string) => env.TOWN.get(env.TOWN.idFromName(townOf(cell)));
const BLOCK = (fixture as unknown as { block: string }).block;
const CELL = cellsOfBlock(BLOCK)[0]!;

type CellFacts = { features: Feature[]; resolved: Record<string, ResolvedAttrs> };
const cellFacts = async (cell: string) =>
  (await town(cell).cellFacts(cell)) as unknown as CellFacts;

async function seed() {
  await town(CELL).ingestOverpass(
    BLOCK,
    fixture as unknown as OverpassResponse,
    '2026-10-17T00:00:00.000Z',
  );
}

async function getBundle(cell: string) {
  const info = (await (await SELF.fetch(`https://x/api/cells/${cell}`)).json()) as {
    status: string;
    cached: boolean;
    manifest: { inputsHash: string; outputHash: string; featureCount: number; bytes: number };
  };
  const res = await SELF.fetch(`https://x/api/bundles/${info.manifest.inputsHash}.glb`);
  return { info, res };
}

describe('determinism across runtimes (invariant 2)', () => {
  it('builds the golden demo lot byte-for-byte in workerd', async () => {
    const { manifest } = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
    expect(manifest.outputHash).toBe(GOLDEN_DEMO.outputHash);
    expect(manifest.inputsHash).toBe(GOLDEN_DEMO.inputsHash);
  });
});

describe('API', () => {
  it('reports health', async () => {
    const res = await SELF.fetch('https://x/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('rejects things that are not res-9 Cells', async () => {
    expect((await SELF.fetch('https://x/api/cells/nope')).status).toBe(400);
    expect((await SELF.fetch(`https://x/api/cells/${townOf(CELL)}`)).status).toBe(400);
  });

  it('locates a lat/lng', async () => {
    const res = await SELF.fetch('https://x/api/locate?lat=47.3769&lng=8.5417');
    const body = (await res.json()) as { cell: string; ring: string[]; town: string };
    expect(body.cell).toBe(DEMO_CELL);
    expect(body.ring).toHaveLength(7);
  });
});

describe('TownDO + R2 bundle pipeline', () => {
  it('builds a Bundle from stored Facts and caches it in R2 by content address', async () => {
    await seed();
    const first = await getBundle(CELL);
    expect(first.info.status).toBe('ok');
    expect(first.info.cached).toBe(false);
    expect(first.info.manifest.featureCount).toBeGreaterThan(100);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(first.res.headers.get('cache-control')).toContain('immutable');
    const bytes = new Uint8Array(await first.res.arrayBuffer());
    expect(await sha256Hex(bytes)).toBe(first.info.manifest.outputHash);

    const second = await getBundle(CELL);
    expect(second.info.cached).toBe(true);
    expect(second.info.manifest).toEqual(first.info.manifest);
  });

  it('a higher-ranked Fact changes the resolved value and so the content address', async () => {
    await seed();
    const before = await getBundle(CELL);
    const { features } = await cellFacts(CELL);
    const building = features.find((f) => f.kind === 'building')!;
    await town(CELL).putFacts([
      {
        featureId: building.id,
        attribute: 'height',
        value: 42,
        source: 'manual_edit',
        confidence: 1,
        observedAt: '2026-10-17T01:00:00.000Z',
        version: 1,
      },
    ]);
    const after = await getBundle(CELL);
    expect(after.info.manifest.inputsHash).not.toBe(before.info.manifest.inputsHash);
    const { resolved } = await cellFacts(CELL);
    expect(resolved[building.id]?.height).toEqual({
      value: 42,
      confidence: 1,
      source: 'manual_edit',
    });
  });

  it('re-ingesting the same OSM data is idempotent', async () => {
    await seed();
    const a = await getBundle(CELL);
    await seed();
    const b = await getBundle(CELL);
    expect(b.info.manifest.inputsHash).toBe(a.info.manifest.inputsHash);
    expect(b.info.cached).toBe(true);
  });

  it('rejects invalid Facts', async () => {
    await seed();
    // Settle the RPC promise directly; `expect().rejects` leaves workerd's copy unhandled.
    const err = await town(CELL)
      .putFacts([
        {
          featureId: 'osm:w1',
          attribute: 'height',
          value: -5,
          source: 'osm',
          confidence: 1,
          observedAt: '2026-10-17T00:00:00.000Z',
          version: 1,
        },
      ])
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).toMatch(/invalid Fact/);
  });

  it('serves a sketch (ground only) when Overpass is unreachable, and says so', async () => {
    // Tests point OVERPASS_ENDPOINTS at a closed port: no network in tests.
    const elsewhere = cellAt(40.7128, -74.006); // Lower Manhattan, not seeded
    expect(ingestBlockOf(elsewhere)).not.toBe(BLOCK);
    const { info, res } = await getBundle(elsewhere);
    expect(info.status).toBe('failed');
    expect(info.manifest.featureCount).toBe(0);
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer()).toBeDefined();
  });

  it('404s unknown bundle hashes', async () => {
    expect((await SELF.fetch(`https://x/api/bundles/${'0'.repeat(64)}.glb`)).status).toBe(404);
  });
});

describe('the imagined forest at the edge (ADR-0017)', () => {
  it("carries the Town's biome and species in its Essence, and grows a wild stand", async () => {
    // Sitka: six observed trees, four hemlock and two spruce, on Baranof Island.
    const cell = cellAt(57.0537, -135.33);
    await town(cell).ingestOverpass(
      ingestBlockOf(cell),
      {
        elements: Array.from({ length: 6 }, (_, i) => ({
          type: 'node' as const,
          id: 9000 + i,
          lat: 57.0537 + i * 1e-4,
          lon: -135.33,
          tags: {
            natural: 'tree',
            taxon: i < 4 ? 'Tsuga heterophylla' : 'Picea sitchensis',
          },
        })),
      },
      '2026-10-19T00:00:00.000Z',
    );
    // The stub's inferred method map is deeper than tsc enjoys here; take the
    // one member we need (the file's standing `as unknown as` pattern).
    const snap = await (
      town(cell) as unknown as {
        snapshot(c: string): Promise<{
          essence: { biome?: string; forest?: Record<string, number> };
        }>;
      }
    ).snapshot(cell);
    expect(snap.essence.biome).toBe('pacific-rainforest');
    expect(snap.essence.forest).toEqual({ hemlock: 0.65, spruce: 0.35 });

    // Six observed trees, drawn by the generator; the wild stand around them
    // is the display forest's job now (ADR-0017, amended 2026-10-22), so the
    // Bundle carries the Town's mix as extras instead of a thousand Features.
    // The same bundle twice (invariant 2, through the R2 cache).
    const { info } = await getBundle(cell);
    expect(info.status).toBe('ok');
    expect(info.manifest.featureCount).toBe(6);
    // Measured 51,684: the six observed trees are the whole payload now. The
    // same Cell before the forest move built ~1.6 MB with its imagined stand.
    expect(info.manifest.bytes).toBeLessThan(60_000);
    const again = await getBundle(cell);
    expect(again.info.manifest).toEqual(info.manifest);
    expect(again.info.cached).toBe(true);
  });
});

describe('dev routes', () => {
  it('are disabled unless ALLOW_DEV_ROUTES is set', async () => {
    const res = await SELF.fetch(`https://x/api/dev/blocks/${BLOCK}`, {
      method: 'POST',
      body: '{"elements":[]}',
    });
    expect(res.status).toBe(405);
  });
});
