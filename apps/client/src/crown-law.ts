/**
 * The crown-motion law of #66/#85, as pure maths: given the instrument's
 * recorded apex readings and the wind spec's predicted positions for the same
 * frame times, decide whether the crown really moved by what `swayOffset`
 * says — in distance, in direction and in amplitude.
 *
 * The demo's probe camera looks across the wind (forest-demo.ts), so the
 * along-wind sway lands fully on screen-u (with the axis sign flipped by the
 * camera's framing — the law never assumes which sign, it compares measured
 * against predicted on the same axis). Screen-v carries no first-order sway
 * signal: the cross-wind term runs along the view axis, so v is predicted
 * near-still and only mask noise moves it. That geometry is what makes a
 * signed per-axis comparison the honest form of the law: until #85 it graded
 * only `hypot` magnitudes, so a crown that swayed the wrong way, at half
 * amplitude, or not at all (while the prediction moved under 1.6 px) passed.
 *
 * The law is a verdict, not an assertion: the e2e maps an empty `rejections`
 * list to a pass, and the unit tests feed it corrupted readings — a sign
 * flip, a freeze, a half-amplitude crown — and demand the matching
 * rejection. No three.js, no Playwright: this module grades, it does not
 * render and does not pass its own test.
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

/** One graded pair of readings: everything the law knows about one window. */
export type CrownPair = {
  /** Index of the window's first frame. */
  i: number;
  /** Index of the window's second frame. */
  j: number;
  /** Seconds of wind clock between the two readings. */
  dt: number;
  /** Signed along-axis (screen-u) displacement, predicted and measured, px. */
  duPred: number;
  duMeas: number;
  /** Cross-axis (screen-v) displacement, predicted and measured, px. */
  dvPred: number;
  dvMeas: number;
  /** |measured − predicted| per axis, px. */
  duErr: number;
  dvErr: number;
  /** The noise band the u error must fit in, px. */
  band: number;
  /** The u error fits its band and the v error fits the flat mask-health bound. */
  withinBand: boolean;
};

export type CrownVerdict = {
  /** The qualifying pairs the law graded (|duPred| at or above MIN_PRED_PX). */
  pairs: CrownPair[];
  /** The least-squares scale of measured on predicted along-wind displacement:
   * 1 is the spec's amplitude, −1 a sign flip, 0 a frozen crown, 0.5 half
   * amplitude. Null when no pair qualified. */
  scale: number | null;
  /** Human-readable violations; empty means the law holds. */
  rejections: string[];
};

/** Pairs are read at least this far apart in wind clock, so a window's
 * displacement is the same whatever the frame rate (SwiftShader's 6 fps and
 * CI's 60 differ a dozen-fold) and the pixel noise stays absolutely bounded
 * while the signal spans several pixels. */
export const PAIR_DT = 0.5;

/** A pair whose predicted along-wind motion is under this (px) is not a fair
 * fight for a pixel mask, so the law skips it — the aggregate scale over all
 * pairs is what catches a crown that never rises above it. */
export const MIN_PRED_PX = 1.5;

/** The per-axis noise band on the along-wind displacement: a pixel of mask
 * noise plus a quarter of the motion (measured across runs in #66: local
 * spruce 1.26 px at ~2 px, production spruce 0.52 px, CI hemlock 1.50 px at
 * 2.41 px — and, on the signed axis #85 measured locally, 0.23 px spruce /
 * 0.32 px hemlock across a hundred pairs). */
export const BAND_BASE = 1.2;
export const BAND_SLOPE = 0.25;

/** The cross-axis (screen-v) mask-health bound, px, flat. The prediction on
 * that axis is exactly zero by geometry — a level camera watching a purely
 * horizontal displacement keeps the apex on the horizon line through the
 * principal point — so v carries no sway signal at all, only the apex band's
 * row quantization (measured: 2.33 px max on both species, local). The bound
 * exists to catch a mask that walks off the crown: a lost crown, a wrong-row
 * order or a band latched onto a branch reads tens of pixels. */
export const V_DRIFT = 3.0;

/** Fewer qualifying pairs than this and the law refuses to grade: that is
 * what a broken wind feed or a zeroed shader term looks like. */
export const MIN_QUALIFYING = 6;

/** Where the aggregate scale must sit: outside this the crown sways the wrong
 * way, not at all, or at the wrong amplitude systematically. The margin is
 * wide on purpose — the per-pair band already binds each window tightly;
 * this catches what survives it. Measured on the real shader: 0.984 (spruce)
 * and 0.990 (hemlock) over ~50 pairs each; the corruptions it must catch sit
 * at −1 (sign flip), 0 (frozen) and 0.5 (half amplitude), all far outside. */
export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.3;

/**
 * Grade the readings against the predictions. Frames and predictions are
 * parallel arrays (one prediction per frame time, from `predictTip`).
 */
export function gradeCrown(
  frames: CrownFrame[],
  pred: CrownPrediction[],
): CrownVerdict {
  const pairs: CrownPair[] = [];
  // Pair readings by elapsed time, not adjacency — the same windows whatever
  // the frame rate. A frame may open several windows (the ends overlap);
  // each window is graded on its own displacement, and the aggregate scale
  // below is what makes the overlap harmless.
  let j = 0;
  for (let i = 0; i < frames.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < frames.length && frames[j]!.t - frames[i]!.t < PAIR_DT) j++;
    if (j >= frames.length) break;
    const a = frames[i]!;
    const b = frames[j]!;
    const pa = pred[i]!;
    const pb = pred[j]!;
    const duPred = pb.u - pa.u;
    if (Math.abs(duPred) < MIN_PRED_PX) continue; // sub-pixel: skip, not grade
    const duMeas = b.u - a.u;
    const dvPred = pb.v - pa.v;
    const dvMeas = b.v - a.v;
    const duErr = Math.abs(duMeas - duPred);
    const dvErr = Math.abs(dvMeas - dvPred);
    const band = BAND_BASE + BAND_SLOPE * Math.abs(duPred);
    pairs.push({
      i,
      j,
      dt: b.t - a.t,
      duPred,
      duMeas,
      dvPred,
      dvMeas,
      duErr,
      dvErr,
      band,
      withinBand: duErr <= band && dvErr <= V_DRIFT,
    });
  }

  const rejections: string[] = [];
  if (pairs.length < MIN_QUALIFYING) {
    rejections.push(
      `only ${pairs.length} qualifying pairs in ${frames.length} frames — the crown barely moved`,
    );
  }
  for (const p of pairs) {
    if (p.duErr > p.band) {
      rejections.push(
        `frame ${p.i}: along-wind measured ${p.duMeas.toFixed(2)} px vs predicted ${p.duPred.toFixed(2)} px (band ${p.band.toFixed(2)} px)`,
      );
    }
    if (p.dvErr > V_DRIFT) {
      rejections.push(
        `frame ${p.i}: cross-axis moved ${p.dvMeas.toFixed(2)} px where ${p.dvPred.toFixed(2)} px was predicted (mask-health bound ${V_DRIFT} px)`,
      );
    }
  }

  let scale: number | null = null;
  if (pairs.length > 0) {
    let xy = 0;
    let xx = 0;
    for (const p of pairs) {
      xy += p.duPred * p.duMeas;
      xx += p.duPred * p.duPred;
    }
    scale = xx > 0 ? xy / xx : null;
    if (scale !== null && (scale < SCALE_MIN || scale > SCALE_MAX)) {
      rejections.push(
        `the crown's along-wind motion scales at ${scale.toFixed(3)} of the spec (law: ${SCALE_MIN}..${SCALE_MAX}) — wrong direction, frozen, or wrong amplitude`,
      );
    }
  }
  return { pairs, scale, rejections };
}
