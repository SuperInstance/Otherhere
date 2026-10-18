import {
  AgentManifest,
  cellAt,
  cellRing,
  ingestBlockOf,
  Proposal,
  townOf,
  type Job,
} from '@otherhere/core';
import type { Env } from './env';
import { jobsStub, type JobRow } from './jobs';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const notFound = () => json({ error: 'not found' }, 404);

/** Up to ~8 MB of Overpass JSON: a dense city block is well under 2 MB. */
const MAX_RESULT_BYTES = 8_000_000;

// RPC typing of these shapes is too deep for tsc; they are JobsDO's and TownDO's.
type Jobs = {
  claim(m: AgentManifest): Promise<Job | null>;
  leaseOf(id: string, agent: string): Promise<{ kind: string; block: string } | null>;
  settle(id: string, v: { ok: true } | { ok: false; error: string }): Promise<void>;
  enqueue(kind: 'ingest_block', block: string, again?: boolean): Promise<string>;
  list(limit: number): Promise<JobRow[]>;
};
type Town = { acceptIngestProposal(b: string, o: unknown, a: string): Promise<number> };

const bearer = (req: Request, token: string | undefined) =>
  !!token && req.headers.get('authorization') === `Bearer ${token}`;

/**
 * /api/agent/* for Plugins (needs AGENT_TOKEN) and the owner's /api/ops/jobs and
 * /api/ops/crawl (needs OPS_TOKEN). Without the tokens these routes do not exist,
 * and everything else keeps working: Plugins are optional (invariant 7).
 */
export async function agentRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path.startsWith('/api/agent/')) {
    if (!bearer(req, env.AGENT_TOKEN)) return notFound();
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const jobs = jobsStub(env) as unknown as Jobs;

    if (path === '/api/agent/claim') {
      const m = AgentManifest.safeParse(await req.json().catch(() => null));
      if (!m.success) return json({ error: 'body must be an agent manifest' }, 400);
      const job = await jobs.claim(m.data);
      return job ? json({ job }) : new Response(null, { status: 204 });
    }

    const r = /^\/api\/agent\/jobs\/([^/]+)\/result$/.exec(path);
    if (r) {
      const id = decodeURIComponent(r[1]!);
      const agent = req.headers.get('x-agent') ?? '';
      if (Number(req.headers.get('content-length') ?? 0) > MAX_RESULT_BYTES)
        return json({ error: 'result too large' }, 413);
      const lease = await jobs.leaseOf(id, agent);
      if (!lease) return json({ error: 'you do not hold a lease on this job' }, 409);
      const p = Proposal.safeParse(await req.json().catch(() => null));
      if (!p.success || p.data.kind !== lease.kind) {
        const error = 'result is not a valid proposal for this job';
        await jobs.settle(id, { ok: false, error });
        return json({ error }, 422);
      }
      const town = env.TOWN.get(env.TOWN.idFromName(townOf(lease.block))) as unknown as Town;
      try {
        const features = await town.acceptIngestProposal(lease.block, p.data.overpass, agent);
        await jobs.settle(id, { ok: true });
        return json({ accepted: true, features });
      } catch (err) {
        const error = (err as Error).message;
        await jobs.settle(id, { ok: false, error });
        return json({ error }, 422);
      }
    }
    return notFound();
  }

  if (path === '/api/ops/jobs' || path === '/api/ops/crawl') {
    if (!bearer(req, env.OPS_TOKEN)) return notFound();
    const jobs = jobsStub(env) as unknown as Jobs;
    if (path === '/api/ops/jobs' && req.method === 'GET')
      return json(await jobs.list(Number(new URL(req.url).searchParams.get('limit') ?? 50)));
    if (path === '/api/ops/crawl' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        lat?: unknown;
        lng?: unknown;
        rings?: unknown;
      };
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const rings = Math.min(Math.max(Math.trunc(Number(body.rings ?? 1)), 0), 4);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      )
        return json({ error: 'lat and lng must be numbers' }, 400);
      // Every ingest block around the point, refreshed even if already ingested.
      const blocks = [...new Set(cellRing(ingestBlockOf(cellAt(lat, lng)), rings))].sort();
      const ids = await Promise.all(blocks.map((b) => jobs.enqueue('ingest_block', b, true)));
      return json({ queued: ids }, 202);
    }
    return json({ error: 'method not allowed' }, 405);
  }
  return null;
}
