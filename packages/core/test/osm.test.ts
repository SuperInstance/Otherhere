import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmToFacts, parseColour, parseMetres } from '../src/osm/to-facts';
import { fetchOverpass, overpassQuery, type OverpassResponse } from '../src/osm/overpass';
import { Fact } from '../src/schema/fact';
import { Feature } from '../src/schema/feature';
import { cellsOfBlock, blockBBox } from '../src/geo/h3';

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
