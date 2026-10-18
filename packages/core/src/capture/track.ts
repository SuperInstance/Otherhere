import { localFrame, type EN } from '../geo/frame';

export type TrackPoint = { t: number; lat: number; lng: number };
export type TrackPose = { lat: number; lng: number; heading: EN };

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(tag)?.[1];

/** Parse the track points of a GPX file (lat, lon, time). Times are required. */
export function parseGpx(xml: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const m of xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
    const lat = Number(attr(m[1]!, 'lat'));
    const lng = Number(attr(m[1]!, 'lon'));
    const time = /<time>([^<]+)<\/time>/.exec(m[2]!)?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const t = time ? Date.parse(time) : NaN;
    if (!Number.isFinite(t)) throw new Error('every track point needs a <time>');
    out.push({ t, lat, lng });
  }
  if (out.length < 2) throw new Error('a track needs at least two timed points');
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Where the walker was at time `t` (ms), and which way they were walking
 * (a unit vector east/north). Null outside the track.
 */
export function poseAt(track: readonly TrackPoint[], t: number): TrackPose | null {
  if (t < track[0]!.t || t > track[track.length - 1]!.t) return null;
  let i = 0;
  while (i < track.length - 2 && track[i + 1]!.t < t) i++;
  const a = track[i]!;
  const b = track[i + 1]!;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const lat = a.lat + (b.lat - a.lat) * k;
  const lng = a.lng + (b.lng - a.lng) * k;
  // Heading from this leg; if the walker stood still, borrow the next leg that moved.
  const frame = localFrame({ lat, lng });
  for (let j = i; j < track.length - 1; j++) {
    const p = frame.project(track[j]!);
    const q = frame.project(track[j + 1]!);
    const len = Math.sqrt((q.e - p.e) ** 2 + (q.n - p.n) ** 2);
    if (len > 0.5) return { lat, lng, heading: { e: (q.e - p.e) / len, n: (q.n - p.n) / len } };
  }
  return { lat, lng, heading: { e: 0, n: 1 } };
}

/** Times (s) to sample from a video of `durationS`: every `everyS`, centred, at most `max`. */
export function sampleTimes(durationS: number, everyS = 4, max = 30): number[] {
  const n = Math.max(1, Math.min(max, Math.floor(durationS / everyS)));
  const step = durationS / n;
  return Array.from({ length: n }, (_, i) => Math.round(step * (i + 0.5) * 1000) / 1000);
}
