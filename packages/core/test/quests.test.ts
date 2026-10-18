import { describe, expect, it } from 'vitest';
import { questsFor, type ResolvedAttrs } from '../src/index';

const osm = (value: unknown) => ({ value, confidence: 0.8, source: 'osm' as const });
const b = (id: string, attrs: ResolvedAttrs = {}) => ({ id, attrs });

describe('questsFor', () => {
  it('asks only for what is not known, and nothing for a fully known building', () => {
    const qs = questsFor('c', [
      b('osm:w1', { 'roof.shape': osm('gable'), height: osm(9), colour: osm('#aa0000') }),
      b('osm:w2', { height: osm(12) }),
    ]);
    expect(qs).toEqual([
      {
        id: 'photo:osm:w2',
        featureId: 'osm:w2',
        cell: 'c',
        ask: ['roof.shape', 'colour'],
        reason: 'unknown',
      },
    ]);
  });

  it('puts unsure buildings first and caps the count, deterministically', () => {
    const many = Array.from({ length: 20 }, (_, i) => b(`osm:w${i}`));
    const first = questsFor('c', many, new Set(['osm:w7']));
    expect(first).toHaveLength(3);
    expect(first[0]).toMatchObject({ featureId: 'osm:w7', reason: 'unsure' });
    expect(questsFor('c', [...many].reverse(), new Set(['osm:w7']))).toEqual(first);
  });

  it('keeps an unsure building as a quest even when OSM knows everything', () => {
    const full = { 'roof.shape': osm('flat'), levels: osm(3), colour: osm('#ffffff') };
    expect(questsFor('c', [b('osm:w1', full)], new Set(['osm:w1']))[0]).toMatchObject({
      reason: 'unsure',
      ask: ['roof.shape', 'levels', 'colour'],
    });
  });
});
