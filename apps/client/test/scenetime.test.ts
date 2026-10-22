import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Importing ocean registers its scene phases; importing atmosphere gives the
// clock. The order does not matter, only that both modules have loaded.
import '../src/ocean';
import { feedSceneClock, scenePhaseState } from '../src/atmosphere';

const TAU = Math.PI * 2;
const wrap = (x: number) => ((x % TAU) + TAU) % TAU;

describe('the scene clock the shader sees (review P1 #6)', () => {
  it('wraps every scene sine phase, however long the session runs', () => {
    // sceneTimeU itself was never wrapped: after hours of a live day the
    // direct sines read arguments past 1e5 rad, where float32 steps reach
    // ~0.008 s of clock. Each term now carries its own wrapped phase.
    const t = 1e5 + 123.4; // ~28 hours of sky
    feedSceneClock(t);
    const phases = scenePhaseState();
    expect(phases.length).toBeGreaterThanOrEqual(7); // twinkle, 4 waves, foam, 2 streaks
    for (const { name, phase, rate } of phases) {
      expect(phase, `${name} in [0, TAU)`).toBeGreaterThanOrEqual(0);
      expect(phase, `${name} in [0, TAU)`).toBeLessThan(TAU);
      expect(phase, `${name} is the wrapped t*rate`).toBeCloseTo(wrap(t * rate), 12);
    }
  });

  it('keeps the phases continuous: a small step moves each phase by its rate times the step', () => {
    feedSceneClock(5000);
    const before = scenePhaseState();
    feedSceneClock(5000.016); // one 60 fps frame
    for (const { name, phase, rate } of scenePhaseState()) {
      const b = before.find((p) => p.name === name)!;
      const moved = wrap(phase - b.phase);
      expect(moved, name).toBeCloseTo(wrap(rate * 0.016), 9);
    }
  });
});

describe('the wrap cannot silently regress (source scan)', () => {
  it('no sine or cosine reads a raw clock uniform', () => {
    for (const f of ['atmosphere.ts', 'ocean.ts'] as const) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      expect(src.match(/\b(?:sin|cos)\(\s*sceneTimeU\.mul\(/), f).toBeNull();
    }
    const forest = readFileSync(new URL('../src/forest.ts', import.meta.url), 'utf8');
    expect(forest.match(/\bwindTimeU\b/)).toBeNull(); // the unwrapped clock is gone
  });
});
