/** Where to start, from `?at=lat,lng` (or `?lat=&lng=`). */
export type Start = { lat: number; lng: number } | { demo: true } | { session: string } | null;

export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function parseStart(search: string): Start {
  const p = new URLSearchParams(search);
  if (p.get('demo') === 'generators') return { demo: true };
  const s = p.get('s')?.trim().toUpperCase();
  if (s && /^[A-HJ-NP-Z2-9]{6}$/.test(s)) return { session: s };
  const at = p.get('at');
  if (at) return parseCoords(at);
  if (p.has('lat') && p.has('lng')) return parseCoords(`${p.get('lat')},${p.get('lng')}`);
  return null;
}

/** The camera pose lives in the hash so a reload returns to exactly the same view. */
export type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

export function parsePose(hash: string): Pose | null {
  const parts = hash.replace(/^#/, '').split(',').map(Number);
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, z, yaw, pitch] = parts as [number, number, number, number, number];
  return { x, y, z, yaw, pitch };
}

export function formatPose(p: Pose): string {
  const r = (n: number, d: number) => Number(n.toFixed(d));
  return `#${r(p.x, 2)},${r(p.y, 2)},${r(p.z, 2)},${r(p.yaw, 4)},${r(p.pitch, 4)}`;
}
