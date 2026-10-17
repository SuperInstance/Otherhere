import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { Capsule, cellsOfBlock, townOf, type OverpassResponse } from '@otherhere/core';
import fixture from '../../../packages/core/test/fixtures/overpass-zurich.json';

const BLOCK = (fixture as unknown as { block: string }).block;
const cells = cellsOfBlock(BLOCK).slice(0, 3);

async function seed() {
  await env.TOWN.get(env.TOWN.idFromName(townOf(cells[0]!))).ingestOverpass(
    BLOCK,
    fixture as unknown as OverpassResponse,
    '2026-10-17T00:00:00.000Z',
  );
}

const save = (body: unknown) =>
  SELF.fetch('https://x/api/capsules', { method: 'POST', body: JSON.stringify(body) });

describe('postcards', () => {
  it('saves a snapshot of the Facts in its Cells and serves it by link', async () => {
    await seed();
    const res = await save({
      title: 'Bahnhofplatz',
      scope: 'friends',
      cells,
      center: { lat: 47.3769, lng: 8.5417 },
      pose: [0, 1.7, 0, 0.5, 0],
    });
    expect(res.status).toBe(201);
    const { id, features } = (await res.json()) as { id: string; features: number };
    expect(id).toMatch(/^pc_[a-z2-9]{10}$/);
    expect(features).toBeGreaterThan(100);

    const got = await SELF.fetch(`https://x/api/capsules/${id}`);
    expect(got.status).toBe(200);
    const c = Capsule.parse(await got.json());
    expect(c.title).toBe('Bahnhofplatz');
    expect(c.cells).toEqual(cells);
    expect(c.snapshot.features.length).toBe(features);
    expect(c.view?.pose).toEqual([0, 1.7, 0, 0.5, 0]);
  });

  it('private postcards need the owner key, and look missing without it', async () => {
    await seed();
    const { id, ownerKey } = (await (
      await save({
        title: 'Home',
        scope: 'private',
        cells: cells.slice(0, 1),
        center: { lat: 47.3769, lng: 8.5417 },
      })
    ).json()) as {
      id: string;
      ownerKey: string;
    };
    expect((await SELF.fetch(`https://x/api/capsules/${id}`)).status).toBe(404);
    expect((await SELF.fetch(`https://x/api/capsules/${id}?k=wrong`)).status).toBe(404);
    expect((await SELF.fetch(`https://x/api/capsules/${id}?k=${ownerKey}`)).status).toBe(200);
  });

  it('validates input', async () => {
    expect(
      (await save({ title: 'x', scope: 'everyone', cells, center: { lat: 1, lng: 1 } })).status,
    ).toBe(400);
    expect(
      (await save({ title: 'x', scope: 'public', cells: ['nope'], center: { lat: 1, lng: 1 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await save({
          title: 'x',
          scope: 'public',
          cells: Array(20)
            .fill(cells[0])
            .map((c, i) => (i ? c + i : c)),
          center: { lat: 1, lng: 1 },
        })
      ).status,
    ).toBe(400);
    expect((await SELF.fetch('https://x/api/capsules/pc_aaaaaaaaaa')).status).toBe(404);
  });
});
