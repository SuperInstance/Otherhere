import { describe, expect, it } from 'vitest';
import { Scene, type InstancedMesh, Matrix4 } from 'three/webgpu';
import { Forest } from '../src/forest';

/** Rolling hills from 0 to 400 m: plenty of plantable ground, some beach and sea. */
const hills = {
  active: true,
  heightAt: (x: number, z: number) =>
    Math.max(0, 200 + 180 * Math.sin(x / 700) * Math.cos(z / 900)),
};

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
});
