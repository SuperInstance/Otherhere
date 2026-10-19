import type { BBox } from '../geo/h3';

/** Public Overpass instances, tried in order (ADR-0010). */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

export const USER_AGENT = 'Otherhere/0.1 (+https://github.com/SuperInstance/otherhere)';

/** Buildings, roads, props, and landcover areas, for one bbox. */
export function overpassQuery(bb: BBox): string {
  const b = `(${bb.south},${bb.west},${bb.north},${bb.east})`;
  return [
    '[out:json][timeout:25];',
    '(',
    `  way["building"]${b};`,
    `  way["highway"]${b};`,
    `  node["natural"="tree"]${b};`,
    `  node["amenity"="bench"]${b};`,
    `  node["highway"="street_lamp"]${b};`,
    `  way["landuse"="forest"]${b};`,
    `  way["natural"="wood"]${b};`,
    `  way["natural"="scrub"]${b};`,
    `  way["landuse"="meadow"]${b};`,
    ');',
    'out body geom;',
  ].join('\n');
}

export type OverpassElement =
  | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
  | {
      type: 'way';
      id: number;
      nodes: number[];
      geometry: { lat: number; lon: number }[];
      tags?: Record<string, string>;
    }
  | { type: 'relation'; id: number; tags?: Record<string, string> };

export type OverpassResponse = { elements: OverpassElement[] };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** POST the query to each endpoint in turn until one answers with JSON. */
export async function fetchOverpass(
  query: string,
  opts: { fetch?: FetchLike; endpoints?: readonly string[]; timeoutMs?: number } = {},
): Promise<OverpassResponse> {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const errors: string[] = [];
  for (const url of opts.endpoints ?? OVERPASS_ENDPOINTS) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as OverpassResponse;
      if (!Array.isArray(json.elements)) {
        errors.push(`${url}: no elements`);
        continue;
      }
      return json;
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${errors.join('; ')}`);
}
