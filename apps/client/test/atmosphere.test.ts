import { describe, expect, it } from 'vitest';
import { cloudOf } from '../src/atmosphere';
import { skyPalette } from '../src/sky';

/**
 * The haze inversion's round trip (#87): `cloudOf` recovers the cloud a
 * palette was built from, because it is sky.ts's own haze formula
 * (`hazeScale = 0.75 + 0.6 * cloud`) walked backwards. The test exists so
 * the two ends of that calculation cannot drift apart quietly — if either
 * formula moves, this fails until the other moves with it.
 */
describe('cloudOf (the haze inversion)', () => {
  it('recovers the cloud the palette was built from', () => {
    for (const cloud of [0, 0.13, 0.5, 0.77, 1]) {
      expect(cloudOf(skyPalette(30, cloud))).toBeCloseTo(cloud, 12);
      expect(cloudOf(skyPalette(-10, cloud))).toBeCloseTo(cloud, 12); // night too
    }
  });

  it('clamps a hazeScale from outside the palette range into 0..1', () => {
    expect(cloudOf({ hazeScale: 0 } as never)).toBe(0);
    expect(cloudOf({ hazeScale: 9 } as never)).toBe(1);
  });
});
