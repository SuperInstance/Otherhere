import { describe, expect, it } from 'vitest';
import { sampleHeightmap, tileBounds, tileOf } from '../src/terrain';

describe('tileOf', () => {
  it('locates downtown Sitka at z12', () => {
    expect(tileOf(57.0531, -135.3351, 12)).toEqual({ x: 508, y: 1253, z: 12 });
  });

  it('returns the only tile at z0', () => {
    expect(tileOf(0, 0, 0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(tileOf(45, 90, 0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(tileOf(-45, -90, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('clamps to the tile pyramid at the antimeridian and poles', () => {
    // lng 180 is the last column and -180 the first; beyond them it clamps.
    expect(tileOf(0, 180, 4).x).toBe(15);
    expect(tileOf(0, -180, 4).x).toBe(0);
    expect(tileOf(0, 200, 4).x).toBe(15);
    // Latitudes past ±90 collapse onto the first or last row.
    expect(tileOf(89.9, 0, 4).y).toBe(0);
    expect(tileOf(-89.9, 0, 4).y).toBe(15);
    // Even absurd inputs stay inside [0, 2^z - 1].
    for (const z of [0, 4, 8, 12]) {
      const n = 2 ** z;
      for (const lat of [-89.9, 0, 89.9]) {
        for (const lng of [-200, -180, 180, 200]) {
          const t = tileOf(lat, lng, z);
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x).toBeLessThanOrEqual(n - 1);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y).toBeLessThanOrEqual(n - 1);
          expect(t.z).toBe(z);
        }
      }
    }
  });
});

describe('tileBounds', () => {
  it('contains the point that found it', () => {
    for (const [lat, lng, z] of [
      [47.3769, 8.5417, 14],
      [-33.86, 151.21, 12],
      [57.0531, -135.3351, 12],
      [40.7128, -74.006, 12],
      [-22.95, -43.21, 10],
      [0, 0, 0],
    ] as const) {
      const t = tileOf(lat, lng, z);
      const b = tileBounds(t.z, t.x, t.y);
      expect(b.west).toBeLessThanOrEqual(lng);
      expect(b.east).toBeGreaterThanOrEqual(lng);
      expect(b.south).toBeLessThanOrEqual(lat);
      expect(b.north).toBeGreaterThanOrEqual(lat);
      expect(b.west).toBeGreaterThanOrEqual(-180);
      expect(b.east).toBeLessThanOrEqual(180);
      expect(b.south).toBeGreaterThanOrEqual(-90);
      expect(b.north).toBeLessThanOrEqual(90);
    }
  });

  it('shares edges exactly with neighbouring tiles', () => {
    for (const z of [2, 4, 8, 12]) {
      const n = 2 ** z;
      const xs = [0, Math.floor(n / 2), n - 2];
      for (const x of xs) {
        for (const y of xs) {
          const a = tileBounds(z, x, y);
          const e = tileBounds(z, x + 1, y);
          expect(e.west).toBeCloseTo(a.east, 12);
          const s = tileBounds(z, x, y + 1);
          expect(s.north).toBeCloseTo(a.south, 12);
        }
      }
    }
  });

  it('round-trips through tileOf at the centre', () => {
    for (const z of [0, 2, 4, 6, 8, 12]) {
      const n = 2 ** z;
      const xs = [...new Set([0, 1, Math.floor(n / 2), n - 1].filter((v) => v < n))];
      for (const x of xs) {
        for (const y of xs) {
          const b = tileBounds(z, x, y);
          const lng = (b.west + b.east) / 2;
          const lat = (b.north + b.south) / 2;
          expect(tileOf(lat, lng, z)).toEqual({ x, y, z });
        }
      }
    }
  });
});

describe('sampleHeightmap', () => {
  it('returns the constant of a flat heightmap, including at u=0 and u=1', () => {
    const hm = new Float32Array(256 * 256).fill(42.5);
    for (const [u, v] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [0.5, 0.5],
    ] as const) {
      expect(sampleHeightmap(hm, u, v)).toBe(42.5);
    }
  });

  it('reads the column index along u', () => {
    const hm = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) hm[y * 256 + x] = x;
    }
    expect(sampleHeightmap(hm, 0, 0.5)).toBeCloseTo(0, 12);
    expect(sampleHeightmap(hm, 0.5, 0.5)).toBeCloseTo(127.5, 12);
    expect(sampleHeightmap(hm, 1, 0.5)).toBeCloseTo(255, 12);
  });

  it('reads the row index along v', () => {
    const hm = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) hm[y * 256 + x] = y;
    }
    expect(sampleHeightmap(hm, 0.5, 0)).toBeCloseTo(0, 12);
    expect(sampleHeightmap(hm, 0.5, 0.5)).toBeCloseTo(127.5, 12);
    expect(sampleHeightmap(hm, 0.5, 1)).toBeCloseTo(255, 12);
  });
});
