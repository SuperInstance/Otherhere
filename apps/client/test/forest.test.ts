import { describe, expect, it } from 'vitest';
import { Scene, type InstancedMesh, Matrix4 } from 'three/webgpu';
import { Forest } from '../src/forest';

/** Rolling hills from 0 to 400 m: plenty of plantable ground, some beach and sea. */
const hills = {
  active: true,
  heightAt: (x: number, z: number) =>
    Math.max(0, 200 + 180 * Math.sin(x / 700) * Math.cos(z / 900)),
};

/** Live instances under one chunk's named meshes (planting names them by chunk). */
function chunkTrees(forest: Forest, ix: number, iz: number): number {
  let n = 0;
  forest.root.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (mesh.isInstancedMesh && mesh.name === `${ix},${iz}`) n += mesh.count;
  });
  return n;
}

function planted(opts: ConstructorParameters<typeof Forest>[2] = {}) {
  const forest = new Forest(new Scene(), hills, { radius: 400, ...opts });
  for (let i = 0; i < 20; i++) forest.update(0, 0);
  const matrices: number[] = [];
  forest.root.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const m = new Matrix4();
    for (let k = 0; k < Math.min(mesh.count, 3); k++) {
      mesh.getMatrixAt(k, m);
      matrices.push(...m.elements.map((v) => Math.round(v * 1000) / 1000));
    }
  });
  return { forest, matrices };
}

describe('Forest', () => {
  it('plants the same trees every time (seeded per chunk, no Math.random)', () => {
    const a = planted();
    const b = planted();
    expect(a.forest.stats().trees).toBeGreaterThan(100);
    expect(a.forest.stats()).toEqual(b.forest.stats());
    expect(a.matrices).toEqual(b.matrices);
  });

  it('never plants where something stands, and keeps to its budget', () => {
    const open = planted().forest.stats().trees;
    const half = planted({ occupied: (x) => x < 0 }).forest.stats().trees;
    expect(half).toBeLessThan(open * 0.75);
    expect(planted({ maxTrees: 500 }).forest.stats().trees).toBeLessThanOrEqual(500);
  });

  it('plants nothing until the ground is known', () => {
    const forest = new Forest(new Scene(), { active: false, heightAt: () => 100 }, { radius: 400 });
    for (let i = 0; i < 10; i++) forest.update(0, 0);
    expect(forest.stats().trees).toBe(0);
  });

  it('thins distant chunks, so the budget reaches the horizon instead of a hard edge', () => {
    // All-hill ground: at one tree per candidate the default budget would plant
    // ~26000/775 ≈ 34 chunks and stop; banded, it covers nearly the whole radius.
    const forest = new Forest(new Scene(), hills, { radius: 1400 });
    for (let i = 0; i < 600; i++) forest.update(0, 0);
    const s = forest.stats();
    // ~π × 1400² / 250² ≈ 98 chunks fit inside the radius: nearly all of them plant.
    expect(s.chunks).toBeGreaterThan(80);
    expect(s.trees).toBeLessThanOrEqual(26000);
    // The nearest chunk is full and a chunk past the second band is present but thin.
    expect(chunkTrees(forest, 0, 0)).toBeGreaterThan(3 * chunkTrees(forest, 4, 0));
    expect(chunkTrees(forest, 4, 0)).toBeGreaterThan(0);
  });

  it('sharpens a chunk as the walker approaches, and never flickers at a boundary', () => {
    const forest = new Forest(new Scene(), hills, { radius: 1400 });
    for (let i = 0; i < 600; i++) forest.update(0, 0);
    const far = chunkTrees(forest, 4, 0); // chunk centre (1125, 125): 1132 m out, stride 4

    // 810 m from that chunk: inside the stride-2 band, but not past the refine
    // margin (950 × 0.8 = 760), so the chunk stays exactly as it was.
    for (let i = 0; i < 200; i++) forest.update(325, 0);
    expect(chunkTrees(forest, 4, 0)).toBe(far);

    // 711 m: past the margin, the chunk refines to stride 2 and grows.
    for (let i = 0; i < 200; i++) forest.update(425, 0);
    const mid = chunkTrees(forest, 4, 0);
    expect(mid).toBeGreaterThan(far * 1.5);

    // Standing in it: full stride, the same trees a fresh full plant would grow.
    for (let i = 0; i < 200; i++) forest.update(1125, 0);
    expect(chunkTrees(forest, 4, 0)).toBeGreaterThan(mid * 1.5);
    const full = chunkTrees(forest, 4, 0);

    // Walking away along the coarsen boundary: 501–540 m is past the stride-1 band
    // (450 m) but inside its coarsen margin (562 m), so the chunk stays full
    // instead of replanting every few steps.
    for (const x of [600, 640, 600, 640, 600]) {
      for (let i = 0; i < 40; i++) forest.update(x, 0);
    }
    expect(chunkTrees(forest, 4, 0)).toBe(full);

    // Well past the coarsen margin, it thins again.
    for (let i = 0; i < 200; i++) forest.update(0, 0);
    expect(chunkTrees(forest, 4, 0)).toBeLessThan(full);
  });
});
