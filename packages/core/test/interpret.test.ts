import { describe, expect, it } from 'vitest';
import { evalExpr, runGenerator, IMAGINED } from '../src/geometry/interpret';
import { MeshBuilder } from '../src/geometry/mesh';
import { roof } from '../src/geometry/shapes';
import { cleanRing } from '../src/geometry/polygon';
import { localFrame } from '../src/geo/frame';
import { cellCenter } from '../src/geo/h3';
import { demoLot, DEMO_CELL } from '../src/demo/lot';
import { generatorSet } from '../src/generators';
import type { Expr } from '../src/schema/generator';

const feature = (attrs = {}) => ({ id: 'osm:w1', attrs });
const ev = (e: Expr, attrs = {}) => evalExpr(e, { feature: feature(attrs), env: new Map() });
const fact = (value: unknown, confidence = 0.8) => ({ value, confidence, source: 'osm' as const });

describe('expression confidence', () => {
  it('literals are neutral, facts carry their confidence, guesses are imagined', () => {
    expect(ev(3)).toEqual({ v: 3, c: 1 });
    expect(ev({ attr: 'height' }, { height: fact(12, 0.8) })).toEqual({ v: 12, c: 0.8 });
    expect(ev({ attr: 'height', default: 9 })).toEqual({ v: 9, c: IMAGINED });
    expect(ev({ op: 'rand', min: 0, max: 1, key: 'k' }).c).toBe(IMAGINED);
  });
  it('arithmetic takes the minimum confidence of its inputs', () => {
    const r = ev({ op: 'mul', args: [{ attr: 'levels' }, 3] }, { levels: fact(4, 0.6) });
    expect(r).toEqual({ v: 12, c: 0.6 });
  });
  it('missing attrs without defaults are null, and null propagates', () => {
    expect(ev({ op: 'add', args: [{ attr: 'nope' }, 1] }).v).toBeNull();
  });
  it('rand and pick are seeded by Feature ID + key', () => {
    const a = ev({ op: 'pick', options: ['a', 'b', 'c', 'd'], key: 'x' });
    const b = ev({ op: 'pick', options: ['a', 'b', 'c', 'd'], key: 'x' });
    expect(a).toEqual(b);
  });
  it('if: `has` checks are certain, so the branch decides confidence', () => {
    const e: Expr = {
      op: 'if',
      cond: { op: 'has', attr: 'height' },
      then: { attr: 'height' },
      else: 0,
    };
    expect(ev(e)).toEqual({ v: 0, c: 1 });
    expect(ev(e, { height: fact(5, 0.7) })).toEqual({ v: 5, c: 0.7 });
  });
});

describe('runGenerator', () => {
  const frame = localFrame(cellCenter(DEMO_CELL));
  const gens = generatorSet();
  const building = gens.forKind('building')!;

  const shapeConfidences = (id: string) => {
    const f = demoLot().find((x) => x.id === id)!;
    const m = new MeshBuilder();
    runGenerator(building, f, frame, m);
    const conf = m.build().confidence;
    const shape = new Set<number>();
    for (let i = 0; i < conf.length; i += 2) shape.add(Math.round(conf[i]! * 1000) / 1000);
    return [...shape].sort();
  };

  it('known buildings are crisper than imagined ones (soft until sure)', () => {
    // Known height: walls are as sure as the footprint (0.7); windows are imagined.
    expect(shapeConfidences('osm:w100')).toEqual([IMAGINED, 0.7]);
    // Outline only: walls and roof are imagined.
    expect(Math.max(...shapeConfidences('osm:w200'))).toBe(IMAGINED);
  });

  it('skips Features without the geometry the generator needs', () => {
    expect(
      runGenerator(building, { id: 'osm:w9', attrs: {} }, frame, new MeshBuilder()),
    ).toBeNull();
  });
});

describe('roofs', () => {
  const rect = cleanRing([
    { e: 0, n: 0 },
    { e: 10, n: 0 },
    { e: 10, n: 6 },
    { e: 0, n: 6 },
  ]);
  const L = cleanRing([
    { e: 0, n: 0 },
    { e: 20, n: 0 },
    { e: 20, n: 20 },
    { e: 10, n: 20 },
    { e: 10, n: 10 },
    { e: 0, n: 10 },
  ]);
  for (const shape of ['flat', 'gable', 'hip', 'shed'] as const) {
    it(`builds a ${shape} roof whose peak is at base + rise`, () => {
      const m = new MeshBuilder();
      expect(roof(m, rect, shape, 6, 2, '#000000', '#ffffff', [1, 1])).toBe(shape);
      const pos = m.build().positions;
      let maxY = -Infinity;
      for (let i = 1; i < pos.length; i += 3) maxY = Math.max(maxY, pos[i]!);
      expect(maxY).toBeCloseTo(shape === 'flat' ? 6 : 8, 3);
    });
  }
  it('falls back to flat on non-rectangular footprints', () => {
    expect(roof(new MeshBuilder(), L, 'gable', 6, 2, '#000000', '#ffffff', [1, 1])).toBe('flat');
  });
});
