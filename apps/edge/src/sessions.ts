import { newSessionCode, SESSION_CODE } from '@otherhere/core';
import type { Env } from './env';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

type IceServer = { urls: string | string[]; username?: string; credential?: string };

const STUN: IceServer = { urls: ['stun:stun.cloudflare.com:3478'] };

/** /api/sessions routes. Returns null if the path is not a session route. */
export async function sessionRoutes(
  req: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === '/api/sessions' && req.method === 'POST') {
    let body: { lat?: unknown; lng?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'body must be JSON { lat, lng }' }, 400);
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return json({ error: 'lat and lng must be numbers' }, 400);
    }
    // Retry on the (unlikely) collision with an existing session.
    for (let i = 0; i < 4; i++) {
      const code = newSessionCode();
      try {
        await env.SESSION.get(env.SESSION.idFromName(code)).init({
          code,
          origin: { lat, lng },
          ruleset: 'rules.ctf@0.1.0',
          createdAt: new Date().toISOString(),
        });
        return json({ code }, 201);
      } catch (err) {
        if (!String((err as Error).message).includes('session exists')) throw err;
      }
    }
    return json({ error: 'could not allocate a session code' }, 503);
  }

  const m = /^\/api\/sessions\/([^/]+)(\/ws|\/ice)?$/.exec(path);
  if (!m) return null;
  const code = m[1]!.toUpperCase();
  if (!SESSION_CODE.test(code)) return json({ error: 'not a session code' }, 400);
  const stub = env.SESSION.get(env.SESSION.idFromName(code));

  if (m[2] === '/ws') return stub.fetch(req);
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (m[2] === '/ice') return json({ iceServers: await iceServers(env) });

  const info = await stub.getInfo();
  return info ? json(info) : json({ error: 'no such session' }, 404);
}

/** STUN always; Cloudflare Realtime TURN when the deployment has a TURN key. */
async function iceServers(env: Env): Promise<IceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [STUN];
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: 6 * 3600 }),
      },
    );
    if (!res.ok) return [STUN];
    const body = (await res.json()) as { iceServers: IceServer | IceServer[] };
    return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  } catch {
    return [STUN];
  }
}
