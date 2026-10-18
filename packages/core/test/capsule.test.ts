import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capsuleBundleInputs, generatorsMatch, makePlaceCapsule } from '../src/capsule/place';
import { osmToFacts } from '../src/osm/to-facts';
import { resolveFacts } from '../src/facts/resolve';
import { bundleInputsHash } from '../src/bundle/build';
import { generatorSet } from '../src/generators';
import { cellsOfBlock } from '../src/geo/h3';
import { Capsule } from '../src/schema/capsule';
import type { OverpassResponse } from '../src/osm/overpass';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/overpass-zurich.json', import.meta.url), 'utf8'),
) as OverpassResponse & { block: string };
const { features, facts } = osmToFacts(fixture, {
  block: fixture.block,
  observedAt: '2026-10-17T00:00:00.000Z',
});
const cells = cellsOfBlock(fixture.block).slice(0, 2);

async function capsule() {
  return makePlaceCapsule({
    id: 'pc_test0001',
    title: 'Two blocks of Zürich',
    scope: 'friends',
    createdAt: '2026-10-17T00:00:00.000Z',
    cells,
    center: { lat: 47.3769, lng: 8.5417 },
    features,
    facts,
    generators: await generatorSet().refs(),
  });
}

describe('place Capsules (ADR-0008)', () => {
  it('snapshot only the Features anchored in their Cells, in a stable order', async () => {
    const c = await capsule();
    expect(c.snapshot.features.every((f) => cells.includes(f.anchorCell))).toBe(true);
    expect(c.snapshot.features.length).toBeGreaterThan(100);
    const ids = new Set(c.snapshot.features.map((f) => f.id));
    expect(c.snapshot.facts.every((f) => ids.has(f.featureId))).toBe(true);
    expect(Capsule.parse(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it('rebuild Bundles with the same content address as the live World', async () => {
    const c = await capsule();
    const resolved = resolveFacts(facts);
    const fromCapsule = capsuleBundleInputs(c);
    for (const cell of cells) {
      const live = features
        .filter((f) => f.anchorCell === cell)
        .map((f) => ({ id: f.id, kind: f.kind, attrs: resolved.get(f.id) ?? {} }));
      expect(await bundleInputsHash({ cell, ...fromCapsule.get(cell)! })).toBe(
        await bundleInputsHash({ cell, features: live }),
      );
    }
  });

  it('know whether this build has the generators they were saved with', async () => {
    const c = await capsule();
    expect(generatorsMatch(c, await generatorSet().refs())).toBe(true);
    expect(generatorsMatch(c, [])).toBe(false);
  });
});
