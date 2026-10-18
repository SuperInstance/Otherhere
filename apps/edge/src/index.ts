import { cellToParent } from 'h3-js';
import {
  cellAt,
  cellRing,
  INTERPRETER_VERSION,
  isCell,
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

export { TownDO } from './town';
export { SessionDO } from './session';
export { OpsDO } from './ops';
export { JobsDO } from './jobs';

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { ...init, headers: { 'cache-control': 'no-store', ...init.headers } });
const error = (status: number, message: string) => json({ error: message }, { status });

const townFor = (env: Env, cell: string) => env.TOWN.get(env.TOWN.idFromName(townOf(cell)));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

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

    let m = /^\/api\/cells\/([^/]+)(\/facts)?$/.exec(path);
    if (m) {
      const cell = m[1]!;
      if (!isCell(cell)) return error(400, 'not an H3 res-9 Cell');
      const town = townFor(env, cell);
      if (m[2]) return json(await town.cellFacts(cell));
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

    return error(404, 'not found');
  },
} satisfies ExportedHandler<Env>;
