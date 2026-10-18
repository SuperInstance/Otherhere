import { describe, expect, it } from 'vitest';
import { cellAt, ingestBlockOf, type AgentManifest, type Job } from '@otherhere/core';
import { AgentRuntime, type FetchLike } from '../src/runtime';
import { ingestBlock } from '../src/handlers';
import { detectCapabilities } from '../src/capabilities';

const manifest: AgentManifest = {
  agent: 'test-box',
  version: '0.1.0',
  capabilities: { network: true, gpu: false, vramGb: 0, cpuCores: 2, alwaysOn: true },
  kinds: ['ingest_block'],
};
const job: Job = {
  id: 'ingest_block:x',
  kind: 'ingest_block',
  block: ingestBlockOf(cellAt(47.3769, 8.5417)),
  leaseUntil: '2026-10-18T00:05:00.000Z',
};

/** A fake edge (and Overpass) that records what it was sent. */
function fakeEdge(opts: { jobs?: Job[]; verdict?: number } = {}) {
  const jobs = [...(opts.jobs ?? [])];
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      headers,
      body: init?.body
        ? JSON.parse(String(init.body).startsWith('data=') ? '{}' : String(init.body))
        : null,
    });
    if (url.includes('overpass'))
      return Response.json({ elements: [{ type: 'node', id: 1, lat: 47.3769, lon: 8.5417 }] });
    if (url.endsWith('/api/agent/claim')) {
      const j = jobs.shift();
      return j ? Response.json({ job: j }) : new Response(null, { status: 204 });
    }
    const status = opts.verdict ?? 200;
    return Response.json(status === 200 ? { accepted: true, features: 1 } : { error: 'nope' }, {
      status,
    });
  };
  return { f, calls };
}

describe('AgentRuntime', () => {
  it('is idle when there is nothing it can run', async () => {
    const { f } = fakeEdge();
    const rt = new AgentRuntime({
      edge: 'https://edge',
      token: 't',
      manifest,
      handlers: {},
      fetch: f,
    });
    expect(await rt.runOnce()).toEqual({ kind: 'idle' });
  });

  it('claims, runs, and sends the result back as a proposal', async () => {
    const { f, calls } = fakeEdge({ jobs: [job] });
    const rt = new AgentRuntime({
      edge: 'https://edge',
      token: 't',
      manifest,
      handlers: { ingest_block: ingestBlock({ fetch: f, endpoints: ['https://overpass/api'] }) },
      fetch: f,
    });
    expect(await rt.runOnce()).toMatchObject({ kind: 'accepted', job: job.id });
    const claim = calls[0]!;
    expect(claim.headers).toMatchObject({ authorization: 'Bearer t', 'x-agent': 'test-box' });
    expect(claim.body).toEqual(manifest);
    const result = calls.at(-1)!;
    expect(result.url).toBe('https://edge/api/agent/jobs/ingest_block%3Ax/result');
    expect(result.body).toMatchObject({
      kind: 'ingest_block',
      overpass: { elements: [{ id: 1 }] },
    });
  });

  it('reports a rejected proposal, and a job it could not run', async () => {
    const rejected = fakeEdge({ jobs: [job], verdict: 422 });
    const handlers = {
      ingest_block: ingestBlock({ fetch: rejected.f, endpoints: ['https://overpass/api'] }),
    };
    expect(
      await new AgentRuntime({
        edge: 'https://edge',
        token: 't',
        manifest,
        handlers,
        fetch: rejected.f,
      }).runOnce(),
    ).toMatchObject({ kind: 'rejected', status: 422, error: 'nope' });

    const broken = fakeEdge({ jobs: [job] });
    const down = ingestBlock({
      fetch: async () => new Response('busy', { status: 504 }),
      endpoints: ['https://x'],
    });
    const r = await new AgentRuntime({
      edge: 'https://edge',
      token: 't',
      manifest,
      handlers: { ingest_block: down },
      fetch: broken.f,
    }).runOnce();
    expect(r.kind).toBe('failed');
    // Nothing was sent back: the lease runs out and another device can take the job.
    expect(broken.calls.filter((c) => c.url.includes('/result'))).toHaveLength(0);
  });

  it('declares GPU and always-on, and detects CPUs', () => {
    const c = detectCapabilities({ OTHERHERE_VRAM_GB: '12', OTHERHERE_ALWAYS_ON: 'true' });
    expect(c).toMatchObject({ gpu: true, vramGb: 12, alwaysOn: true, network: true });
    expect(c.cpuCores).toBeGreaterThanOrEqual(1);
    expect(detectCapabilities({})).toMatchObject({ gpu: false, alwaysOn: false });
  });
});
