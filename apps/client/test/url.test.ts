import { describe, expect, it } from 'vitest';
import { formatPose, parseCoords, parsePose, parseStart } from '../src/url';

describe('parseCoords', () => {
  it('accepts "lat, lng" and "lat lng"', () => {
    expect(parseCoords('47.3769, 8.5417')).toEqual({ lat: 47.3769, lng: 8.5417 });
    expect(parseCoords('-33.86 151.21')).toEqual({ lat: -33.86, lng: 151.21 });
  });
  it('rejects out-of-range or garbage', () => {
    expect(parseCoords('91, 0')).toBeNull();
    expect(parseCoords('zurich')).toBeNull();
  });
});

describe('parseStart', () => {
  it('reads ?at=, ?lat&lng, and ?demo=generators', () => {
    expect(parseStart('?at=47.1,8.2')).toEqual({ lat: 47.1, lng: 8.2 });
    expect(parseStart('?lat=1&lng=2')).toEqual({ lat: 1, lng: 2 });
    expect(parseStart('?demo=generators')).toEqual({ demo: true });
    expect(parseStart('')).toBeNull();
  });
});

describe('pose round-trip', () => {
  it('formats and parses', () => {
    const p = { x: 1.234, y: 1.7, z: -9.87, yaw: 0.12345, pitch: -0.1 };
    expect(parsePose(formatPose(p))).toEqual({
      x: 1.23,
      y: 1.7,
      z: -9.87,
      yaw: 0.1235,
      pitch: -0.1,
    });
    expect(parsePose('#nope')).toBeNull();
  });
});
