import { describe, expect, it } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { cellsOfBlock, townOf, type Feature, type OverpassResponse } from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const BLOCK = (fixture as unknown as { block: string }).block;
const CELL = cellsOfBlock(BLOCK)[0]!;
const TOWN = townOf(CELL);
const town = () => env.TOWN.get(env.TOWN.idFromName(TOWN));
const ops = (path: string) =>
  SELF.fetch(`https://x/api/ops/${path}`, { headers: { authorization: 'Bearer test-ops' } });

async function seed() {
  await town().ingestOverpass(
    BLOCK,
    fixture as unknown as OverpassResponse,
    '2026-10-17T00:00:00.000Z',
  );
}

/** The only jev spend in this file comes from `essenceVector` (the fake charges per call). */
async function jevSpend(): Promise<number> {
  const body = (await (await ops('spend')).json()) as Record<string, number>;
  return body.jev ?? 0;
}

type VectorBody = {
  town: string;
  battery: string;
  model_served: string;
  state_sha: string;
  at: string;
  vector: Record<string, number>;
};
const vector = async () => {
  const res = await SELF.fetch(`https://x/api/towns/${TOWN}/vector`);
  return { status: res.status, body: (await res.json()) as VectorBody };
};

const metaKeys = async () => {
  const inside = runInDurableObject as unknown as (
    stub: unknown,
    fn: (instance: unknown, state: DurableObjectState) => string[],
  ) => Promise<string[]>;
  return inside(town(), (_, state) =>
    state.storage.sql
      .exec("SELECT key FROM meta WHERE key LIKE 'essence%'")
      .toArray()
      .map((r) => String(r.key)),
  );
};

describe('place vectors (ADR-0018)', () => {
  it('asks the sealed battery over the Town and stores the vector beside the Essence', async () => {
    await seed();
    const before = await jevSpend();
    const first = await vector();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      town: TOWN,
      battery: 'place.v1',
      model_served: 'fake-jev',
    });
    expect(Object.keys(first.body.vector).sort()).toEqual([
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
    expect(first.body.vector).toMatchObject({
      steep_roofs: 0.17,
      mostly_conifers: 0.02,
      height_scale: 4.27,
    });
    expect(await jevSpend()).toBeGreaterThan(before);
    const spentAfterFirst = await jevSpend();
    expect(await metaKeys()).toContain('essence-vector:1');

    // The second read is served from the cache: the same stored record, no new spend.
    const second = await vector();
    expect(second.body).toEqual(first.body);
    expect(await jevSpend()).toBe(spentAfterFirst);
  });

  it('moves with the Essence: a Fact write drops both caches and re-asks once', async () => {
    await seed();
    const first = await vector();
    expect(await metaKeys()).toContain('essence-vector:1');

    // A capture Fact the Town did not have: the census (and so the state) changes.
    const { features } = (await town().cellFacts(CELL)) as unknown as { features: Feature[] };
    const building = features.find((f) => f.kind === 'building')!;
    await town().putFacts([
      {
        featureId: building.id,
        attribute: 'colour',
        value: '#a5543f',
        source: 'capture',
        confidence: 0.9,
        observedAt: '2026-10-19T00:00:00.000Z',
        version: 1,
      },
    ]);

    // The write invalidated both Essence and vector keys together.
    expect(await metaKeys()).toEqual([]);
    const spentAfterFirst = await jevSpend();
    const second = await vector();
    expect(second.status).toBe(200);
    // Re-asked (spend grew) over a changed state (a new sha), same battery.
    expect(await jevSpend()).toBeGreaterThan(spentAfterFirst);
    expect(second.body.state_sha).not.toBe(first.body.state_sha);
    expect(second.body.battery).toBe('place.v1');
    expect(await metaKeys()).toContain('essence-vector:1');
  });

  it('rejects ids that are not res-6 Towns', async () => {
    expect((await SELF.fetch('https://x/api/towns/nope/vector')).status).toBe(400);
    expect((await SELF.fetch(`https://x/api/towns/${CELL}/vector`)).status).toBe(400);
  });
});
