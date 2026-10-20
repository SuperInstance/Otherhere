import { describe, expect, it } from 'vitest';
import {
  gustAt,
  swayOffset,
  windStrength,
  WIND_TOWARD,
  SWAY_MAX_M,
  GUST_LONG,
  GUST_SHORT,
} from '../src/wind';

/** Downwind metres `d` as a ground position along the wind axis. */
const alongWind = (d: number): [number, number] => [WIND_TOWARD[0]! * d, WIND_TOWARD[1]! * d];

describe('windStrength', () => {
  it('is exactly still air under overcast, full strength under clear sky', () => {
    for (let t = 0; t < 300; t += 3) {
      expect(windStrength(t, 0.9)).toBe(0); // a grey ceiling sits on the forest
      expect(windStrength(t, 0.78)).toBe(0);
      expect(windStrength(t, 0.15)).toBeGreaterThanOrEqual(0.55);
      expect(windStrength(t, 0.15)).toBeLessThanOrEqual(1);
    }
  });
  it('fades through broken sky, in the bands the status line names', () => {
    // describeWeather: <0.3 clear, 0.3–0.55 light cloud, 0.55–0.78 broken, ≥0.78 overcast.
    const light = windStrength(100, 0.4);
    const broken = windStrength(100, 0.65);
    expect(light).toBeGreaterThan(broken);
    expect(broken).toBeGreaterThan(0); // broken sky still stirs the crowns a little
    expect(windStrength(100, 0.75)).toBeLessThan(0.01);
  });
  it('breathes: even under a clear sky the wind comes and goes', () => {
    const over = new Set<number>();
    for (let t = 0; t < 240; t += 0.5) over.add(Math.round(windStrength(t, 0.15) * 100));
    expect(Math.max(...over) - Math.min(...over)).toBeGreaterThanOrEqual(20); // a visible range
  });
  it('is a pure function of elapsed time and weather (so ?t= freezes it)', () => {
    for (const [t, c] of [
      [0, 0.2],
      [123.4, 0.56],
      [5000, 0.9],
    ] as const) {
      expect(windStrength(t, c)).toBe(windStrength(t, c));
    }
  });
});

describe('gustAt', () => {
  it('stays within its envelope and drifts smoothly over time and ground', () => {
    for (let t = 0; t < 200; t += 2)
      for (const d of [0, 100, 333, -700]) {
        const [x, z] = alongWind(d);
        const g = gustAt(t, x, z);
        expect(g).toBeGreaterThanOrEqual(0.35);
        expect(g).toBeLessThanOrEqual(1);
        // One second of clock or five metres of ground moves the envelope a
        // little (its own periods are 9–14 s and 55–130 m), never a jump.
        expect(Math.abs(gustAt(t + 1, x, z) - g)).toBeLessThanOrEqual(0.2);
        expect(Math.abs(gustAt(t, x + 5, z) - g)).toBeLessThanOrEqual(0.12);
      }
  });
  it('travels downwind: the field a moment later best matches ground further downwind', () => {
    // Cross-correlate the mean-removed field along the wind axis between t and
    // t+6 s; the lag that matches best is the distance the crests covered.
    const t = 40;
    const dt = 6;
    const field = (time: number, d: number) => gustAt(time, ...alongWind(d)) - 0.675;
    const lags: [number, number][] = [];
    for (let lag = 0; lag <= 120; lag += 5) {
      let c = 0;
      for (let d = 0; d < 600; d += 5) c += field(t, d) * field(t + dt, d + lag);
      lags.push([lag, c]);
    }
    const best = lags.reduce((a, b) => (b[1] > a[1] ? b : a));
    // The two components run at GUST_SHORT.speed and GUST_LONG.speed: over 6 s
    // the crests move 36–54 m, so the best match must sit in that neighbourhood
    // (with slack for the shorter wave pulling it around).
    expect(best[0]).toBeGreaterThanOrEqual(GUST_SHORT.speed * dt - 12);
    expect(best[0]).toBeLessThanOrEqual(GUST_LONG.speed * dt + 12);
  });
});

describe('swayOffset', () => {
  it('is deterministic and bounded by the maximum tip travel', () => {
    for (let t = 0; t < 240; t += 1.7)
      for (const [x, z] of [
        [0, 0],
        [220, -140],
        [-900, 700],
      ] as const) {
        const a = swayOffset(t, 0.2, x, z, 1);
        expect(swayOffset(t, 0.2, x, z, 1)).toEqual(a);
        expect(Math.hypot(a[0], a[1])).toBeLessThanOrEqual(SWAY_MAX_M * 1.25);
      }
  });
  it('holds the crowns still under overcast, whatever the clock says', () => {
    for (let t = 0; t < 300; t += 3)
      for (const [x, z] of [
        [0, 0],
        [300, 250],
      ] as const) {
        const o = swayOffset(t, 0.95, x, z, 1);
        expect(Math.hypot(o[0], o[1])).toBeLessThanOrEqual(0.01);
      }
  });
  it('swings a clear-sky crown through a visible arc, not a twitch', () => {
    // A tip over 30 s: the downwind travel between the furthest swing forward
    // and back must be a good fraction of a metre, or the wind would read as noise.
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 30; t += 0.25) {
      const [ox, oz] = swayOffset(t, 0.15, 120, -80, 1);
      const downwind = ox * WIND_TOWARD[0]! + oz * WIND_TOWARD[1]!;
      lo = Math.min(lo, downwind);
      hi = Math.max(hi, downwind);
    }
    expect(hi - lo).toBeGreaterThanOrEqual(0.4);
  });
  it('plants the root and frees the crown: sway grows with flex', () => {
    const root = swayOffset(60, 0.2, 50, 50, 0);
    expect(Math.hypot(root[0], root[1])).toBe(0);
    const mid = Math.hypot(...swayOffset(60, 0.2, 50, 50, 0.5));
    const tip = Math.hypot(...swayOffset(60, 0.2, 50, 50, 1));
    expect(mid).toBeLessThan(tip);
  });
  it('never teleports: a tenth of a second moves a tip only a little', () => {
    for (let t = 0; t < 60; t += 0.9) {
      const a = swayOffset(t, 0.15, 40, -90, 1);
      const b = swayOffset(t + 0.1, 0.15, 40, -90, 1);
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(0.4);
    }
  });
});
