import {
  generatorSet,
  isCell,
  makePlaceCapsule,
  Scope,
  sha256Hex,
  townOf,
  type Essence,
  type Fact,
  type Feature,
} from '@otherhere/core';
import type { Env } from './env';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const MAX_CELLS = 19; // a Cell plus two rings

function token(bytes: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (b) => alphabet[b % alphabet.length],
  ).join('');
}

/**
 * /api/capsules: save a place postcard (a Fact snapshot) and read it back.
 * There are no accounts yet (ADR-0009), so Scope is enforced by possession:
 * `private` needs the owner key returned at creation; `friends` needs the
 * unguessable link; `public` is the same link, marked shareable.
 */
export async function capsuleRoutes(
  req: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === '/api/capsules' && req.method === 'POST') {
    let body: {
      title?: unknown;
      scope?: unknown;
      cells?: unknown;
      center?: { lat?: unknown; lng?: unknown };
      pose?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }
    const scope = Scope.safeParse(body.scope);
    const cells = Array.isArray(body.cells) ? [...new Set(body.cells.map(String))] : [];
    const lat = Number(body.center?.lat);
    const lng = Number(body.center?.lng);
    if (!scope.success) return json({ error: 'scope must be private, friends, or public' }, 400);
    if (!cells.length || cells.length > MAX_CELLS || !cells.every(isCell)) {
      return json({ error: `cells must be 1–${MAX_CELLS} H3 res-9 Cells` }, 400);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return json({ error: 'center must be { lat, lng }' }, 400);
    const pose =
      Array.isArray(body.pose) && body.pose.length === 5 && body.pose.every(Number.isFinite)
        ? (body.pose as [number, number, number, number, number])
        : undefined;

    // Snapshot every Cell at once: Towns are independent Durable Objects, so a
    // slow one no longer serialises the save behind it. Promise.all keeps the
    // cells' order, so the capsule's feature/fact sequence is byte-identical
    // to the sequential loop it replaces.
    const snaps = await Promise.all(
      cells.map((cell) => {
        // RPC typing of recursive JSON values is too deep for tsc; the shape is TownDO.snapshot's.
        const town = env.TOWN.get(env.TOWN.idFromName(townOf(cell))) as unknown as {
          snapshot(cell: string): Promise<{ features: Feature[]; facts: Fact[]; essence: Essence }>;
        };
        return town.snapshot(cell);
      }),
    );
    const features: Feature[] = snaps.flatMap((s) => s.features);
    const facts: Fact[] = snaps.flatMap((s) => s.facts);
    const essences: Record<string, Essence> = {};
    cells.forEach((cell, i) => {
      essences[townOf(cell)] = snaps[i]!.essence;
    });

    const id = `pc_${token(10)}`;
    const ownerKey = token(24);
    let capsule;
    try {
      capsule = makePlaceCapsule({
        id,
        title: String(body.title ?? '').slice(0, 200) || 'Untitled place',
        scope: scope.data,
        createdAt: new Date().toISOString(),
        cells,
        center: { lat, lng },
        pose,
        features,
        facts,
        generators: await generatorSet().refs(),
        essences,
      });
    } catch (err) {
      return json({ error: `invalid capsule: ${(err as Error).message.slice(0, 300)}` }, 400);
    }
    await env.BUNDLES.put(`capsules/${id}.json`, JSON.stringify(capsule), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { scope: scope.data, ownerKeyHash: await sha256Hex(ownerKey) },
    });
    return json(
      { id, scope: scope.data, ownerKey, features: capsule.snapshot.features.length },
      201,
    );
  }

  const m = /^\/api\/capsules\/(pc_[a-z2-9]{10})$/.exec(path);
  if (!m) return path.startsWith('/api/capsules') ? json({ error: 'not found' }, 404) : null;
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  const obj = await env.BUNDLES.get(`capsules/${m[1]}.json`);
  if (!obj) return json({ error: 'no such postcard' }, 404);
  if (obj.customMetadata?.scope === 'private') {
    const key = new URL(req.url).searchParams.get('k') ?? '';
    // Without the owner key a private postcard looks exactly like a missing one.
    if (!key || (await sha256Hex(key)) !== obj.customMetadata.ownerKeyHash)
      return json({ error: 'no such postcard' }, 404);
  }
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control':
        obj.customMetadata?.scope === 'public' ? 'public, max-age=300' : 'private, no-store',
    },
  });
}
