import type { Env } from './env';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
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
