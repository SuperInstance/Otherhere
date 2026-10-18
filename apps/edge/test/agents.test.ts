import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { cellsOfBlock, townOf, type AgentManifest, type Feature, type Job } from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const BLOCK = (fixture as unknown as { block: string }).block;
const CELL = cellsOfBlock(BLOCK)[0]!;
const ZURICH = { lat: 47.3769, lng: 8.5417 };

const manifest = (agent = 'home-server', network = true): AgentManifest => ({
  agent,
  version: '0.1.0',
  capabilities: { network, gpu: false, vramGb: 0, cpuCores: 4, alwaysOn: true },
  kinds: ['ingest_block'],
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const asAgent = (agent = 'home-server') => ({
  authorization: 'Bearer test-agent',
  'x-agent': agent,
});
const asOwner = { authorization: 'Bearer test-ops' };

async function crawl(rings = 0) {
  const res = await post('/api/ops/crawl', { ...ZURICH, rings }, asOwner);
  expect(res.status).toBe(202);
  return ((await res.json()) as { queued: string[] }).queued;
}
async function claim(m = manifest()): Promise<Job | null> {
  const res = await post('/api/agent/claim', m, asAgent(m.agent));
  if (res.status === 204) return null;
  return ((await res.json()) as { job: Job }).job;
}

describe('Plugin jobs (ADR-0015)', () => {
  // Storage is shared across tests in this file: start each one with an empty queue.
  beforeEach(() =>
    runInDurableObject(env.JOBS.get(env.JOBS.idFromName('jobs')), (_, state) => {
      state.storage.sql.exec('DELETE FROM jobs');
    }),
  );

  it('do not exist without the right token', async () => {
    expect((await post('/api/agent/claim', manifest())).status).toBe(404);
    expect(
      (await post('/api/agent/claim', manifest(), { authorization: 'Bearer nope' })).status,
    ).toBe(404);
    expect((await post('/api/ops/crawl', ZURICH)).status).toBe(404);
  });

  it('a crawl queues the blocks around a point, once each', async () => {
    const first = await crawl(1);
    expect(first).toHaveLength(7);
    expect(first).toContain(`ingest_block:${BLOCK}`);
    const list = (await (
      await SELF.fetch('https://x/api/ops/jobs', { headers: asOwner })
    ).json()) as { id: string; status: string }[];
    expect(list.filter((j) => j.status === 'queued')).toHaveLength(7);
  });

  it('only hands jobs to devices that can run them', async () => {
    await crawl();
    expect(await claim(manifest('offline-box', false))).toBeNull();
    const job = await claim();
    expect(job).toMatchObject({ kind: 'ingest_block', block: BLOCK });
    // Leased: nobody else gets it.
    expect(await claim(manifest('other'))).toBeNull();
  });

  it('turns an accepted Overpass result into osm Facts in the right Town', async () => {
    await crawl();
    const job = (await claim())!;
    const res = await post(
      `/api/agent/jobs/${encodeURIComponent(job.id)}/result`,
      { kind: 'ingest_block', overpass: fixture },
      asAgent(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    const town = env.TOWN.get(env.TOWN.idFromName(townOf(CELL)));
    const { features } = (await town.cellFacts(CELL)) as unknown as { features: Feature[] };
    expect(features.length).toBeGreaterThan(0);
    const list = (await (
      await SELF.fetch('https://x/api/ops/jobs', { headers: asOwner })
    ).json()) as { id: string; status: string; agent: string }[];
    expect(list.find((j) => j.id === job.id)).toMatchObject({
      status: 'done',
      agent: 'home-server',
    });
  });

  it('refuses a result from a device without the lease', async () => {
    await crawl();
    const job = (await claim())!;
    const res = await post(
      `/api/agent/jobs/${encodeURIComponent(job.id)}/result`,
      { kind: 'ingest_block', overpass: fixture },
      asAgent('impostor'),
    );
    expect(res.status).toBe(409);
  });

  it('rejects a proposal that is not an Overpass response, and frees the job', async () => {
    await crawl();
    const job = (await claim())!;
    const res = await post(
      `/api/agent/jobs/${encodeURIComponent(job.id)}/result`,
      { kind: 'ingest_block', overpass: { elements: [{ type: 'node', id: 1, lat: 999, lon: 0 }] } },
      asAgent(),
    );
    expect(res.status).toBe(422);
    // Back in the queue for another try.
    expect(await claim(manifest('second'))).toMatchObject({ id: job.id });
  });

  it('a Plugin cannot smuggle in Facts or pick a source', async () => {
    await crawl();
    const job = (await claim())!;
    const res = await post(
      `/api/agent/jobs/${encodeURIComponent(job.id)}/result`,
      {
        kind: 'ingest_block',
        overpass: { elements: [] },
        facts: [{ featureId: 'osm:w1', attribute: 'height', value: 999, source: 'manual_edit' }],
      },
      asAgent(),
    );
    expect(res.status).toBe(422);
  });

  it('a failed Overpass fetch queues a job for a Plugin', async () => {
    // Tests point Overpass at a closed port, so this ingest fails.
    const cell = '891f8d7a49bffff';
    await SELF.fetch(`https://x/api/cells/${cell}`);
    const list = (await (
      await SELF.fetch('https://x/api/ops/jobs', { headers: asOwner })
    ).json()) as { id: string }[];
    expect(list.map((j) => j.id).some((id) => id.startsWith('ingest_block:'))).toBe(true);
  });
});
