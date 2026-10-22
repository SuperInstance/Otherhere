import { describe, expect, it } from 'vitest';
import { gradeCrown, MIN_PRED_PX, PAIR_DT, type CrownFrame, type CrownPrediction } from '../src/crown-law';

/**
 * The crown-law unit tests of #85: the law must reject a crown that sways the
 * wrong way, not at all, or at half amplitude — corruptions the magnitude-only
 * form of the law (everything it graded was `hypot`, direction-blind) let
 * through. Every dataset here is pixel-space, shaped like the instrument's
 * real recordings: the demo's probe camera puts along-wind sway on screen-u,
 * and screen-v is predicted exactly still by geometry, carrying only the apex
 * band's mask quantization (measured at ≤ 2.33 px on the real shader).
 *
 * A corrupted crown is one whose sway trajectory is scaled by a factor k
 * around the same centre — k = −1 sways the wrong way, k = 0 is frozen,
 * k = 0.5 half amplitude — which is exactly the family of shader bugs the
 * law exists to catch. The faithful dataset's noise is calibrated to the real
 * shader's measured spread (0.23–0.32 px along-wind across a hundred pairs),
 * so a green run here means the law catches the corruptions without
 * rejecting the truth.
 */

/** Deterministic small noise, so failures print reproducible numbers. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2; // −1..1
}

/** Frame times like the instrument's: ~6 fps under software GL. */
const STEP = 0.17;
const N = 40;
/** Frames per pairing window (0.51 s ≥ PAIR_DT). */
const WIN = 3;

/** One dataset: predictions in pixel space, and readings derived from them. */
type Dataset = {
  frames: CrownFrame[];
  pred: CrownPrediction[];
};

/** A crown whose sway scales by `k` (1 faithful, −1 reversed, 0 frozen, 0.5
 * half), with the real shader's measured noise (0.23–0.32 px along-wind; the
 * apex band's v quantization measured at 2.33 px pairwise, so ±1.1 per
 * reading), optionally drifting down-screen. */
function crown(
  uPred: (t: number) => number,
  k = 1,
  vDrift = 0,
): Dataset {
  const frames: CrownFrame[] = [];
  const pred: CrownPrediction[] = [];
  for (let i = 0; i < N; i++) {
    const t = i * STEP;
    pred.push({ u: uPred(t), v: 128 });
    frames.push({
      t,
      strength: 0.5,
      u: 128 + k * (uPred(t) - 128) + 0.25 * noise(i + 1),
      v: 128 + vDrift * t + 1.1 * noise(i + 51),
    });
  }
  return { frames, pred };
}

/** The qualifying-pair count, for the coverage assertions. */
function qualifying(ds: Dataset): number {
  return gradeCrown(ds.frames, ds.pred).pairs.length;
}

describe('the crown-motion law (#66, #85)', () => {
  it('holds for a crown that sways as the spec says', () => {
    const ds = crown((t) => 128 + 7 * Math.sin(0.8 * t));
    expect(qualifying(ds)).toBeGreaterThanOrEqual(6);
    expect(gradeCrown(ds.frames, ds.pred).rejections).toEqual([]);
  });

  it('holds at the real shader noise, hemlock-shaped (bigger sway)', () => {
    const ds = crown((t) => 128 + 11 * Math.sin(0.6 * t) + 2 * Math.sin(1.7 * t));
    expect(qualifying(ds)).toBeGreaterThanOrEqual(6);
    expect(gradeCrown(ds.frames, ds.pred).rejections).toEqual([]);
  });

  it('rejects a crown that sways the wrong way (the #85 headline)', () => {
    // Trajectory mirrored: every displacement sign-flipped, magnitudes
    // untouched — the exact crown the old, direction-blind law passed.
    const ds = crown((t) => 128 + 7 * Math.sin(0.8 * t), -1);
    expect(qualifying(ds)).toBeGreaterThanOrEqual(6);
    const v = gradeCrown(ds.frames, ds.pred);
    expect(v.rejections.length).toBeGreaterThan(0);
  });

  it('rejects a frozen crown while the prediction moves inside the old band', () => {
    // A wind whose every window predicts ~1.55 px: small, but qualifying
    // motion — and the crown does not move at all. Each window's error is
    // 1.55 px against a 1.59 px band, so the per-pair check alone would
    // pass it; only the aggregate refuses.
    const slope = (MIN_PRED_PX + 0.05) / (WIN * STEP);
    const ds = crown((t) => 128 + slope * t, 0);
    expect(qualifying(ds)).toBeGreaterThanOrEqual(6);
    const v = gradeCrown(ds.frames, ds.pred);
    expect(v.rejections.length).toBeGreaterThan(0);
  });

  it('rejects a frozen crown outfighting the band too (the gross case)', () => {
    const ds = crown((t) => 128 + 8 * Math.sin(0.8 * t), 0);
    expect(gradeCrown(ds.frames, ds.pred).rejections.length).toBeGreaterThan(0);
  });

  it('rejects a crown at half amplitude', () => {
    // Each window's prediction is 3.0 px and the crown delivers half: the
    // error is 1.5 px against a 1.95 px band, so the per-pair check alone
    // would pass it — the aggregate is what refuses.
    const slope = 3 / (WIN * STEP);
    const ds = crown((t) => 128 + slope * t, 0.5);
    expect(qualifying(ds)).toBeGreaterThanOrEqual(6);
    const v = gradeCrown(ds.frames, ds.pred);
    expect(v.rejections.length).toBeGreaterThan(0);
  });

  it('rejects a mask that walks off the crown (cross-axis drift)', () => {
    // The reading drifts down-screen 12 px/s while the sway is faithful: the
    // apex band has latched onto something that is not the apex.
    const ds = crown((t) => 128 + 7 * Math.sin(0.8 * t), 1, 12);
    expect(gradeCrown(ds.frames, ds.pred).rejections.length).toBeGreaterThan(0);
  });

  it('refuses to grade when the prediction never rises above the mask', () => {
    const ds = crown((t) => 128 + 0.5 * Math.sin(0.8 * t));
    const v = gradeCrown(ds.frames, ds.pred);
    expect(v.pairs.length).toBe(0);
    expect(v.rejections.length).toBeGreaterThan(0); // "the crown barely moved"
  });

  it('pairs readings across at least PAIR_DT of wind clock', () => {
    const ds = crown((t) => 128 + 7 * Math.sin(0.8 * t));
    const ts = ds.frames.map((f) => f.t);
    for (const p of gradeCrown(ds.frames, ds.pred).pairs) {
      expect(p.j).toBeGreaterThan(p.i);
      expect(ts[p.j]! - ts[p.i]!).toBeGreaterThanOrEqual(PAIR_DT - 1e-9);
    }
  });
});
