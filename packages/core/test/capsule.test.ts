import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  capsuleBundleInputs,
  generatorsMatch,
  landcoverCellsForRing,
  makePlaceCapsule,
} from '../src/capsule/place';
import { osmToFacts } from '../src/osm/to-facts';
import { resolveFacts } from '../src/facts/resolve';
import { bundleInputsHash } from '../src/bundle/build';
import { generatorSet } from '../src/generators';
import { blockBBox, cellCenter, cellsOfBlock } from '../src/geo/h3';
import { Capsule } from '../src/schema/capsule';
import type { Fact, LngLat } from '../src/schema/fact';
import type { Feature } from '../src/schema/feature';
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

describe('landcover fan-out (a ring speaks in every Cell it touches)', () => {
  const bb = blockBBox(fixture.block);
  /** A closed ring around the whole block: it intersects both Capsule Cells. */
  const everywhere: LngLat[] = [
    [bb.west, bb.south],
    [bb.east, bb.south],
    [bb.east, bb.north],
    [bb.west, bb.north],
    [bb.west, bb.south],
  ];
  /** A small ring around the first Cell's centre: that Cell only. */
  const c0 = cellCenter(cells[0]!);
  const local: LngLat[] = [
    [c0.lng - 0.001, c0.lat - 0.001],
    [c0.lng + 0.001, c0.lat - 0.001],
    [c0.lng + 0.001, c0.lat + 0.001],
    [c0.lng - 0.001, c0.lat + 0.001],
    [c0.lng - 0.001, c0.lat - 0.001],
  ];
  const cover = (
    id: string,
    anchorCell: string,
    ring: LngLat[],
  ): { f: Feature; facts: Fact[] } => ({
    f: { id, kind: 'landcover', anchorCell },
    facts: [
      {
        featureId: id,
        attribute: 'footprint',
        value: ring,
        source: 'osm',
        confidence: 0.7,
        observedAt: '2026-10-17T00:00:00.000Z',
        version: 1,
      },
      {
        featureId: id,
        attribute: 'landcover',
        value: 'forest',
        source: 'osm',
        confidence: 0.9,
        observedAt: '2026-10-17T00:00:00.000Z',
        version: 1,
      },
    ],
  });

  it('landcoverCellsForRing finds every intersected Cell and no others', () => {
    expect(landcoverCellsForRing(everywhere, cells).sort()).toEqual([...cells].sort());
    expect(landcoverCellsForRing(local, cells)).toEqual([cells[0]]);
  });

  it('makePlaceCapsule snapshots a landcover Feature whose ring reaches in, wherever it anchors', async () => {
    const all = cellsOfBlock(fixture.block);
    const outside = all[6]!;
    const reaching = cover('osm:r7', outside, everywhere);
    const oc = cellCenter(outside);
    const farRing: LngLat[] = [
      [oc.lng - 0.0005, oc.lat - 0.0005],
      [oc.lng + 0.0005, oc.lat - 0.0005],
      [oc.lng + 0.0005, oc.lat + 0.0005],
      [oc.lng - 0.0005, oc.lat + 0.0005],
      [oc.lng - 0.0005, oc.lat - 0.0005],
    ];
    const staying = cover('osm:r8', outside, farRing);
    const c = await makePlaceCapsule({
      id: 'pc_test0003',
      title: 'Inclusion',
      scope: 'friends',
      createdAt: '2026-10-17T00:00:00.000Z',
      cells,
      center: { lat: 47.3769, lng: 8.5417 },
      features: [reaching.f, staying.f],
      facts: [...reaching.facts, ...staying.facts],
      generators: await generatorSet().refs(),
    });
    // The reaching ring is in (with its Facts); the far one stays out.
    expect(c.snapshot.features.map((f) => f.id)).toEqual(['osm:r7']);
    expect(c.snapshot.facts.every((f) => f.featureId === 'osm:r7')).toBe(true);
    // And the bundle inputs fan it into the Cells it covers.
    expect(
      capsuleBundleInputs(c)
        .get(cells[1]!)!
        .features.map((f) => f.id),
    ).toEqual(['osm:r7']);
  });

  it('capsuleBundleInputs fans a landcover Feature out to the Cells its ring touches', async () => {
    const wide = cover('osm:r1', cells[0]!, everywhere);
    const near = cover('osm:r2', cells[0]!, local);
    const c = await makePlaceCapsule({
      id: 'pc_test0002',
      title: 'Fan-out',
      scope: 'friends',
      createdAt: '2026-10-17T00:00:00.000Z',
      cells,
      center: { lat: 47.3769, lng: 8.5417 },
      features: [wide.f, near.f],
      facts: [...wide.facts, ...near.facts],
      generators: await generatorSet().refs(),
    });
    const inputs = capsuleBundleInputs(c);
    const ids = (cell: string) => inputs.get(cell)!.features.map((f) => f.id);
    expect(ids(cells[0]!)).toEqual(['osm:r1', 'osm:r2']);
    expect(ids(cells[1]!)).toEqual(['osm:r1']);
  });
});
