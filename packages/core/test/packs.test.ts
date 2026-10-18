import { describe, expect, it } from 'vitest';
import { BUILDING_PACK, buildingFacts } from '../src/packs/building';
import { Fact } from '../src/schema/fact';

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
    expect(facts.map((f) => [f.attribute, f.value, f.confidence])).toEqual([
      ['roof.shape', 'gable', 0.9],
      ['levels', 7, 0.72],
      ['colour', '#a5543f', 0.63],
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
