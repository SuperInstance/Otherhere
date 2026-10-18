import type { Env } from './env';

const ELEVATION = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Sentinel-2 cloudless 2016 by EOX: CC BY 4.0, unlike the later years (invariant 8: no Google).
const SATELLITE = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
const CACHE_SECONDS = 30 * 24 * 3600;
const MAX_ZOOM = 15;

const LAYERS = {
  elev: {
    ext: 'png',
    type: 'image/png',
    upstream: (env: Env) => env.ELEVATION_TILES_URL ?? ELEVATION,
  },
  sat: {
    ext: 'jpg',
    type: 'image/jpeg',
    upstream: (env: Env) => env.SATELLITE_TILES_URL ?? SATELLITE,
  },
} as const;

/**
 * GET /api/tiles/{elev|sat}/{z}/{x}/{y}.{png|jpg}: public map tiles, fetched through the
 * edge so the client's CSP stays same-origin, and cached there for a month (tiles of
 * these fixed datasets never change). Only whole, in-range tile addresses are accepted.
 */
export async function tileRoute(path: string, env: Env): Promise<Response | null> {
  const m = /^\/api\/tiles\/(elev|sat)\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.(png|jpg)$/.exec(path);
  if (!m) return null;
  const layer = LAYERS[m[1] as keyof typeof LAYERS];
  const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (m[5] !== layer.ext || z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z)
    return new Response('Not a tile', { status: 404 });

  const cacheKey = new Request(`https://tiles.otherhere/${m[1]}/${z}/${x}/${y}`);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const hit = await cache?.match(cacheKey);
  if (hit) return hit;

  const url = layer
    .upstream(env)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return new Response('Tile source unreachable', { status: 502 });
  }
  if (!upstream.ok) return new Response('No tile', { status: upstream.status === 404 ? 404 : 502 });
  const res = new Response(upstream.body, {
    headers: {
      'content-type': layer.type,
      'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
    },
  });
  await cache?.put(cacheKey, res.clone());
  return res;
}
