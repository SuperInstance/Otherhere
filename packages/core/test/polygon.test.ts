import { describe, expect, it } from 'vitest';
import { cleanRing, centroid, minAreaRect, signedArea } from '../src/geometry/polygon';
import { MeshBuilder } from '../src/geometry/mesh';

const sq = [
  { e: 0, n: 0 },
  { e: 0, n: 10 },
  { e: 20, n: 10 },
  { e: 20, n: 0 },
  { e: 0, n: 0 },
];

describe('polygon helpers', () => {
  it('cleanRing drops the closing point and makes rings CCW', () => {
    const r = cleanRing(sq);
    expect(r).toHaveLength(4);
    expect(signedArea(r)).toBe(200);
  });
  it('centroid of a rectangle is its middle', () => {
    expect(centroid(cleanRing(sq))).toEqual({ e: 10, n: 5 });
  });
  it('minAreaRect finds the long axis of a rotated rectangle', () => {
    // 20 x 10 rectangle rotated 45°.
    const k = Math.SQRT1_2;
    const pts = [
      { e: 0, n: 0 },
      { e: 20 * k, n: 20 * k },
      { e: 20 * k - 10 * k, n: 20 * k + 10 * k },
      { e: -10 * k, n: 10 * k },
    ];
    const r = minAreaRect(pts);
    expect(r.halfL).toBeCloseTo(10, 9);
    expect(r.halfW).toBeCloseTo(5, 9);
    expect(Math.abs(r.u.e)).toBeCloseTo(k, 9);
  });
});

describe('MeshBuilder', () => {
  it('orients faces along the requested outward normal', () => {
    const m = new MeshBuilder();
    m.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], '#ff0000', [1, 1], [0, 0, -1]);
    const d = m.build();
    expect(Array.from(d.normals.slice(0, 3))).toEqual([0, 0, -1]);
    expect(d.indices).toHaveLength(6);
    expect(Array.from(d.colours.slice(0, 4))).toEqual([65535, 0, 0, 65535]);
  });
  it('triangulates concave polygons', () => {
    const m = new MeshBuilder();
    const L: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, -1],
      [1, 0, -1],
      [1, 0, -2],
      [0, 0, -2],
    ];
    m.polygon(L, '#00ff00', [1, 1], [0, 1, 0]);
    expect(m.build().indices).toHaveLength(12);
  });
});
