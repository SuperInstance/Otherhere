import { describe, expect, it } from 'vitest';
import {
  clockHour,
  cloudCover,
  formatHour,
  moonDirection,
  skyPalette,
  sunDirection,
  sunPosition,
  DAY_OF_YEAR,
} from '../src/sky';

const closeTo = (a: number, b: number, tol = 0.75) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('sunPosition', () => {
  it('puts the noon sun due south at the expected height (equinox)', () => {
    // Equinox (~day 80): declination ≈ 0, so noon elevation = 90° − latitude.
    const p = sunPosition(47.3769, 80, 12);
    closeTo(p.elevation, 90 - 47.3769, 0.6);
    closeTo(p.azimuth, 180, 0.6);
  });
  it('raises the solstice noon sun by the declination (Sitka, day 172)', () => {
    const p = sunPosition(57.0531, DAY_OF_YEAR, 12);
    closeTo(p.elevation, 90 - 57.0531 + 23.44, 0.6);
    closeTo(p.azimuth, 180, 0.6);
  });
  it('puts the midnight sun below the horizon, north at northern summer', () => {
    const p = sunPosition(57.0531, DAY_OF_YEAR, 0);
    expect(p.elevation).toBeLessThan(0);
    closeTo(p.azimuth, 0, 1.5);
  });
  it('moves the sun east → south → west across the day', () => {
    const morning = sunPosition(47.3769, 80, 8);
    const evening = sunPosition(47.3769, 80, 16);
    expect(morning.azimuth).toBeLessThan(180); // before noon: in the east
    expect(evening.azimuth).toBeGreaterThan(180); // after noon: in the west
    expect(morning.elevation).toBeGreaterThan(0);
  });
});

describe('sunDirection', () => {
  it('is a unit vector in the walk frame (x east, y up, z south)', () => {
    const d = sunDirection(57.0531, DAY_OF_YEAR, 12);
    closeTo(Math.hypot(...d), 1, 1e-9);
    // The noon sun is due south and up.
    expect(d[0]).toBeCloseTo(0, 2);
    expect(d[1]).toBeGreaterThan(0.5);
    expect(d[2]).toBeGreaterThan(0.5);
  });
  it('mirrors east/west around solar noon', () => {
    const am = sunDirection(47.3769, 80, 9);
    const pm = sunDirection(47.3769, 80, 15);
    closeTo(am[0], -pm[0], 1e-6);
    closeTo(am[1], pm[1], 1e-6);
    closeTo(am[2], pm[2], 1e-6);
  });
});

describe('moonDirection', () => {
  it('is a unit vector on the other side of the sky, never below 7°', () => {
    for (const hour of [0, 6, 12, 18, 23]) {
      const sun = sunDirection(57.0531, DAY_OF_YEAR, hour);
      const moon = moonDirection(sun);
      closeTo(Math.hypot(...moon), 1, 1e-9);
      expect(moon[1]).toBeGreaterThanOrEqual(Math.sin((7 * Math.PI) / 180) - 1e-9);
      expect(moon[0] * sun[0] + moon[2] * sun[2]).toBeLessThan(0); // opposite azimuth
    }
  });
});

describe('clockHour', () => {
  it('starts where the visit opens and advances one hour per minute', () => {
    expect(clockHour(9.5, 0)).toBe(9.5);
    expect(clockHour(9.5, 60)).toBe(10.5);
    expect(clockHour(9.5, 24 * 60)).toBe(9.5); // a full day brings the hour back
  });
  it('wraps through midnight', () => {
    expect(clockHour(23.5, 3 * 60)).toBe(2.5);
    expect(clockHour(0.25, -60)).toBe(23.25);
  });
});

describe('cloudCover', () => {
  it('is a pure function of elapsed time and stays in bounds', () => {
    const a = cloudCover(1234.5, 'temperate');
    expect(cloudCover(1234.5, 'temperate')).toBe(a);
    for (let t = 0; t < 600; t += 7) {
      const c = cloudCover(t, 'pacific-rainforest');
      expect(c).toBeGreaterThanOrEqual(0.45);
      expect(c).toBeLessThanOrEqual(0.95);
    }
  });
  it('gives the rainforest heavier skies than the temperate biome, always', () => {
    for (let t = 0; t < 900; t += 13)
      expect(cloudCover(t, 'pacific-rainforest')).toBeGreaterThan(cloudCover(t, 'temperate'));
  });
  it('drifts smoothly: no weather jumps between neighbouring seconds', () => {
    for (let t = 0; t < 600; t += 5)
      expect(Math.abs(cloudCover(t + 1, 'temperate') - cloudCover(t, 'temperate'))).toBeLessThan(
        0.02,
      );
  });
});

describe('skyPalette', () => {
  it('keeps the old wet-Sitka look as the overcast midday case', () => {
    // The legacy constants: horizon #d9dcd6, zenith #8fb3c9.
    const p = skyPalette(45, 0.75);
    for (const [got, want] of [
      [p.horizon, [0xd9, 0xdc, 0xd6]],
      [p.zenith, [0x8f, 0xb3, 0xc9]],
    ] as const) {
      got.forEach((c, i) => expect(c).toBeGreaterThan((want[i]! / 255) * 0.8));
      got.forEach((c, i) => expect(c).toBeLessThan((want[i]! / 255) * 1.2));
    }
  });
  it('brightens with the sun and darkens at night', () => {
    const day = skyPalette(45, 0.3);
    const golden = skyPalette(3, 0.3);
    const night = skyPalette(-20, 0.3);
    expect(day.lightIntensity).toBeGreaterThan(golden.lightIntensity);
    expect(golden.lightIntensity).toBeGreaterThan(night.lightIntensity);
    expect(night.stars).toBeGreaterThan(0.8);
    expect(night.moon).toBeGreaterThan(0.5);
    expect(day.stars).toBe(0);
    // Golden hour warms the horizon; night cools everything down.
    expect(golden.horizon[0]).toBeGreaterThan(golden.horizon[2]); // red over blue
    expect(night.zenith[2]).toBeGreaterThan(night.zenith[0]); // blue over red
  });
  it('lets overcast swallow the discs, flatten the light and pool the mist', () => {
    const clear = skyPalette(45, 0.1);
    const grey = skyPalette(45, 0.95);
    expect(clear.sunGlow).toBeGreaterThan(0.9);
    expect(grey.sunGlow).toBeLessThan(0.05);
    expect(grey.lightIntensity).toBeLessThan(clear.lightIntensity * 0.55);
    expect(grey.hazeScale).toBeGreaterThan(clear.hazeScale);
    expect(grey.mist).toBeGreaterThan(clear.mist);
  });
  it('keeps an overcast night moonless and dark', () => {
    const starry = skyPalette(-20, 0.1);
    const cloudy = skyPalette(-20, 0.95);
    expect(starry.moon).toBeGreaterThan(0.5);
    expect(cloudy.moon).toBeLessThan(0.05);
    expect(cloudy.lightIntensity).toBeLessThan(starry.lightIntensity * 0.2);
  });
});

describe('formatHour', () => {
  it('reads like a clock', () => {
    expect(formatHour(9.5)).toBe('9:30 AM');
    expect(formatHour(0)).toBe('12:00 AM');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(13.75)).toBe('1:45 PM');
    expect(formatHour(23.99)).toBe('11:59 PM');
  });
});
