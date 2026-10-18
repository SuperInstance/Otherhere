import { describe, expect, it } from 'vitest';
import { parseGpx, poseAt, sampleTimes, type TrackPoint } from '../src/capture/track';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test"><trk><trkseg>
  <trkpt lat="47.37700" lon="8.54000"><ele>410</ele><time>2026-10-18T09:00:00Z</time></trkpt>
  <trkpt lat='47.37700' lon='8.54100'><time>2026-10-18T09:00:10Z</time></trkpt>
  <trkpt lon="8.54100" lat="47.37800"><time>2026-10-18T09:00:30.500Z</time></trkpt>
</trkseg></trk></gpx>`;

describe('parseGpx', () => {
  it('reads track points with times, in any attribute order', () => {
    const t = parseGpx(GPX);
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ t: Date.parse('2026-10-18T09:00:00Z'), lat: 47.377, lng: 8.54 });
    expect(t[2]!.lat).toBe(47.378);
  });
  it('rejects tracks without times or with fewer than two points', () => {
    expect(() =>
      parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkpt></trkseg></trk></gpx>'),
    ).toThrow(/time/);
    expect(() => parseGpx('<gpx></gpx>')).toThrow(/two/);
  });
});

describe('poseAt', () => {
  const track: TrackPoint[] = parseGpx(GPX);
  const t0 = track[0]!.t;

  it('interpolates position between points', () => {
    const p = poseAt(track, t0 + 5000)!;
    expect(p.lat).toBeCloseTo(47.377, 9);
    expect(p.lng).toBeCloseTo(8.5405, 9);
  });

  it('heads along the track: east on the first leg, north on the second', () => {
    const east = poseAt(track, t0 + 5000)!.heading;
    expect(east.e).toBeCloseTo(1, 6);
    expect(east.n).toBeCloseTo(0, 6);
    const north = poseAt(track, t0 + 20_000)!.heading;
    expect(north.n).toBeCloseTo(1, 6);
  });

  it('is null outside the track', () => {
    expect(poseAt(track, t0 - 1)).toBeNull();
    expect(poseAt(track, t0 + 60_000)).toBeNull();
  });
});

describe('sampleTimes', () => {
  it('spaces frames evenly and caps the count', () => {
    expect(sampleTimes(20, 4)).toEqual([2, 6, 10, 14, 18]);
    expect(sampleTimes(1000, 4, 10)).toHaveLength(10);
    expect(sampleTimes(0.5, 4)).toEqual([0.25]);
  });
});
