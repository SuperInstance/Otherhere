import {
  isCell,
  isTown,
  SOURCES,
  townOf,
  type Fact,
  type Feature,
  type Source,
} from '@otherhere/core';
import { observeBuilding } from '@otherhere/models';
import type { Env } from './env';
import { makeModels } from './models';
import { opsStub } from './ops';
import { driftRoute } from './drift';
import type { PlaceVectorCompute } from './town';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Base64 JPEG up to ~1.8 MB decoded: plenty for a phone photo resized client-side. */
const MAX_IMAGE_B64 = 2_500_000;

/** /api/features/:id/observe, /api/judge/taste, and owner-only /api/ops/* routes. */
export async function intelligenceRoutes(
  req: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const m = /^\/api\/features\/([^/]+)\/observe$/.exec(path);
  if (m && req.method === 'POST') return observe(req, env, decodeURIComponent(m[1]!));

  if (path === '/api/judge/taste' && req.method === 'POST') {
    try {
      await opsStub(env).recordJudgeEvent({ ...((await req.json()) as object), kind: 'taste' });
      return json({ ok: true }, 201);
    } catch {
      return json({ error: 'not a valid taste event' }, 400);
    }
  }

  if (path.startsWith('/api/ops/')) {
    // Owner-only. Without an OPS_TOKEN configured these routes do not exist.
    if (!env.OPS_TOKEN || req.headers.get('authorization') !== `Bearer ${env.OPS_TOKEN}`)
      return json({ error: 'not found' }, 404);
    // DELETE /api/ops/cells/:cell/features/:id/facts?source=capture — moderation.
    const mod = /^\/api\/ops\/cells\/([^/]+)\/features\/([^/]+)\/facts$/.exec(path);
    if (mod && req.method === 'DELETE') {
      const [cell, featureId] = [mod[1]!, decodeURIComponent(mod[2]!)];
      const source = new URL(req.url).searchParams.get('source') ?? '';
      if (!isCell(cell) || !SOURCES.includes(source as Source))
        return json({ error: 'needs an H3 res-9 cell and ?source=<one of the Fact sources>' }, 400);
      const town = env.TOWN.get(env.TOWN.idFromName(townOf(cell))) as unknown as {
        removeFacts(featureId: string, source: string): Promise<number>;
      };
      return json({ removed: await town.removeFacts(featureId, source) });
    }
    // RPC typing of recursive JSON is too deep for tsc; the shapes are OpsDO's.
    const ops = opsStub(env) as unknown as {
      recentDecisions(limit: number): Promise<unknown[]>;
      spendToday(day: string): Promise<Record<string, number>>;
    };
    if (path === '/api/ops/decisions')
      return json(
        await ops.recentDecisions(Number(new URL(req.url).searchParams.get('limit') ?? 50)),
      );
    if (path === '/api/ops/spend')
      return json(await ops.spendToday(new Date().toISOString().slice(0, 10)));
    // GET /api/ops/drift — the canary's readings (see drift.ts). Never spends.
    if (path === '/api/ops/drift')
      return driftRoute(env, Number(new URL(req.url).searchParams.get('limit') ?? 48));

    // POST /api/ops/towns/:town/vector — compute (or refresh) a Town's place
    // vector (ADR-0018, as amended). The only path that can spend `jev-place`
    // budget: the public GET serves the stored record and never asks the model.
    const pv = /^\/api\/ops\/towns\/([^/]+)\/vector$/.exec(path);
    if (pv && req.method === 'POST') {
      const townId = pv[1]!;
      if (!isTown(townId)) return json({ error: 'not an H3 res-6 Town' }, 400);
      const town = env.TOWN.get(env.TOWN.idFromName(townId)) as unknown as {
        essenceVector(): Promise<PlaceVectorCompute>;
      };
      const r = await town.essenceVector();
      if (r.ok) {
        return json({
          town: townId,
          battery: r.vector.battery,
          model_served: r.vector.served,
          state_sha: r.vector.stateSha,
          at: r.vector.at,
          vector: r.vector.vector,
          asked: r.asked,
        });
      }
      if (r.reason === 'no-features') return json({ error: 'that Town has no Features yet' }, 404);
      if (r.reason === 'budget')
        return json(
          {
            error: `place-vector budget exhausted for today ($${r.spent.toFixed(4)} of $${r.cap})`,
          },
          503,
        );
      return json({ error: 'place vectors are not configured on this deployment' }, 503);
    }
    return json({ error: 'not found' }, 404);
  }
  return null;
}

/**
 * A photo of one building → a written observation → the building question pack
 * up the Ladder → Facts with `source: "capture"`, which outrank OSM and sharpen
 * the Bundle. The photo is sent to the vision provider and never stored.
 */
async function observe(req: Request, env: Env, featureId: string): Promise<Response> {
  const models = makeModels(env);
  if (!models) return json({ error: 'Photo analysis is not set up on this deployment.' }, 503);
  let body: { cell?: unknown; image?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'body must be JSON { cell, image }' }, 400);
  }
  const cell = String(body.cell ?? '');
  const image = String(body.image ?? '').replace(/^data:image\/jpe?g;base64,/, '');
  if (!isCell(cell)) return json({ error: 'cell must be an H3 res-9 Cell' }, 400);
  if (!image || image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return json({ error: 'image must be a base64 JPEG under 1.8 MB' }, 400);
  }

  const town = env.TOWN.get(env.TOWN.idFromName(townOf(cell))) as unknown as {
    cellFacts(cell: string): Promise<{ features: Feature[] }>;
    putFacts(facts: Fact[]): Promise<number>;
    markObserved(featureId: string, settled: boolean): Promise<void>;
    bundleFor(cell: string): Promise<{ manifest: { inputsHash: string } }>;
  };
  const { features } = await town.cellFacts(cell);
  const feature = features.find((f) => f.id === featureId);
  if (!feature) return json({ error: 'no such Feature in that Cell' }, 404);
  if (feature.kind !== 'building')
    return json({ error: 'only buildings can be observed for now' }, 400);

  let result;
  try {
    result = await observeBuilding(
      { jpegBase64: image, featureId, source: 'capture', observedAt: new Date().toISOString() },
      models,
    );
  } catch (err) {
    return json(
      { error: `Could not analyse the photo: ${String((err as Error).message).slice(0, 200)}` },
      502,
    );
  }
  // The visibility gate is a decision like any other: log it with its cost and answer.
  const gate = result.gate;
  await opsStub(env).logDecision({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    pack: 'pack.building.visible',
    packVersion: '1.0.0',
    subject: featureId,
    rung: 'jev',
    outcome: 'noul' in gate ? 'accepted' : gate.skipped === 'refused' ? 'refused' : 'unavailable',
    costUsd: 'noul' in gate ? gate.costUsd : 0,
    latencyMs: 0,
    confidence: 'noul' in gate ? Math.max(gate.noul, 1 - gate.noul) : 0,
    answers: 'noul' in gate ? { visible: { type: 'noul', noul: gate.noul } } : null,
    ...('detail' in gate && gate.detail ? { error: gate.detail } : {}),
  });
  if (result.facts.length) await town.putFacts(result.facts);
  // Not confident enough to become Facts: the human rung's Quest asks for a better photo.
  await town.markObserved(featureId, result.facts.length > 0);
  const bundle = await town.bundleFor(cell);
  return json({
    observation: result.observation,
    rung: result.result?.rung ?? null,
    accepted: result.result?.accepted ?? false,
    confidence: result.result?.decision.confidence ?? 0,
    gate: 'noul' in result.gate ? { visible: result.gate.noul } : { skipped: result.gate.skipped },
    facts: result.facts,
    inputsHash: bundle.manifest.inputsHash,
  });
}
