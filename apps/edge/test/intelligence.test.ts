import { describe, expect, it } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import {
  cellsOfBlock,
  townOf,
  type DecisionLog,
  type OverpassResponse,
  type ResolvedAttrs,
  type Feature,
} from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const BLOCK = (fixture as unknown as { block: string }).block;
const CELL = cellsOfBlock(BLOCK)[0]!;
const town = () => env.TOWN.get(env.TOWN.idFromName(townOf(CELL)));
const ops = (path: string) =>
  SELF.fetch(`https://x/api/ops/${path}`, { headers: { authorization: 'Bearer test-ops' } });

async function aBuilding(): Promise<string> {
  await town().ingestOverpass(
    BLOCK,
    fixture as unknown as OverpassResponse,
    '2026-10-17T00:00:00.000Z',
  );
  const { features } = (await town().cellFacts(CELL)) as unknown as { features: Feature[] };
  return features.find((f) => f.kind === 'building')!.id;
}

const observe = (id: string, body: unknown) =>
  SELF.fetch(`https://x/api/features/${encodeURIComponent(id)}/observe`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

describe('photo → Facts', () => {
  it('turns a photo into capture Facts that outrank OSM and change the Bundle', async () => {
    const id = await aBuilding();
    const before = (await (await SELF.fetch(`https://x/api/cells/${CELL}`)).json()) as {
      manifest: { inputsHash: string };
    };
    const res = await observe(id, { cell: CELL, image: 'data:image/jpeg;base64,/9j/AAAA' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rung: string;
      accepted: boolean;
      facts: { attribute: string; source: string }[];
      inputsHash: string;
      observation: string;
    };
    expect(body).toMatchObject({ rung: 'jev', accepted: true });
    expect(body.observation).toContain('gable');
    expect(body.facts.map((f) => f.attribute).sort()).toEqual([
      'colour',
      'levels',
      'roof.colour',
      'roof.shape',
    ]);
    expect(body.inputsHash).not.toBe(before.manifest.inputsHash);

    const { resolved } = (await town().cellFacts(CELL)) as unknown as {
      resolved: Record<string, ResolvedAttrs>;
    };
    expect(resolved[id]!['roof.shape']).toMatchObject({ value: 'gable', source: 'capture' });
  });

  it('logs the decision and charges the budget ledger', async () => {
    const id = await aBuilding();
    await observe(id, { cell: CELL, image: '/9j/AAAA' });
    const decisions = (await (await ops('decisions?limit=5')).json()) as DecisionLog[];
    // Two decisions per photo: the Ladder's answers and the visibility gate's.
    expect(decisions.find((d) => d.pack === 'pack.building')).toMatchObject({
      subject: id,
      rung: 'jev',
      outcome: 'accepted',
    });
    expect(decisions.find((d) => d.pack === 'pack.building.visible')).toMatchObject({
      subject: id,
      rung: 'jev',
      outcome: 'accepted',
    });
    const spend = (await (await ops('spend')).json()) as Record<string, number>;
    expect(spend.groq).toBeGreaterThan(0);
    expect(spend.jev).toBeGreaterThan(0);
  });

  it('validates input', async () => {
    const id = await aBuilding();
    expect((await observe(id, { cell: 'nope', image: '/9j/' })).status).toBe(400);
    expect((await observe(id, { cell: CELL, image: '<svg>' })).status).toBe(400);
    expect((await observe('osm:w1', { cell: CELL, image: '/9j/AAAA' })).status).toBe(404);
  });
});

describe('ops routes are owner-only', () => {
  it('404 without the token', async () => {
    expect((await SELF.fetch('https://x/api/ops/spend')).status).toBe(404);
    expect((await ops('spend')).status).toBe(200);
  });
});

describe('taste judge storage', () => {
  it('stores valid taste events and rejects invalid ones', async () => {
    const ok = await SELF.fetch('https://x/api/judge/taste', {
      method: 'POST',
      body: JSON.stringify({
        at: '2026-10-17T00:00:00.000Z',
        cell: CELL,
        generator: 'building.basic',
        signal: 'dwell',
        value: 42,
      }),
    });
    expect(ok.status).toBe(201);
    expect(
      (
        await SELF.fetch('https://x/api/judge/taste', {
          method: 'POST',
          body: '{"signal":"vibes"}',
        })
      ).status,
    ).toBe(400);
  });
});

describe('Quests', () => {
  type Q = { featureId: string; reason: string; ask: string[] };
  const quests = async () =>
    ((await (await SELF.fetch(`https://x/api/cells/${CELL}/quests`)).json()) as { quests: Q[] })
      .quests;

  it('asks for photos of buildings whose look is imagined, and a photo settles one', async () => {
    await aBuilding();
    const before = await quests();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThanOrEqual(3);
    const target = before[0]!;
    expect(target.reason).toBe('unknown');

    // The fake models answer confidently: the photo becomes Facts and the Quest is done.
    await observe(target.featureId, { cell: CELL, image: '/9j/AAAA' });
    expect((await quests()).map((q) => q.featureId)).not.toContain(target.featureId);
  });

  it('a photo the Ladder could not settle turns its building into an unsure Quest', async () => {
    const id = await aBuilding();
    await town().markObserved(id, false);
    expect((await quests())[0]).toMatchObject({ featureId: id, reason: 'unsure' });
    await town().markObserved(id, true);
    expect((await quests()).find((q) => q.featureId === id)?.reason).not.toBe('unsure');
  });
});

describe('moderation', () => {
  it("removes one source's Facts from a Feature, owner only", async () => {
    const id = await aBuilding();
    await observe(id, { cell: CELL, image: '/9j/AAAA' });
    const del = (auth: string | null) =>
      SELF.fetch(
        `https://x/api/ops/cells/${CELL}/features/${encodeURIComponent(id)}/facts?source=capture`,
        { method: 'DELETE', headers: auth ? { authorization: auth } : {} },
      );
    expect((await del(null)).status).toBe(404);
    const res = await del('Bearer test-ops');
    expect(await res.json()).toMatchObject({ removed: 4 });
    const { resolved } = (await town().cellFacts(CELL)) as unknown as {
      resolved: Record<string, ResolvedAttrs>;
    };
    expect(Object.values(resolved[id] ?? {}).every((r) => r.source !== 'capture')).toBe(true);
  });

  it('recomputes the Essence after removing Facts, so removed Facts stop shaping the Town', async () => {
    const id = await aBuilding();
    await observe(id, { cell: CELL, image: '/9j/AAAA' });
    // Computes and caches the Essence, removed Facts included. (Typed narrowly: the RPC
    // return types of TownDO are too deep for the checker here.)
    const stub = town() as unknown as { snapshot(cell: string): Promise<unknown> };
    await stub.snapshot(CELL);
    const inside = runInDurableObject as unknown as (
      stub: unknown,
      fn: (instance: unknown, state: DurableObjectState) => string[],
    ) => Promise<string[]>;
    const cached = () =>
      inside(town(), (_, state) =>
        state.storage.sql
          .exec("SELECT key FROM meta WHERE key LIKE 'essence%'")
          .toArray()
          .map((r) => String(r.key)),
      );
    expect(await cached()).not.toEqual([]);
    await SELF.fetch(
      `https://x/api/ops/cells/${CELL}/features/${encodeURIComponent(id)}/facts?source=capture`,
      { method: 'DELETE', headers: { authorization: 'Bearer test-ops' } },
    );
    expect(await cached()).toEqual([]);
  });
});
