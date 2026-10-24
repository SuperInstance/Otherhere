import { describe, expect, it } from 'vitest';
import { formatDMS } from '../src/geo/format';

describe('formatDMS (Casey, 2026-10-24: coordinates are listed in degrees/minutes/seconds)', () => {
  it('formats the default place, downtown Sitka', () => {
    expect(formatDMS(57.0531, -135.3351)).toBe('57°03′11″N, 135°20′06″W');
  });

  it('formats Zurich with an eastern longitude', () => {
    expect(formatDMS(47.3769, 8.5417)).toBe('47°22′37″N, 8°32′30″E');
  });

  it('uses S for southern latitudes', () => {
    expect(formatDMS(-33.8568, 151.2153)).toBe('33°51′24″S, 151°12′55″E');
  });

  it('carries rounding overflow from seconds up to degrees', () => {
    expect(formatDMS(1.9999999, -0.0001)).toBe('2°00′00″N, 0°00′00″W');
  });

  it('formats the equator and the prime meridian', () => {
    expect(formatDMS(0, 0)).toBe('0°00′00″N, 0°00′00″E');
  });
});
