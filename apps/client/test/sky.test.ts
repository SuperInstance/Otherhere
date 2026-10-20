import { describe, expect, it } from 'vitest';
import {
  clockHour,
  cloudCover,
  formatHour,
  moonDirection,
  skyPalette,
  skyStep,
  sunDirection,
  sunPosition,
  timeLine,
  DAY_OF_YEAR,
  FAST_FORWARD,
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
  it('is a pure function of the hour and stays in bounds', () => {
    const a = cloudCover(15.25, 'temperate');
    expect(cloudCover(15.25, 'temperate')).toBe(a);
    for (let h = 0; h < 24; h += 0.25) {
      const rain = cloudCover(h, 'pacific-rainforest');
      expect(rain).toBeGreaterThanOrEqual(0.45);
      expect(rain).toBeLessThanOrEqual(0.95);
      const temp = cloudCover(h, 'temperate');
      expect(temp).toBeGreaterThanOrEqual(0.12);
      expect(temp).toBeLessThanOrEqual(0.62);
    }
  });
  it('gives the rainforest heavier skies than the temperate biome, always', () => {
    for (let h = 0; h < 24; h += 0.25)
      expect(cloudCover(h, 'pacific-rainforest')).toBeGreaterThan(cloudCover(h, 'temperate'));
  });
  it('drifts smoothly: no weather jumps between neighbouring seconds', () => {
    // One real second is 1/60 of a day-clock hour on a living day.
    for (let h = 0; h < 24; h += 0.1)
      expect(
        Math.abs(cloudCover(h + 1 / 60, 'temperate') - cloudCover(h, 'temperate')),
      ).toBeLessThan(0.02);
  });
  it('belongs to the hour, so a postcard pins the weather with the hour it pins', () => {
    // A saver on the living clock and the friend who opens the link stand at
    // the same hour, whatever route their clocks took to it.
    const saverAtDusk = cloudCover(19.9, 'temperate');
    const friendOpeningT19_90 = cloudCover(19.9, 'temperate');
    expect(friendOpeningT19_90).toBe(saverAtDusk);
    // The old bug: the friend's clock started at elapsed 0, so every postcard
    // re-rolled the weather to cloudCover-of-elapsed-0 whatever the saver saw.
    const openedAtHourZero = cloudCover(0, 'temperate');
    const someOvercastSaveHour = 17; // whatever the saver's weather was here,
    expect(cloudCover(someOvercastSaveHour, 'temperate')).not.toBe(openedAtHourZero);
  });
  it('is periodic: the day has no weather seam at midnight', () => {
    expect(cloudCover(24, 'temperate')).toBe(cloudCover(0, 'temperate'));
    expect(cloudCover(47.5, 'temperate')).toBeCloseTo(cloudCover(23.5, 'temperate'), 10);
    for (let h = 23.75; h < 24; h += 0.05)
      expect(Math.abs(cloudCover(h + 0.05, 'temperate') - cloudCover(h, 'temperate'))).toBeLessThan(
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

describe('timeLine', () => {
  it('invites the player to pass time on a living day', () => {
    expect(timeLine(9.5, 0.24, false)).toBe('9:30 AM · clear · hold T to pass time');
    expect(timeLine(19.75, 0.7, false)).toBe('7:45 PM · broken overcast · hold T to pass time');
  });
  it('never invites the dead key in a pinned or postcard view', () => {
    const frozen = timeLine(21.5, 0.9, true);
    expect(frozen).toBe('9:30 PM · overcast · the hour is pinned here');
    expect(frozen).not.toContain('hold T');
  });
});

describe('skyStep', () => {
  it('keeps a fast renderer at true speed, held key or not', () => {
    expect(skyStep(1 / 60, false, false)).toBeCloseTo(1 / 60, 9);
    expect(skyStep(1 / 60, true, false)).toBeCloseTo(FAST_FORWARD / 60, 9);
  });
  it('keeps the day at true speed on a slow renderer (a 2 s frame is not 0.25 s)', () => {
    // The walk physics clamps such a frame to 0.25 s; the day must not.
    expect(skyStep(2, false, false)).toBe(2);
    expect(skyStep(1, true, false)).toBe(FAST_FORWARD);
  });
  it('bounds a stall, ignores time running backwards, and never moves a frozen view', () => {
    expect(skyStep(30, false, false)).toBe(2); // a backgrounded tab does not jump the clock
    expect(skyStep(-5, true, false)).toBe(0);
    expect(skyStep(30, true, true)).toBe(0); // the postcard's hour is part of the postcard
  });
});
