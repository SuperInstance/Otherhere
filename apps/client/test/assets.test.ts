import { describe, expect, it } from 'vitest';
import type { AssetExtras } from '@otherhere/core';
import { assetsFor, chooseTier, SPLAT_NEAR_M } from '../src/assets';

const HASH = 'b'.repeat(64);
const extras: AssetExtras = {
  id: 'osm:w116029214',
  family: 'st-michaels-cathedral',
  version: '1.0.0',
  tiers: {
    splat: { path: 'assets/st-michaels-cathedral/1.0.0/splat.spz', hash: HASH, bytes: 193_512 },
    impostor: {
      path: 'assets/st-michaels-cathedral/1.0.0/card-512.webp',
      hash: HASH,
      bytes: 35_758,
    },
    card: { path: 'assets/st-michaels-cathedral/1.0.0/card-256.webp', hash: HASH, bytes: 13_874 },
  },
  position: [-68.171, 1.372, -37.418],
  quaternion: [0.965643, 0.013508, 0.258973, 0.016831],
  scale: 3,
  heightM: 14.592,
  frontAzimuthDeg: 190.7,
  cardQuad: { widthM: 32.5, heightM: 57.6, centreYM: 21.4 },
  // A 30 x 20 m ring in the Cell's local frame.
  ring: [-80, 40, -50, 40, -50, 60, -80, 60],
};

describe('assetsFor', () => {
  it('places the extras into the world frame around the Cell centre', () => {
    const [p] = assetsFor([extras], { e: 1000, n: 2000 });
    expect(p).toBeTruthy();
    // The splat's origin: cell centre plus the local position (z = -n).
    expect(p!.world.x).toBeCloseTo(1000 - 68.171);
    expect(p!.world.z).toBeCloseTo(-2000 - 37.418);
    // The ring lands in world (e, n) axes; its centre becomes (x, -n).
    expect(p!.ring[0]).toEqual({ e: 920, n: 2040 });
    expect(p!.centre).toEqual({ x: 935, z: -2050 });
    // The clearing covers the footprint plus a yard, and counts as built.
    expect(p!.clearing.x).toBe(935);
    expect(p!.clearing.z).toBe(-2050);
    expect(p!.clearing.r).toBeCloseTo(Math.hypot(30, 20) / 2 + 6);
    expect(p!.clearing.built).toBe(true);
    expect(p!.heightM).toBe(14.592);
    expect(p!.cardQuad?.widthM).toBe(32.5);
  });

  it('drops malformed entries and tolerates absence', () => {
    expect(assetsFor(undefined, { e: 0, n: 0 })).toEqual([]);
    expect(assetsFor([{ ...extras, ring: [1, 2, 3] }], { e: 0, n: 0 })).toEqual([]);
  });
});

describe('chooseTier', () => {
  const all = extras.tiers;
  it('full profile: the splat near, the big photograph far', () => {
    expect(chooseTier(false, SPLAT_NEAR_M - 1, all)).toBe('splat');
    expect(chooseTier(false, SPLAT_NEAR_M + 1, all)).toBe('impostor');
    expect(chooseTier(false, 10_000, all)).toBe('impostor');
  });
  it('lite profile: never the splat; the small photograph is its tier', () => {
    expect(chooseTier(true, 5, all)).toBe('card');
    expect(chooseTier(true, 10_000, all)).toBe('card');
    expect(chooseTier(true, 5, { impostor: all.impostor })).toBe('impostor');
    expect(chooseTier(true, 5, { splat: all.splat })).toBeNull();
  });
  it('falls down the ladder when a tier is missing', () => {
    expect(chooseTier(false, 5, { card: all.card })).toBe('card');
    expect(chooseTier(false, 5_000, { splat: all.splat })).toBe('splat');
    expect(chooseTier(false, 5, {})).toBeNull();
  });
  it('a real mesh outranks the photographs, and the splat outranks the mesh', () => {
    const model = { path: 'm.glb', hash: 'h', bytes: 1 };
    expect(chooseTier(false, 5, { model })).toBe('model');
    expect(chooseTier(false, 5_000, { model, ...all })).toBe('model');
    expect(chooseTier(false, SPLAT_NEAR_M - 1, { model, ...all })).toBe('splat');
    // The lite profile never fetches a mesh either: it is a photograph tier.
    expect(chooseTier(true, 5, { model })).toBeNull();
    expect(chooseTier(true, 5, { model, card: all.card })).toBe('card');
  });
});
