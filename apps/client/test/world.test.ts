import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Mesh, MeshStandardNodeMaterial, Scene } from 'three/webgpu';
import { DEMO_CELL, demoLot, cellAt, cellCenter, localFrame } from '@otherhere/core';
import { standFeatures, World, zonesFor } from '../src/world';
import { WAKE_MS } from '../src/material';

// Count the capsule builds the World starts, so a test can prove a superseded
// queued load never fetches (#60). The mock spreads the real module; only
// buildBundle is wrapped, and its behaviour is unchanged.
vi.mock('@otherhere/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@otherhere/core')>();
  const g = globalThis as { __bundleBuilds?: string[] };
  g.__bundleBuilds ??= [];
  return {
    ...mod,
    buildBundle: (input: Parameters<typeof mod.buildBundle>[0]) => {
      g.__bundleBuilds!.push(input.cell);
      return mod.buildBundle(input);
    },
  };
});

/** A one-house lot at (e, n): nothing else on the Cell, so a clearing test
 *  can move the house and ask what still suppresses growth. */
function oneHouseLot(cell: string, e: number, n: number) {
  const f = localFrame(cellCenter(cell));
  const ll = (x: number, y: number): [number, number] => {
    const p = f.unproject({ e: x, n: y });
    return [Math.round(p.lng * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7];
  };
  return [
    {
      id: 'osm:w100',
      kind: 'building' as const,
      attrs: {
        footprint: {
          value: [ll(e, n), ll(e + 11, n), ll(e + 11, n + 9), ll(e, n + 9)],
          confidence: 0.7,
          source: 'osm' as const,
        },
        building: { value: 'house', confidence: 0.9, source: 'osm' as const },
      },
    },
  ];
}

/** A position attribute shaped like three's, backed by a plain array. */
class Positions {
  private readonly a: Float32Array;
  constructor(n: number) {
    this.a = new Float32Array(n * 3);
  }
  get count(): number {
    return this.a.length / 3;
  }
  getX(i: number): number {
    return this.a[i * 3]!;
  }
  getY(i: number): number {
    return this.a[i * 3 + 1]!;
  }
  getZ(i: number): number {
    return this.a[i * 3 + 2]!;
  }
  setXYZ(i: number, x: number, y: number, z: number): void {
    this.a[i * 3] = x;
    this.a[i * 3 + 1] = y;
    this.a[i * 3 + 2] = z;
  }
  setY(i: number, y: number): void {
    this.a[i * 3 + 1] = y;
  }
}

type Range = { id: string; first: number; count: number };

/**
 * One Bundle's worth of flat geometry: six unowned ground-hexagon vertices
 * (before the first Feature's range, as the interpreter emits), then a tall
 * tree at the sea's edge on land, a tall tree inland, a tree at the shore, and
 * a road. Ground height is keyed by each feature's flat x.
 */
function flatBundle(): { pos: Positions; ranges: Range[] } {
  const pos = new Positions(30);
  const ranges: Range[] = [
    { id: 'osm:n6', first: 6, count: 6 },
    { id: 'osm:n7', first: 12, count: 6 },
    { id: 'osm:n8', first: 18, count: 6 },
    { id: 'osm:w1:n1-n2', first: 24, count: 6 },
  ];
  // (range index, flat x = z, tall?) — x doubles as the ground-height key below.
  for (const [k, x, tall] of [
    [0, 10, true],
    [1, 30, true],
    [2, 50, true],
    [3, 70, false],
  ] as const) {
    const r = ranges[k]!;
    for (let i = r.first; i < r.first + r.count; i++)
      pos.setXYZ(i, x, tall ? (i - r.first) * 4 : 0, x);
  }
  return { pos, ranges };
}

const heights: Record<number, number> = { 10: 0.4, 30: 100, 50: 0.4, 70: 100, 90: 800 };
const ground = (h: Record<number, number> = heights) => ({
  active: true,
  heightAt: (x: number) => h[x] ?? 100,
});

describe('standFeatures', () => {
  it('stands a tall tree on land, a tree even at the shore, and drapes flat things', () => {
    const { pos, ranges } = flatBundle();
    standFeatures(pos, ranges, 0, 0, ground());
    // The tree at 100 m: a rigid piece on the lowest ground under it, sunk 0.3.
    for (let i = 12; i < 18; i++) expect(pos.getY(i)).toBeCloseTo((i - 12) * 4 + 100 - 0.3, 5);
    // The observed tree at 0.4 m is someone's observation: it stands, ungated.
    for (let i = 18; i < 24; i++) expect(pos.getY(i)).toBeCloseTo((i - 18) * 4 + 0.4 - 0.3, 5);
    // The road is flat, so every vertex follows its own ground.
    for (let i = 24; i < 30; i++) expect(pos.getY(i)).toBeCloseTo(100 + 0.15, 5);
    // The flat ground hexagon is collapsed either way.
    for (let i = 0; i < 6; i++) expect(pos.getY(i)).toBe(-1000);
  });

  it('re-decides on finer ground: a shoreline tree rises once the ground rises', () => {
    const { pos, ranges } = flatBundle();
    standFeatures(pos, ranges, 0, 0, ground());
    for (let i = 6; i < 12; i++) expect(pos.getY(i)).toBeCloseTo((i - 6) * 4 + 0.4 - 0.3, 5);
    // A resnap resets from the flat positions and stands again (World.stand).
    const again = flatBundle();
    standFeatures(again.pos, again.ranges, 0, 0, ground({ ...heights, 10: 5 }));
    for (let i = 6; i < 12; i++) expect(again.pos.getY(i)).toBeCloseTo((i - 6) * 4 + 5 - 0.3, 5);
  });

  it('touches nothing while the ground is inactive (the e2e flat world)', () => {
    const { pos, ranges } = flatBundle();
    const before = Array.from({ length: pos.count }, (_, i) => pos.getY(i));
    standFeatures(pos, ranges, 0, 0, { ...ground(), active: false });
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBe(before[i]);
  });
});

describe('World.reload', () => {
  it('keeps the old Bundle on screen until the new one lands', async () => {
    const scene = new Scene();
    const world = new World(scene, DEMO_CELL, 'demo');
    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        const s = world.stats();
        if (s.ready === 1 && s.loading === 0) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('demo cell never settled');
    };
    world.update(0, 0); // wants the demo Cell
    await settle();
    const demoGroups = () => world.root.children.filter((o) => o.name === DEMO_CELL);
    expect(demoGroups()).toHaveLength(1);
    const before = demoGroups()[0]!;

    // A retry (or a capture sharpening a building) reloads the Cell. The old
    // Bundle must stay on screen while the new one is in flight.
    world.reload(DEMO_CELL);
    expect(world.stats().loading).toBe(1);
    expect(demoGroups()).toContain(before); // the screen never goes empty

    await settle();
    const after = demoGroups();
    expect(after).toHaveLength(1); // exactly one Bundle for the Cell
    expect(after[0]).not.toBe(before); // …and it is the new one
    expect(demoGroups()).not.toContain(before); // the stale one is retired
    expect(world.stats()).toMatchObject({ ready: 1, loading: 0, verified: 1 });
  }, 30_000);

  it('a reload while loading keeps exactly one group, and disposes the superseded loads (review P0 #3)', async () => {
    const scene = new Scene();
    // A capsule source we can reload freely: the stand-in for a sketch Cell's
    // retry firing while a previous retry is still in flight.
    const capsule = new Map([[DEMO_CELL, { features: demoLot(DEMO_CELL) }]]);
    const world = new World(scene, DEMO_CELL, { capsule });
    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        const s = world.stats();
        if (s.ready === 1 && s.loading === 0) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('capsule cell never settled');
    };
    const disposed = vi.spyOn(BufferGeometry.prototype, 'dispose');

    world.update(0, 0); // load A starts, suspended at its first await
    world.reload(DEMO_CELL); // load B supersedes A while it flies
    world.reload(DEMO_CELL); // and C supersedes B: three loads, one Cell
    await settle();

    // Exactly one Bundle on screen for the Cell…
    const groups = world.root.children.filter((o) => o.name === DEMO_CELL);
    expect(groups).toHaveLength(1);
    // …and one beacon set, not one per aborted load.
    expect(world.beaconRoot.children).toHaveLength(1);
    expect(world.stats()).toMatchObject({ ready: 1, loading: 0, verified: 1, errors: 0 });
    // The superseded loads' geometry went back where it came from: disposals
    // happened, and none of them was the surviving Bundle's geometry.
    const kept = new Set(groups[0]!.children.map((m) => (m as Mesh).geometry));
    expect(disposed.mock.contexts.length).toBeGreaterThan(0);
    for (const g of disposed.mock.contexts as BufferGeometry[]) expect(kept.has(g)).toBe(false);
    disposed.mockRestore();
  }, 30_000);

  it('carries the on-screen Bundle through a reload chain, and retires it when the last one lands', async () => {
    const scene = new Scene();
    const capsule = new Map([[DEMO_CELL, { features: demoLot(DEMO_CELL) }]]);
    const world = new World(scene, DEMO_CELL, { capsule });
    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        const s = world.stats();
        if (s.ready === 1 && s.loading === 0) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('capsule cell never settled');
    };
    world.update(0, 0);
    await settle();
    const demoGroups = () => world.root.children.filter((o) => o.name === DEMO_CELL);
    const first = demoGroups()[0]!;
    const retired = vi.spyOn((first.children[0] as Mesh).geometry, 'dispose');

    // Reload on top of a reload: the second fires while the first is still
    // loading. The Bundle on screen must ride the whole chain and leave only
    // when the final load stands in — not be dropped, leaked, mid-chain.
    world.reload(DEMO_CELL);
    world.reload(DEMO_CELL);
    await settle();

    expect(demoGroups()).toHaveLength(1);
    expect(demoGroups()[0]).not.toBe(first); // the new one stands in…
    expect(retired).toHaveBeenCalled(); // …and the old one was properly retired
    expect(world.stats()).toMatchObject({ ready: 1, loading: 0, verified: 1 });
    retired.mockRestore();
  }, 30_000);
});

describe('World wake-up (the moment new knowledge lands)', () => {
  it('wakes only when the Bundle really changed: a no-op retry stays still, a capture breathes from paper', async () => {
    const scene = new Scene();
    // A capsule we can rewrite between reloads: the stand-in for facts changing.
    const capsule = new Map([[DEMO_CELL, { features: demoLot(DEMO_CELL) }]]);
    const world = new World(scene, DEMO_CELL, { capsule });
    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        const s = world.stats();
        if (s.ready === 1 && s.loading === 0) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('capsule cell never settled');
    };
    world.update(0, 0);
    await settle();
    expect(world.stats().waking).toBe(0); // a first-ever load does not wake

    // A same-bytes reload (the sketch-retry case): the manifest hash matches,
    // so the world must hold still — a pulsing paper town would be noise.
    world.reload(DEMO_CELL);
    await settle();
    world.update(0, 0);
    expect(world.stats().waking).toBe(0);

    // New knowledge: one house's height becomes known differently (the effect
    // a capture has on the resolved attrs). The bytes change, the hash changes.
    const lot = demoLot(DEMO_CELL);
    const height = lot[1]!.attrs.height as unknown as { value: number };
    height.value = 12;
    capsule.set(DEMO_CELL, { features: lot });
    world.reload(DEMO_CELL);
    await settle();
    // The wake is in flight the moment the new Bundle stands in: the status
    // line can name it, and the material is still the waking one.
    expect(world.stats().waking).toBe(1);

    // WAKE_MS later it has breathed out: meshes back on the shared material,
    // the counter at rest.
    await new Promise((r) => setTimeout(r, WAKE_MS + 150));
    world.update(0, 0);
    expect(world.stats().waking).toBe(0);
    expect(world.stats()).toMatchObject({ ready: 1, loading: 0, verified: 1 });
  }, 30_000);
});

describe('the forest as Bundle data (ADR-0017, amended)', () => {
  it('parses landcover rings into the world frame, skipping the malformed', () => {
    // A square wood around (100, 200) in the Cell's local (e, n) axes, with the
    // Cell centre itself offset to (1000, 5000): world e = 1000 + e, n = 5000 + n,
    // and world z is -n. A broken ring (odd length) must be dropped, not thrown.
    const { zones, spruceP } = zonesFor(
      {
        mix: { hemlock: 0.7, spruce: 0.25, cedar: 0.05 },
        zones: [
          { id: 'osm:w1', cover: 'forest', ring: [-50, -50, 50, -50, 50, 50, -50, 50] },
          { id: 'osm:w2', cover: 'meadow', ring: [10, 10, 20] },
        ],
      },
      { e: 1000, n: 5000 },
    );
    expect(zones).toHaveLength(1);
    const wood = zones[0]!;
    expect(wood.cover).toBe('forest');
    expect(wood.ring[0]).toEqual({ e: 950, n: 4950 });
    expect(wood.ring[2]).toEqual({ e: 1050, n: 5050 });
    expect(wood.minE).toBe(950);
    expect(wood.maxN).toBe(5050);
    // The rainforest mix: a quarter of the conifers are spruce.
    expect(spruceP).toBeCloseTo(0.25, 5);
  });

  it('leaves the silhouette split open where the mix names no conifers', () => {
    expect(zonesFor({ mix: { broadleaf: 1 }, zones: [] }, { e: 0, n: 0 }).spruceP).toBeUndefined();
    expect(zonesFor(undefined, { e: 0, n: 0 }).spruceP).toBeUndefined();
    expect(zonesFor(undefined, { e: 0, n: 0 }).zones).toEqual([]);
  });

  it('answers landcover and the mix from a loaded Cell, end to end through the GLB', async () => {
    // The demo lot carries a wood west of the road and a scrub patch east of
    // it; the demo Cell is the world's origin, so local (e, n) is world (e, n)
    // and world z is -n. The extras survive a real build, GLB round-trip and
    // GLTF parse — this is the path production takes.
    const capsule = new Map([[DEMO_CELL, { features: demoLot(DEMO_CELL) }]]);
    const world = new World(new Scene(), DEMO_CELL, { capsule });
    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        const s = world.stats();
        if (s.ready === 1 && s.loading === 0) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('capsule cell never settled');
    };
    world.update(0, 0);
    await settle();

    // The wood: e in [-72, -46], n in [-40, -8] — and world z is -n.
    expect(world.landcoverAt(-60, 20)).toBe('forest');
    // The scrub patch: e in [58, 72], n in [-22, -4].
    expect(world.landcoverAt(65, 10)).toBe('scrub');
    // The road between them says nothing.
    expect(world.landcoverAt(0, 0)).toBeNull();
    // A point no Cell covers says nothing either.
    expect(world.landcoverAt(100_000, 100_000)).toBeNull();
    // The demo Town is temperate broadleaf with no conifers to name.
    expect(world.forestSpruceP(0, 0)).toBeUndefined();
  }, 30_000);
});

describe('reload hygiene (#60)', () => {
  const settle = async (world: World, ready: number) => {
    for (let i = 0; i < 1000; i++) {
      const s = world.stats();
      if (s.ready === ready && s.loading === 0) return s;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`world never settled at ${ready}`);
  };

  it('disposes the interrupted wake before a new one takes the Cell', async () => {
    const capsule = new Map([[DEMO_CELL, { features: demoLot(DEMO_CELL) }]]);
    const world = new World(new Scene(), DEMO_CELL, { capsule });
    world.update(0, 0);
    await settle(world, 1); // the first load never wakes

    // A real change lands and wakes; the Cell is ready with the wake in flight.
    const lot2 = demoLot(DEMO_CELL);
    (lot2[1]!.attrs.height as { value: number }).value = 12;
    capsule.set(DEMO_CELL, { features: lot2 });
    world.reload(DEMO_CELL);
    await settle(world, 1);
    expect(world.stats().waking).toBe(1);

    // A second change interrupts that wake: its material must be disposed when
    // the new Bundle's own wake takes the Cell, not overwritten into a leak.
    const disposed = vi.spyOn(MeshStandardNodeMaterial.prototype, 'dispose');
    const lot3 = demoLot(DEMO_CELL);
    (lot3[1]!.attrs.height as { value: number }).value = 16;
    capsule.set(DEMO_CELL, { features: lot3 });
    world.reload(DEMO_CELL);
    await settle(world, 1);
    expect(disposed).toHaveBeenCalledTimes(1); // the interrupted wake, at landing

    // The successor's own wake breathes out and hands its material back too.
    for (let t = 0; t < WAKE_MS + 400; t += 50) {
      world.update(0, 0);
      await new Promise((r) => setTimeout(r, 50));
    }
    world.update(0, 0);
    expect(world.stats().waking).toBe(0);
    expect(disposed).toHaveBeenCalledTimes(2);
    disposed.mockRestore();
  }, 30_000);

  it('never fetches a queued load its own reload has superseded', async () => {
    // Three Cells fill every load slot, so a reload of one queues behind them;
    // a second reload supersedes the first's queued job while it still waits.
    // (Far enough apart to be three distinct res-9 Cells, not one.)
    const a = DEMO_CELL;
    const b = cellAt(47.3799, 8.5417);
    const c = cellAt(47.3739, 8.5417);
    const capsule = new Map([
      [a, { features: demoLot(a) }],
      [b, { features: demoLot(b) }],
      [c, { features: demoLot(c) }],
    ]);
    const world = new World(new Scene(), a, { capsule });
    const builds = (globalThis as { __bundleBuilds?: string[] }).__bundleBuilds!;
    builds.length = 0;
    world.update(0, 0); // three loads in flight, every slot taken

    // Both reloads fire while the slots are full, so their jobs queue behind:
    // the first's job is still waiting when the second supersedes it.
    const lot2 = demoLot(a);
    (lot2[1]!.attrs.height as { value: number }).value = 12;
    capsule.set(a, { features: lot2 });
    world.reload(a); // queued behind the three in flight
    const lot3 = demoLot(a);
    (lot3[1]!.attrs.height as { value: number }).value = 16;
    capsule.set(a, { features: lot3 });
    world.reload(a); // supersedes the queued job above
    await settle(world, 3);

    // Cell a built exactly twice: its first load, and the newest reload's. The
    // middle job never fetched — the skip at the pump is the whole fix.
    expect(builds.filter((cell) => cell === a)).toHaveLength(2);
    expect(world.stats()).toMatchObject({ ready: 3, loading: 0, errors: 0 });
  }, 30_000);

  it('re-indexes the clearings after a retire: a moved house stops suppressing its old ground', async () => {
    // The house starts at (0, 0): its clearing disc keeps the forest out of
    // the ground it covers. The reload moves it 40 m away; once the stale
    // Bundle retires, only the new clearing is in the index.
    const capsule = new Map([[DEMO_CELL, { features: oneHouseLot(DEMO_CELL, 0, 0) }]]);
    const world = new World(new Scene(), DEMO_CELL, { capsule });
    world.update(0, 0);
    await settle(world, 1);
    // w100 at (0,0)-(11,9): the disc's centre, in world z = -n.
    expect(world.occupied(5, -4)).toBe(true);

    capsule.set(DEMO_CELL, { features: oneHouseLot(DEMO_CELL, 40, 40) });
    world.reload(DEMO_CELL);
    await settle(world, 1);
    expect(world.occupied(45, -44)).toBe(true); // the new clearing
    expect(world.occupied(5, -4)).toBe(false); // the stale one is gone
  }, 30_000);
});
