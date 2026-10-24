/** Where to start, from `?at=lat,lng` (or `?lat=&lng=`). */
export type Start =
  | { lat: number; lng: number }
  | { demo: true }
  | { session: string }
  | { capsule: string; key: string | null }
  | { place: string }
  | null;

/**
 * A pinned start hour for the day cycle, from `?t=` in hours (0–24, fractions
 * welcome: `?t=21.5` is half past nine in the evening). Null when absent or
 * malformed — the day then starts at its default mid-morning hour.
 */
export function parseTime(search: string): number | null {
  const t = new URLSearchParams(search).get('t');
  if (t === null) return null;
  const h = Number(t);
  if (!Number.isFinite(h)) return null;
  return ((h % 24) + 24) % 24;
}

export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  return parseDMS(text);
}

const DMS_RE =
  /^\s*(\d{1,3})°\s*(\d{1,2}(?:\.\d+)?)\s*[′']\s*(?:(\d{1,2}(?:\.\d+)?)\s*[″"])?\s*([NS])\s*[,\s]\s*(\d{1,3})°\s*(\d{1,2}(?:\.\d+)?)\s*[′']\s*(?:(\d{1,2}(?:\.\d+)?)\s*[″"])?\s*([EW])\s*$/i;

/**
 * Coordinates as the game itself writes them (formatDMS in core):
 * `57°03′11″N, 135°20′06″W`. The address box displays a place this way, so
 * it must read its own handwriting back — "Walk here" on the displayed
 * label is a walk, not a place-name search for the server to fail on.
 * ASCII quotes work too, for keyboards that cannot type ′ and ″.
 */
export function parseDMS(text: string): { lat: number; lng: number } | null {
  const m = DMS_RE.exec(text);
  if (!m) return null;
  const toDeg = (d: string, min: string, s: string | undefined, hemi: string) => {
    const v = Number(d) + Number(min) / 60 + (s ? Number(s) / 3600 : 0);
    return /[SW]/i.test(hemi) ? -v : v;
  };
  const lat = toDeg(m[1]!, m[2]!, m[3], m[4]!);
  const lng = toDeg(m[5]!, m[6]!, m[7], m[8]!);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Where a visit without a place starts: downtown Sitka, Alaska (Lincoln Street, by St. Michael's Cathedral). */
export const DEFAULT_PLACE = { lat: 57.0531, lng: -135.3351 } as const;

export function parseStart(search: string): Start {
  const p = new URLSearchParams(search);
  if (p.get('demo') === 'generators') return { demo: true };
  const c = p.get('c');
  if (c && /^pc_[a-z2-9]{10}$/.test(c)) return { capsule: c, key: p.get('k') };
  const s = p.get('s')?.trim().toUpperCase();
  if (s && /^[A-HJ-NP-Z2-9]{6}$/.test(s)) return { session: s };
  // A baked place: a snapshot shipped with the client (public/places/<name>.json),
  // so a build with no server — the GitHub Pages build — can open on a real town.
  const place = p.get('place');
  if (place && /^[a-z0-9][a-z0-9-]{0,39}$/.test(place)) return { place };
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
