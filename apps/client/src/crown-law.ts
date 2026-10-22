/**
 * The crown-motion law of #66, extracted from crown.spec.ts so it can be
 * unit-tested: given the instrument's recorded apex readings and the wind
 * spec's predicted positions for the same frame times, decide whether the
 * crown moved by what `swayOffset` says. This module is the law exactly as
 * the e2e ran it — pure maths, no three.js, no Playwright.
 *
 * EXTRACTED VERBATIM (no behavior change): pairs readings at ≥0.5 s of wind
 * clock, skips pairs the spec predicts as sub-pixel, and grades the measured
 * against the predicted displacement magnitude within a pixel-noise band.
 */

/** One recorded frame: the wind the shader saw, and where the apex read. */
export type CrownFrame = {
  /** The wrapped wind clock the shader rendered this frame with. */
  t: number;
  /** The strength uniform the shader rendered this frame with. */
  strength: number;
  /** The apex reading in readback pixels (u right, v down). */
  u: number;
  v: number;
};

/** The spec's predicted apex position for one frame time, in the same pixels. */
export type CrownPrediction = { u: number; v: number };

/** One graded pair of readings. */
export type CrownPair = {
  /** Index of the window's first frame. */
  i: number;
  /** Index of the window's second frame. */
  j: number;
  /** Seconds of wind clock between the two readings. */
  dt: number;
  /** Predicted displacement magnitude, px. */
  pred: number;
  /** Measured displacement magnitude, px. */
  meas: number;
  /** |measured − predicted|, px. */
  err: number;
  /** The noise band this pair must fit in, px. */
  band: number;
  /** The pair fits its band. */
  withinBand: boolean;
};

export type CrownVerdict = {
  /** The qualifying pairs the law graded. */
  pairs: CrownPair[];
  /** Human-readable violations; empty means the law holds. */
  rejections: string[];
};

/** Pairs are read at least this far apart in wind clock. */
export const PAIR_DT = 0.5;
/** A predicted motion under this (px) is not a fair fight for a pixel mask. */
export const MIN_PRED_PX = 1.5;
/** The noise band: a pixel of mask noise plus a quarter of the motion. */
export const BAND_BASE = 1.2;
export const BAND_SLOPE = 0.25;
/** Fewer qualifying pairs than this and the law refuses to grade. */
export const MIN_QUALIFYING = 6;

/**
 * Grade the readings against the predictions. Frames and predictions are
 * parallel arrays (one prediction per frame time, from `predictTip`).
 */
export function gradeCrown(
  frames: CrownFrame[],
  pred: CrownPrediction[],
): CrownVerdict {
  const pairs: CrownPair[] = [];
  let j = 0;
  for (let i = 0; i < frames.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < frames.length && frames[j]!.t - frames[i]!.t < PAIR_DT) j++;
    if (j >= frames.length) break;
    const a = frames[i]!;
    const b = frames[j]!;
    const pa = pred[i]!;
    const pb = pred[j]!;
    const p = Math.hypot(pb.u - pa.u, pb.v - pa.v);
    if (p < MIN_PRED_PX) continue;
    const meas = Math.hypot(b.u - a.u, b.v - a.v);
    const band = BAND_BASE + BAND_SLOPE * p;
    pairs.push({
      i,
      j,
      dt: b.t - a.t,
      pred: p,
      meas,
      err: Math.abs(meas - p),
      band,
      withinBand: Math.abs(meas - p) <= band,
    });
  }

  const rejections: string[] = [];
  if (pairs.length < MIN_QUALIFYING) {
    rejections.push(
      `only ${pairs.length} qualifying pairs in ${frames.length} frames — the crown barely moved`,
    );
  }
  for (const p of pairs) {
    if (!p.withinBand) {
      rejections.push(
        `frame ${p.i}: measured ${p.meas.toFixed(2)} px vs predicted ${p.pred.toFixed(2)} px (band ${p.band.toFixed(2)} px)`,
      );
    }
  }
  return { pairs, rejections };
}
