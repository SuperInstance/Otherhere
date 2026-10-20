import { cellToParent } from 'h3-js';
import {
  cellAt,
  cellRing,
  INTERPRETER_VERSION,
  isCell,
  isTown,
  townOf,
  TOWN_RES,
  type OverpassResponse,
} from '@otherhere/core';
import type { Env } from './env';
import { bundleKey } from './town';
import { sessionRoutes } from './sessions';
import { capsuleRoutes } from './capsules';
import { intelligenceRoutes } from './intelligence';
import { agentRoutes } from './agents';
import { geocodeRoute } from './geocode';
import { tileRoute } from './tiles';

export { TownDO } from './town';
export { SessionDO } from './session';
export { OpsDO } from './ops';
export { JobsDO } from './jobs';

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...init.headers },
  });
const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  json({ error: message }, { status, headers });

const townFor = (env: Env, cell: string) => env.TOWN.get(env.TOWN.idFromName(townOf(cell)));

/** Which limiter, if any, guards a request. Token-gated owner and Plugin routes are not limited. */
function limiterFor(req: Request, env: Env, path: string) {
  if (path === '/api/geocode') return env.GEOCODE_LIMIT;
  if (path.startsWith('/api/tiles/')) return env.TILE_LIMIT;
  if (req.method !== 'POST') return undefined;
  if (/^\/api\/features\/[^/]+\/observe$/.test(path)) return env.PHOTO_LIMIT;
  if (/^\/api\/(sessions|capsules|judge\/taste)\b/.test(path)) return env.WRITE_LIMIT;
  return undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

    const limiter = limiterFor(req, env, path);
    if (limiter) {
      const key = req.headers.get('cf-connecting-ip') ?? 'unknown';
      if (!(await limiter.limit({ key })).success)
        return error(429, 'Too many requests. Wait a minute and try again.', {
          'retry-after': '60',
        });
    }
    try {
      return await route(req, env, url, path);
    } catch (err) {
      // One structured line per failure (Workers Logs), and an ID the user can quote.
      const id = crypto.randomUUID();
      console.error(
        JSON.stringify({
          level: 'error',
          id,
          method: req.method,
          path,
          error: String((err as Error)?.stack ?? err).slice(0, 2000),
        }),
      );
      return error(500, `Something went wrong on our side (reference ${id}). Try again shortly.`);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL, path: string): Promise<Response> {
  // Local development only (set by `pnpm dev`): load a recorded Overpass response
  // for an ingest block, so the app works offline or when Overpass is down.
  const dev = /^\/api\/dev\/blocks\/([0-9a-f]{15})$/.exec(path);
  if (dev && req.method === 'POST' && env.ALLOW_DEV_ROUTES === 'true') {
    const block = dev[1]!;
    const town = env.TOWN.get(env.TOWN.idFromName(cellToParent(block, TOWN_RES)));
    const count = await town.ingestOverpass(block, (await req.json()) as OverpassResponse);
    return json({ block, features: count });
  }

  const session = await sessionRoutes(req, env, path);
  if (session) return session;
  const capsule = await capsuleRoutes(req, env, path);
  if (capsule) return capsule;
  const agent = await agentRoutes(req, env, path);
  if (agent) return agent;
  const intelligence = await intelligenceRoutes(req, env, path);
  if (intelligence) return intelligence;

  if (req.method !== 'GET') return error(405, 'method not allowed');

  if (path === '/api/geocode') return geocodeRoute(req, env, url);
  if (path.startsWith('/api/tiles/')) {
    const tile = await tileRoute(path, env);
    if (tile) return tile;
  }

  if (path === '/api/health') return json({ ok: true, interpreter: INTERPRETER_VERSION });

  if (path === '/api/locate') {
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return error(400, 'lat and lng must be numbers');
    }
    const cell = cellAt(lat, lng);
    return json({ cell, town: townOf(cell), ring: cellRing(cell, 1) });
  }

  let m = /^\/api\/cells\/([^/]+)(\/facts|\/quests)?$/.exec(path);
  if (m) {
    const cell = m[1]!;
    if (!isCell(cell)) return error(400, 'not an H3 res-9 Cell');
    const town = townFor(env, cell);
    if (m[2] === '/facts') return json(await town.cellFacts(cell));
    if (m[2] === '/quests') return json({ cell, quests: await town.quests(cell) });
    const bundle = await town.bundleFor(cell);
    return json({ cell, town: townOf(cell), ...bundle });
  }

  m = /^\/api\/bundles\/([0-9a-f]{64})\.glb$/.exec(path);
  if (m) {
    const obj = await env.BUNDLES.get(bundleKey(m[1]!));
    if (!obj) return error(404, 'no such bundle');
    return new Response(obj.body, {
      encodeBody: 'manual',
      headers: {
        'content-type': 'model/gltf-binary',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${m[1]}"`,
        'x-output-hash': obj.customMetadata?.outputHash ?? '',
      },
    });
  }

  // The Town's place vector (ADR-0018): public-safe derived statistics of public
  // Facts — Town metadata like the Essence, never a Bundle input and never user data.
  m = /^\/api\/towns\/([^/]+)\/vector$/.exec(path);
  if (m) {
    const town = m[1]!;
    if (!isTown(town)) return error(400, 'not an H3 res-6 Town');
    const vector = await env.TOWN.get(env.TOWN.idFromName(town)).essenceVector();
    if (!vector) return error(503, 'place vectors are not configured on this deployment');
    return json({
      town,
      battery: vector.battery,
      model_served: vector.served,
      state_sha: vector.stateSha,
      at: vector.at,
      vector: vector.vector,
    });
  }

  return error(404, 'not found');
}
