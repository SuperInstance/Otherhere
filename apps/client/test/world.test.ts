import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Mesh, Scene } from 'three/webgpu';
import { DEMO_CELL, demoLot } from '@otherhere/core';
import { standFeatures, World, zonesFor } from '../src/world';
import { WAKE_MS } from '../src/material';

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
