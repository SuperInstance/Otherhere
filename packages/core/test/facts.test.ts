import { describe, expect, it } from 'vitest';
import { Fact } from '../src/schema/fact';
import { resolveFacts } from '../src/facts/resolve';

const base = {
  featureId: 'osm:w1',
  attribute: 'height',
  observedAt: '2026-01-01T00:00:00Z',
  version: 1,
} as const;

describe('Fact schema', () => {
  it('validates well-known attribute values', () => {
    expect(Fact.safeParse({ ...base, value: 12, source: 'osm', confidence: 0.8 }).success).toBe(
      true,
    );
    expect(Fact.safeParse({ ...base, value: -3, source: 'osm', confidence: 0.8 }).success).toBe(
      false,
    );
    expect(
      Fact.safeParse({
        ...base,
        attribute: 'roof.shape',
        value: 'dome',
        source: 'osm',
        confidence: 1,
      }).success,
    ).toBe(false);
  });
  it('accepts unknown attributes with any JSON value', () => {
    expect(
      Fact.safeParse({
        ...base,
        attribute: 'mood',
        value: { cozy: true },
        source: 'capture',
        confidence: 0.5,
      }).success,
    ).toBe(true);
  });
  it('rejects unknown sources and bad feature IDs', () => {
    expect(Fact.safeParse({ ...base, value: 1, source: 'google', confidence: 1 }).success).toBe(
      false,
    );
    expect(
      Fact.safeParse({ ...base, featureId: 'way/1', value: 1, source: 'osm', confidence: 1 })
        .success,
    ).toBe(false);
  });
});

describe('resolveFacts (invariant 4, ADR-0004)', () => {
  const f = (over: Partial<Fact>): Fact =>
    Fact.parse({ ...base, value: 10, source: 'osm', confidence: 0.5, ...over });

  it('higher source rank wins even with lower confidence', () => {
    const r = resolveFacts([
      f({ value: 10, source: 'capture', confidence: 0.2 }),
      f({ value: 99, source: 'osm', confidence: 0.99 }),
    ]);
    expect(r.get('osm:w1')?.height).toEqual({ value: 10, confidence: 0.2, source: 'capture' });
  });
  it('same rank: higher confidence, then later observation, then version', () => {
    expect(
      resolveFacts([f({ value: 1, confidence: 0.4 }), f({ value: 2, confidence: 0.6 })]).get(
        'osm:w1',
      )?.height?.value,
    ).toBe(2);
    expect(
      resolveFacts([f({ value: 1, observedAt: '2026-02-01T00:00:00Z' }), f({ value: 2 })]).get(
        'osm:w1',
      )?.height?.value,
    ).toBe(1);
    expect(
      resolveFacts([f({ value: 1, version: 3 }), f({ value: 2, version: 2 })]).get('osm:w1')?.height
        ?.value,
    ).toBe(1);
  });
  it('is independent of input order', () => {
    const facts = [
      f({ value: 1, source: 'overture' }),
      f({ value: 2, source: 'manual_edit' }),
      f({ value: 3 }),
    ];
    const a = resolveFacts(facts).get('osm:w1');
    const b = resolveFacts([...facts].reverse()).get('osm:w1');
    expect(a).toEqual(b);
    expect(a?.height?.value).toBe(2);
  });
});
