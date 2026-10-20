import { describe, expect, it } from 'vitest';
import { Scene } from 'three/webgpu';
import { DEMO_CELL } from '@otherhere/core';
import { standFeatures, World } from '../src/world';

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
 * (before the first Feature's range, as the interpreter emits), then an imagined
 * tree in the sea, an imagined tree on land, an observed tree at the sea's edge,
 * and a road. Ground height is keyed by each feature's flat x.
 */
function flatBundle(): { pos: Positions; ranges: Range[] } {
  const pos = new Positions(30);
  const ranges: Range[] = [
    { id: 'gen:sea', first: 6, count: 6 },
    { id: 'gen:land', first: 12, count: 6 },
    { id: 'osm:n7', first: 18, count: 6 },
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
  it('collapses an imagined tree below the beach line, so the stand ends at the coast', () => {
    const { pos, ranges } = flatBundle();
    standFeatures(pos, ranges, 0, 0, ground());
    const r = ranges[0]!; // gen:sea, at 0.4 m: intertidal
    for (let i = r.first; i < r.first + r.count; i++)
      expect([pos.getX(i), pos.getY(i), pos.getZ(i)]).toEqual([0, -1000, 0]);
  });

  it('collapses an imagined tree above the timber line', () => {
    const pos = new Positions(12);
    const ranges: Range[] = [{ id: 'gen:alpine', first: 6, count: 6 }];
    for (let i = 6; i < 12; i++) pos.setXYZ(i, 90, (i - 6) * 4, 90);
    standFeatures(pos, ranges, 0, 0, ground());
    for (let i = 6; i < 12; i++) expect(pos.getY(i)).toBe(-1000);
  });

  it('stands an imagined tree on land, an observed tree even at the shore, and drapes flat things', () => {
    const { pos, ranges } = flatBundle();
    standFeatures(pos, ranges, 0, 0, ground());
    // gen:land at 100 m: a rigid piece on the lowest ground under it, sunk 0.3.
    for (let i = 12; i < 18; i++) expect(pos.getY(i)).toBeCloseTo((i - 12) * 4 + 100 - 0.3, 5);
    // The observed tree at 0.4 m is someone's observation: it stands, ungated.
    for (let i = 18; i < 24; i++) expect(pos.getY(i)).toBeCloseTo((i - 18) * 4 + 0.4 - 0.3, 5);
    // The road is flat, so every vertex follows its own ground.
    for (let i = 24; i < 30; i++) expect(pos.getY(i)).toBeCloseTo(100 + 0.15, 5);
    // The flat ground hexagon is collapsed either way.
    for (let i = 0; i < 6; i++) expect(pos.getY(i)).toBe(-1000);
  });

  it('re-decides on finer ground: a tree the sea rejected stands once the ground rises', () => {
    const { pos, ranges } = flatBundle();
    standFeatures(pos, ranges, 0, 0, ground());
    for (let i = 6; i < 12; i++) expect(pos.getY(i)).toBe(-1000);
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
});
