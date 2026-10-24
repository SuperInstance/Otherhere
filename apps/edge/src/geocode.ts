import type { Env } from './env';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'Otherhere/0.1 (+https://otherhere.superinstance.dev)';
const CACHE_SECONDS = 7 * 24 * 3600;

export type Place = { lat: number; lng: number; label: string };

/**
 * GET /api/geocode?q=<address or place name> → the best match from OpenStreetMap's
 * Nominatim (never Google: invariant 8). Results are cached at the edge for a week, and
 * the route is rate-limited per client, as Nominatim's usage policy asks.
 */
export async function geocodeRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if (!q || q.length > 200) return json({ error: 'Type an address or a place name.' }, 400);

  const cacheKey = new Request(`https://geocode.otherhere/${encodeURIComponent(q.toLowerCase())}`);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const hit = await cache?.match(cacheKey);
  if (hit) return hit;

  let found: { lat: string; lon: string; display_name: string }[];
  try {
    const res = await fetch(
      `${env.NOMINATIM_URL ?? NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
      {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en' },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = (await res.json()) as typeof found;
  } catch {
    return json({ error: 'Could not look that up right now. Try again, or use coordinates.' }, 502);
  }
  const top = found[0];
  if (!top)
    return json({ error: `No place found for “${q}”. Check the spelling or add the town.` }, 404);
  const place: Place = { lat: Number(top.lat), lng: Number(top.lon), label: top.display_name };
  const res = json(place, 200, { 'cache-control': `public, max-age=${CACHE_SECONDS}` });
  await cache?.put(cacheKey, res.clone());
  return res;
}

type ReverseFound = {
  name?: string;
  display_name?: string;
  error?: string;
  address?: Record<string, string>;
};

/**
 * The short human label for a reverse result: a named place beats a street,
 * a street beats the raw display name. The settlement rides along so two
 * same-named streets in different towns stay tellable apart.
 */
function reverseLabel(found: ReverseFound): string | null {
  if (found.error) return null;
  const a = found.address ?? {};
  const settlement = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.county ?? '';
  const road = a.road ? (a.house_number ? `${a.house_number} ${a.road}` : a.road) : '';
  const name = (found.name ?? '').trim();
  let main = '';
  if (name && name !== a.road) main = name;
  else if (road) main = road;
  if (main) return settlement && !main.includes(settlement) ? `${main}, ${settlement}` : main;
  if (found.display_name)
    return (
      found.display_name
        .split(',')
        .slice(0, 3)
        .map((s) => s.trim())
        .join(', ') || null
    );
  return null;
}

/**
 * GET /api/reverse?lat=<lat>&lng=<lng> → the nearest address or place, from
 * Nominatim's reverse lookup (never Google: invariant 8). A place is listed
 * by name first (Casey, 2026-10-24): the client asks here whenever it arrives
 * somewhere by coordinates, and only falls back to coordinates — in
 * degrees/minutes/seconds — when this route answers 404 (nothing near).
 * Cached at the edge for a week, keyed on coordinates rounded to 1e-5°,
 * and rate-limited per client alongside /api/geocode.
 */
export async function reverseRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return json({ error: 'lat and lng must be numbers.' }, 400);

  const cacheKey = new Request(
    `https://reverse.otherhere/${encodeURIComponent(`${lat.toFixed(5)},${lng.toFixed(5)}`)}`,
  );
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const hit = await cache?.match(cacheKey);
  if (hit) return hit;

  const base = env.NOMINATIM_URL ? env.NOMINATIM_URL.replace(/\/search$/, '') : null;
  const endpoint = base ? `${base}/reverse` : NOMINATIM_REVERSE;
  let found: ReverseFound;
  try {
    const res = await fetch(
      `${endpoint}?format=jsonv2&zoom=18&addressdetails=1&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`,
      {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en' },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = (await res.json()) as ReverseFound;
  } catch {
    return json({ error: 'Could not look that up right now.' }, 502);
  }
  const label = reverseLabel(found);
  if (!label) return json({ error: 'No address or place near those coordinates.' }, 404);
  const res = json({ label }, 200, { 'cache-control': `public, max-age=${CACHE_SECONDS}` });
  await cache?.put(cacheKey, res.clone());
  return res;
}
