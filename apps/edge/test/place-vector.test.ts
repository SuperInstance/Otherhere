import { describe, expect, it } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { cellAt, cellsOfBlock, townOf, type Feature, type OverpassResponse } from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const BLOCK = (fixture as unknown as { block: string }).block;
const CELL = cellsOfBlock(BLOCK)[0]!;
const TOWN = townOf(CELL);
// A res-6 Town in the middle of the Pacific: valid id, never ingested, no Features.
const OCEAN = townOf(cellAt(0, -140));
const town = () => env.TOWN.get(env.TOWN.idFromName(TOWN));
const ops = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x/api/ops/${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-ops', ...init.headers },
  });

async function seed() {
  await town().ingestOverpass(
    BLOCK,
    fixture as unknown as OverpassResponse,
    '2026-10-17T00:00:00.000Z',
  );
}

/**
 * Tests in this file share one TownDO and one OpsDO (spend accumulates; the
 * Facts stay). Start each test with a clean vector/essence/census cache so the
 * `asked` flags and state shas are this test's own.
 */
const resetCaches = async () => {
  const inside = runInDurableObject as unknown as (
    stub: unknown,
    fn: (instance: unknown, state: DurableObjectState) => void,
  ) => Promise<void>;
  await inside(town(), (_, state) => {
    state.storage.sql
      .exec("DELETE FROM meta WHERE key LIKE 'essence%' OR key = 'place-vector:1'")
      .toArray();
  });
};

/** Place-vector spend has its own budget key, separate from the capture path's `jev`. */
async function placeSpend(): Promise<number> {
  const body = (await (await ops('spend')).json()) as Record<string, number>;
  return body['jev-place'] ?? 0;
}

type VectorBody = {
  town: string;
  battery: string;
  model_served: string;
  state_sha: string;
  at: string;
  vector: Record<string, number>;
  asked?: boolean;
  error?: string;
};
/** The public, unauthenticated read. */
const vector = async () => {
  const res = await SELF.fetch(`https://x/api/towns/${TOWN}/vector`);
  return { status: res.status, body: (await res.json()) as VectorBody };
};
/** The owner-only compute. */
const compute = async (townId: string = TOWN) => {
  const res = await ops(`towns/${townId}/vector`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as VectorBody };
};

let factCounter = 0;
/** A capture Fact the Town did not have: the census (and so the state) changes. */
async function writeCaptureFact() {
  const { features } = (await town().cellFacts(CELL)) as unknown as { features: Feature[] };
  const building = features.find((f) => f.kind === 'building')!;
  await town().putFacts([
    {
      featureId: building.id,
      attribute: 'colour',
      value: `#a5543${factCounter++ % 6}`, // distinct per call: each test needs its own state change
      source: 'capture',
      confidence: 0.9,
      observedAt: '2026-10-19T00:00:00.000Z',
      version: 1,
    },
  ]);
}

const metaKeys = async () => {
  const inside = runInDurableObject as unknown as (
    stub: unknown,
    fn: (instance: unknown, state: DurableObjectState) => string[],
  ) => Promise<string[]>;
  return inside(town(), (_, state) =>
    state.storage.sql
      .exec("SELECT key FROM meta WHERE key LIKE 'essence%' OR key = 'place-vector:1'")
      .toArray()
      .map((r) => String(r.key)),
  );
};

describe('place vectors (ADR-0018, amended: compute behind OPS_TOKEN)', () => {
  it('the public GET never reaches the model router', async () => {
    await seed();
    await resetCaches();
    // No vector yet: the public read is a 404, not a paid call.
    expect(await placeSpend()).toBe(0);
    const miss = await vector();
    expect(miss.status).toBe(404);
    expect(miss.body.error).toBeTruthy();
    expect(await placeSpend()).toBe(0);

    // Once the owner computes it, the public read serves the stored record as-is.
    const computed = await compute();
    expect(computed.status).toBe(200);
    expect(computed.body).toMatchObject({
      town: TOWN,
      battery: 'place.v1',
      model_served: 'fake-jev',
      asked: true,
    });
    expect(Object.keys(computed.body.vector!).sort()).toEqual([
      'dense_not_spread',
      'green_setting',
      'height_scale',
      'heights_recorded',
      'known_in_detail',
      'mostly_conifers',
      'rainy_coast',
      'steep_roofs',
      'tall_for_a_town',
      'uniform_roofs',
      'warm_earthy_walls',
    ]);
    // The fake answers with the sealed round's Zürich medians.
    expect(computed.body.vector).toMatchObject({
      steep_roofs: 0.17,
      mostly_conifers: 0.02,
      height_scale: 4.27,
    });
    const spentAfterCompute = await placeSpend();
    expect(spentAfterCompute).toBeGreaterThan(0);

    const read = await vector();
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      town: computed.body.town,
      battery: computed.body.battery,
      model_served: computed.body.model_served,
      state_sha: computed.body.state_sha,
      at: computed.body.at,
      vector: computed.body.vector,
    });
    expect(read.body.asked).toBeUndefined(); // the public read has no `asked`: it never computes
    expect(await placeSpend()).toBe(spentAfterCompute);
  });

  it('the compute is idempotent: a second call over the same state does not re-ask', async () => {
    await seed();
    await resetCaches();
    const first = await compute();
    expect(first.body.asked).toBe(true);
    const spentAfterFirst = await placeSpend();

    const second = await compute();
    expect(second.body.asked).toBe(false);
    expect(second.body.state_sha).toBe(first.body.state_sha);
    expect(await placeSpend()).toBe(spentAfterFirst);
  });

  it('two concurrent computes make one model call (single-flight)', async () => {
    await seed();
    await resetCaches();
    const before = await placeSpend();
    await compute(); // one call: this also establishes the per-call cost
    const perCall = (await placeSpend()) - before;
    expect(perCall).toBeGreaterThan(0);

    await writeCaptureFact(); // change the state so both concurrent calls would re-ask
    const spentBefore = await placeSpend();

    const [a, b] = await Promise.all([compute(), compute()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.state_sha).toBe(b.body.state_sha);

    // The fake charges a fixed usage per call, so exactly one call's cost was
    // added, not two: the in-flight promise is shared inside the TownDO. (The
    // ledger accumulates floats, so compare within far less than one call.)
    expect((await placeSpend()) - spentBefore).toBeCloseTo(perCall, 12);
  });

  it('a Fact write keeps the stored vector; the state hash decides the re-ask', async () => {
    await seed();
    await resetCaches();
    const first = await compute();
    expect(await metaKeys()).toContain('place-vector:1');
    expect(await metaKeys()).toContain('essence-census:1');

    await writeCaptureFact();

    // The write dropped the Essence and the census, not the vector.
    const keys = await metaKeys();
    expect(keys).toContain('place-vector:1');
    expect(keys).not.toContain('essence-census:1');
    expect(keys).not.toContain('essence:2');

    // The public read still serves the stored vector, honestly labelled with
    // the sha of the state it describes.
    const read = await vector();
    expect(read.status).toBe(200);
    expect(read.body.state_sha).toBe(first.body.state_sha);

    // The owner's compute re-asks over the changed state and stores the new one.
    const spentBefore = await placeSpend();
    const second = await compute();
    expect(second.body.state_sha).not.toBe(first.body.state_sha);
    expect(await placeSpend()).toBeGreaterThan(spentBefore);
    const readAfter = await vector();
    expect(readAfter.body.state_sha).toBe(second.body.state_sha);
  });

  it('refuses Towns with no Features', async () => {
    const spent = await placeSpend();
    const res = await compute(OCEAN);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/features/i); // not the ops catch-all's "not found"
    expect(await placeSpend()).toBe(spent);
  });

  it('an exhausted budget returns a clean 503', async () => {
    await seed();
    await resetCaches();
    const warm = await compute();
    expect(warm.status).toBe(200);
    await writeCaptureFact(); // make the stored vector stale so the next call would pay
    const spent = await placeSpend();
    expect(spent).toBeGreaterThan(0);

    const savedCaps = env.MODEL_CAPS_USD;
    env.MODEL_CAPS_USD = JSON.stringify({ 'jev-place': spent / 2 });
    try {
      const res = await compute();
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/budget/i);
      expect(await placeSpend()).toBe(spent); // nothing new was charged
    } finally {
      env.MODEL_CAPS_USD = savedCaps;
    }
  });

  it('rejects ids that are not res-6 Towns on both routes', async () => {
    expect((await SELF.fetch('https://x/api/towns/nope/vector')).status).toBe(400);
    expect((await SELF.fetch(`https://x/api/towns/${CELL}/vector`)).status).toBe(400);
    expect((await ops('towns/nope/vector', { method: 'POST' })).status).toBe(400);
    expect((await ops(`towns/${CELL}/vector`, { method: 'POST' })).status).toBe(400);
  });
});
