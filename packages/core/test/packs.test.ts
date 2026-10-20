import { describe, expect, it } from 'vitest';
import { BUILDING_PACK, buildingFacts } from '../src/packs/building';
import {
  PLACE_BATTERY,
  PLACE_PACK,
  placeCensus,
  placeState,
  StoredPlaceVector,
} from '../src/packs/place';
import { computeEssence } from '../src/essence/compute';
import { sha256Hex } from '../src/hash/sha256';
import { Fact } from '../src/schema/fact';
import type { ResolvedAttrs } from '../src/facts/resolve';

const opts = {
  featureId: 'osm:w1',
  source: 'capture' as const,
  observedAt: '2026-10-17T00:00:00.000Z',
};

describe('building pack v1', () => {
  it('is a valid pack with the expected questions', () => {
    expect(Object.keys(BUILDING_PACK.questions).sort()).toEqual([
      'floors',
      'roof_colour',
      'roof_shape',
      'visible',
      'wall_colour',
    ]);
  });

  it('turns confident answers into valid Facts, scaled by visibility', () => {
    const facts = buildingFacts(
      {
        visible: { type: 'noul', noul: 0.9 },
        roof_shape: { type: 'choice', choice: 'gable', confidence: 1 },
        floors: { type: 'choice', choice: '6-8', confidence: 0.8 },
        wall_colour: { type: 'choice', choice: 'brick', confidence: 0.7 },
        roof_colour: { type: 'choice', choice: 'unknown', confidence: 0.9 },
      },
      opts,
    );
    for (const f of facts) Fact.parse(f);
    // Walls (0.7 × 0.9 = 0.63) fall under the bar; the others are kept on their own.
    expect(facts.map((f) => [f.attribute, f.value, f.confidence])).toEqual([
      ['roof.shape', 'gable', 0.9],
      ['levels', 7, 0.72],
    ]);
  });

  it('writes nothing when the observation did not show a building', () => {
    expect(
      buildingFacts(
        {
          visible: { type: 'noul', noul: 0.2 },
          roof_shape: { type: 'choice', choice: 'flat', confidence: 1 },
        },
        opts,
      ),
    ).toEqual([]);
  });
});

/** attrs as a resolved Fact would carry them. */
const res = (value: unknown, confidence = 0.8): ResolvedAttrs[string] => ({
  value,
  confidence,
  source: 'osm',
});

/** An Essence over buildings that carry only a known height. */
const town = (heights: number[]) =>
  computeEssence(
    'town',
    heights.map((h) => ({ kind: 'building' as const, attrs: { height: res(h) } })),
  );

describe('place battery (ADR-0018)', () => {
  it('is the sealed pack: 8 noul and 3 score questions, nothing else', () => {
    expect(PLACE_PACK.id).toBe('pack.place');
    expect(PLACE_BATTERY).toBe('place.v1');
    const byShape = Object.values(PLACE_PACK.questions).map((q) => q.type);
    expect(byShape.filter((t) => t === 'noul')).toHaveLength(8);
    expect(byShape.filter((t) => t === 'score')).toHaveLength(3);
    expect(Object.keys(PLACE_PACK.questions)).toHaveLength(11);
  });

  it('counts a census order-independently, with shares quantized like Essence', () => {
    const building = (i: number): { kind: 'building'; attrs: ResolvedAttrs } => ({
      kind: 'building',
      attrs: i % 2 ? { height: res(7) } : { 'roof.shape': res('gable') },
    });
    const trees = Array.from({ length: 5 }, (_, i) => ({
      kind: 'tree' as const,
      attrs: { species: res(i < 3 ? 'hemlock' : 'spruce', 0.9) },
    }));
    const features = [...Array.from({ length: 9 }, (_, i) => building(i)), ...trees];
    const facts = features.flatMap((f, i) =>
      Object.entries(f.attrs).map(([attribute, r]) => ({
        featureId: `osm:x${i}`,
        attribute,
        value: r.value as Fact['value'],
        source: 'osm' as const,
        confidence: r.confidence,
        observedAt: '2026-10-19T00:00:00.000Z',
        version: 1,
      })),
    );
    const a = placeCensus(features, facts);
    // Same inputs in reverse order: the census is a pure function of the multiset.
    expect(placeCensus([...features].reverse(), [...facts].reverse())).toEqual(a);
    expect(a.featuresByKind).toEqual({ building: 5, tree: 5 }); // 9 and 5, bucketed like Essence
    expect(a.known).toEqual({ height: 0.45, roof: 0.55, colour: 0 }); // 4/9 and 5/9 → 0.05 steps
    expect(a.knownSpecies).toBe(1);
    expect(a.factsBySource).toEqual({ osm: 10 }); // 14 facts, bucketed
  });

  it('serializes the state deterministically, and only the statistics move it', async () => {
    const essence = town([13.4, 13.6, 19.4, 19.6, 5, 6, 7]);
    const census = placeCensus(
      [
        ...Array.from({ length: 7 }, () => ({ kind: 'building' as const, attrs: {} })),
        { kind: 'bench' as const, attrs: {} },
      ],
      [],
    );
    const state = placeState(essence, census);
    expect(state).toContain('median 13.5 m, upper decile 19.5 m, 5 known heights');
    expect(state).toContain('known shares: building height 0.00, roof shape 0.00');
    expect(state).toContain('features: bench 1, building 5');
    expect(state).toContain('wall colours: none recorded');
    // The same statistics in different construction order are the same bytes.
    const again = placeState(
      town([7, 6, 5, 19.6, 19.4, 13.6, 13.4]),
      placeCensus(
        [
          { kind: 'bench' as const, attrs: {} },
          ...Array.from({ length: 7 }, () => ({ kind: 'building' as const, attrs: {} })),
        ],
        [],
      ),
    );
    expect(again).toBe(state);
    // A different statistic is a different state (and so a different sha to seal).
    const taller = placeState(town([30, 31, 32, 33, 34]), census);
    expect(await sha256Hex(taller)).not.toBe(await sha256Hex(state));
  });

  it('stores vectors with their battery, pin, canary, state sha and time', () => {
    const v = StoredPlaceVector.parse({
      battery: 'place.v1',
      model: 'jev-1.13.0',
      served: 'jev-1.13.0',
      stateSha: 'a'.repeat(64),
      vector: { tall_for_a_town: 0.23 },
      at: '2026-10-20T03:55:03.536Z',
    });
    expect(v.battery).toBe('place.v1');
    expect(StoredPlaceVector.safeParse({ battery: 'place.v1' }).success).toBe(false);
  });
});
