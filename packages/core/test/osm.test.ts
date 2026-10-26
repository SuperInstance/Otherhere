import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmToFacts, parseColour, parseMetres, stitchRings } from '../src/osm/to-facts';
import { fetchOverpass, overpassQuery, type OverpassResponse } from '../src/osm/overpass';
import { Fact } from '../src/schema/fact';
import { Feature } from '../src/schema/feature';
import { cellAt, cellsOfBlock, blockBBox, ingestBlockOf } from '../src/geo/h3';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/overpass-zurich.json', import.meta.url), 'utf8'),
) as OverpassResponse & {
  block: string;
};
const observedAt = '2026-10-17T00:00:00.000Z';

describe('tag parsing', () => {
  it('parses metres and ignores other units', () => {
    expect(parseMetres('12')).toBe(12);
    expect(parseMetres('12.5 m')).toBe(12.5);
    expect(parseMetres("30'")).toBeUndefined();
    expect(parseMetres('tall')).toBeUndefined();
  });
  it('normalises colours', () => {
    expect(parseColour('#ABC')).toBe('#aabbcc');
    expect(parseColour('White')).toBe('#f2f0ea');
    expect(parseColour('chartreuse-ish')).toBeUndefined();
  });
});

describe('osmToFacts on a recorded Zürich block', () => {
  const { features, facts } = osmToFacts(fixture, { block: fixture.block, observedAt });

  it('produces valid Features and Facts, all with source osm', () => {
    for (const f of features) Feature.parse(f);
    for (const f of facts) Fact.parse(f);
    expect(facts.every((f) => f.source === 'osm')).toBe(true);
    const kinds = new Set(features.map((f) => f.kind));
    expect(kinds).toContain('building');
    expect(kinds).toContain('road');
  });

  it('anchors every Feature inside the block, exactly once (ADR-0003, ADR-0010)', () => {
    const cells = new Set(cellsOfBlock(fixture.block));
    expect(features.every((f) => cells.has(f.anchorCell))).toBe(true);
    expect(new Set(features.map((f) => f.id)).size).toBe(features.length);
  });

  it('every Feature has its geometry Fact', () => {
    const geom = new Set(
      facts
        .filter((f) => ['footprint', 'path', 'position'].includes(f.attribute))
        .map((f) => f.featureId),
    );
    expect(features.every((f) => geom.has(f.id))).toBe(true);
  });

  it('splits roads into node-pair segments', () => {
    const roads = features.filter((f) => f.kind === 'road');
    expect(roads.length).toBeGreaterThan(50);
    expect(roads.every((r) => /^osm:w\d+:n\d+-n\d+$/.test(r.id))).toBe(true);
  });

  it('is deterministic', () => {
    expect(osmToFacts(fixture, { block: fixture.block, observedAt })).toEqual({ features, facts });
  });
});

describe('landcover relations (multipolygons)', () => {
  const centre = { lat: 47.3769, lng: 8.5417 };
  const block = ingestBlockOf(cellAt(centre.lat, centre.lng));
  const g = (lat: number, lon: number) => ({ lat, lon });
  // A square ring around the centre, split into three member ways.
  const sw = g(centre.lat - 0.002, centre.lng - 0.002);
  const se = g(centre.lat - 0.002, centre.lng + 0.002);
  const ne = g(centre.lat + 0.002, centre.lng + 0.002);
  const nw = g(centre.lat + 0.002, centre.lng - 0.002);
  const relation = (members: object[], id = 9001) => ({
    elements: [
      {
        type: 'relation',
        id,
        tags: { type: 'multipolygon', landuse: 'forest', name: 'Test Wood' },
        members,
      },
    ],
  });
  const outer = (geometry: { lat: number; lon: number }[], role = 'outer') => ({
    type: 'way',
    ref: 1,
    role,
    geometry,
  });

  it('stitches out-of-order, reversed member ways into one closed ring', () => {
    const res = relation([
      outer([ne, nw, sw]), // top + left edges, ends at sw
      outer([se, sw]), // bottom edge, reversed
      outer([se, ne]), // right edge
      outer([g(centre.lat, centre.lng), g(centre.lat + 0.0005, centre.lng)], 'inner'),
    ]) as OverpassResponse;
    const { features, facts } = osmToFacts(res, { block, observedAt });
    const covers = features.filter((f) => f.kind === 'landcover');
    expect(covers.map((f) => f.id)).toEqual(['osm:r9001']);
    const fp = facts.find((f) => f.featureId === 'osm:r9001' && f.attribute === 'footprint');
    const ring = fp!.value as [number, number][];
    expect(ring.length).toBe(5); // closed: last repeats first
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(facts.some((f) => f.attribute === 'landcover' && f.value === 'forest')).toBe(true);
  });

  it('is deterministic under member shuffling', () => {
    const a = osmToFacts(
      relation([outer([ne, nw, sw]), outer([se, sw]), outer([se, ne])]) as OverpassResponse,
      { block, observedAt },
    );
    const b = osmToFacts(
      relation([outer([se, ne]), outer([ne, nw, sw]), outer([se, sw])]) as OverpassResponse,
      { block, observedAt },
    );
    expect(b).toEqual(a);
  });

  it('gives each outer ring of a multi-outer relation its own Feature', () => {
    // Both squares sit well inside the block (positions from its bbox), so
    // both centroids pass the anchor gate.
    const bb = blockBBox(block);
    const at = (fx: number, fy: number) => ({
      lat: bb.south + (bb.north - bb.south) * fy,
      lng: bb.west + (bb.east - bb.west) * fx,
    });
    const sq = (lat: number, lng: number) => [
      g(lat, lng),
      g(lat, lng + 0.001),
      g(lat + 0.001, lng + 0.001),
      g(lat + 0.001, lng),
      g(lat, lng),
    ];
    const a = at(0.25, 0.25);
    const b = at(0.65, 0.65);
    const res = relation(
      [outer(sq(a.lat, a.lng)), outer(sq(b.lat, b.lng))],
      9002,
    ) as OverpassResponse;
    const { features } = osmToFacts(res, { block, observedAt });
    expect(features.map((f) => f.id).sort()).toEqual(['osm:r9002', 'osm:r9002:o2']);
  });

  it('the query asks for landcover relations, not just ways', () => {
    const q = overpassQuery(blockBBox(block));
    expect(q).toContain('relation["landuse"="forest"]');
    expect(q).toContain('relation["natural"="wood"]');
  });

  it('stitchRings drops chains that never close', () => {
    expect(
      stitchRings([
        [
          [0, 0],
          [1, 0],
        ],
        [
          [2, 0],
          [3, 0],
        ],
      ]),
    ).toEqual([]);
  });
});

describe('fetchOverpass', () => {
  it('falls back to the next endpoint on failure and sends a User-Agent', async () => {
    const calls: string[] = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^Otherhere\//);
      if (calls.length === 1) return new Response('busy', { status: 429 });
      return Response.json({ elements: [] });
    };
    const res = await fetchOverpass(overpassQuery(blockBBox(fixture.block)), {
      fetch: fake,
      endpoints: ['a', 'b'],
    });
    expect(res.elements).toEqual([]);
    expect(calls).toEqual(['a', 'b']);
  });
  it('throws with every error when all endpoints fail', async () => {
    const fake = async () => new Response('', { status: 504 });
    await expect(fetchOverpass('q', { fetch: fake, endpoints: ['a', 'b'] })).rejects.toThrow(
      /a: HTTP 504; b: HTTP 504/,
    );
  });
});
