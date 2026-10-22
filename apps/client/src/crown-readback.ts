/**
 * The crown-region readback of #66: pure pixel analysis, no three, so the law
 * it feeds can be unit-tested to death. Given an RGBA framebuffer of a scene
 * whose only moving thing is one crown against a flat background, it finds the
 * crown's apex — the top of the silhouette — as a sub-pixel centroid of the
 * topmost band of crown-coloured pixels.
 *
 * Why the top band and not the whole silhouette: the sway offsets grow from 0
 * at the root to the flex at the tip, so the whole-silhouette centroid moves by
 * the area-weighted mean flex — a modelling step that can drift. The topmost
 * pixels belong to the apex vertex, whose world displacement is exactly what
 * `swayOffset` predicts for the crown-tip flex. Tracking it makes the measured
 * quantity and the predicted one the same quantity.
 */

/** One frame's reading: the apex position in pixels (u right, v down), and how
 *  many crown pixels the mask found (health: a lost crown reads as few). */
export type TipReading = { u: number; v: number; pixels: number };

export type TrackTipOptions = {
  /** Max per-channel difference from the background that still counts as background. */
  threshold?: number;
  /** Below this many crown pixels the frame reads as empty (null). */
  minPixels?: number;
  /** How many rows below the topmost crown row join the centroid band. */
  band?: number;
  /** The buffer's rows run bottom-to-top (WebGL readback order) instead of
   *  top-to-bottom. Readings are always reported in image space (v down). */
  flipY?: boolean;
};

/** Max per-channel difference from the background at one pixel. */
function channelDiff(
  rgba: Uint8Array | Uint8ClampedArray,
  i: number,
  bg: readonly [number, number, number],
): number {
  return Math.max(
    Math.abs(rgba[i]! - bg[0]),
    Math.abs(rgba[i + 1]! - bg[1]),
    Math.abs(rgba[i + 2]! - bg[2]),
  );
}

/**
 * The background as the framebuffer actually wrote it: the mean of small
 * squares at the four corners, which in the forest demo's framing are always
 * background (the crown is centred). Measuring instead of assuming keeps the
 * mask safe from whatever colour transform the render pipeline applied on its
 * way to the target.
 */
export function cornerBackground(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  inset = 8,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [w - inset, 0],
    [0, h - inset],
    [w - inset, h - inset],
  ];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + inset; y++) {
      for (let x = cx; x < cx + inset; x++) {
        const i = (y * w + x) * 4;
        r += rgba[i]!;
        g += rgba[i + 1]!;
        b += rgba[i + 2]!;
        n++;
      }
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * The crown mask's centroid over the whole frame, in buffer row order. Used
 * once at startup to learn which way the readback buffer's rows run: the demo
 * aims its camera at the apex, so the crown's mass sits clearly to one side of
 * the middle, and which side names the buffer's row order.
 */
export function maskCentroid(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bg: readonly [number, number, number],
  threshold = 24,
): { u: number; v: number; pixels: number } | null {
  let su = 0;
  let sv = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (channelDiff(rgba, (y * w + x) * 4, bg) > threshold) {
        su += x;
        sv += y;
        n++;
      }
    }
  }
  if (n === 0) return null;
  return { u: su / n, v: sv / n, pixels: n };
}

/**
 * Find the crown's apex in an RGBA framebuffer. Pixels count as crown when any
 * channel differs from the flat background by more than the threshold; the
 * reading is the centroid of the crown mask's topmost `band` rows. Returns null
 * when too few crown pixels are in frame — the caller drops the sample.
 *
 * Rows are walked in image order (top down) by default; `flipY` walks the
 * buffer bottom-up instead (the WebGL readback order) while reporting in image
 * space, so callers never think in buffer rows.
 */
export function trackTip(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bg: readonly [number, number, number],
  opts: TrackTipOptions = {},
): TipReading | null {
  const threshold = opts.threshold ?? 24;
  const minPixels = opts.minPixels ?? 40;
  const band = opts.band ?? 2;
  const flip = opts.flipY === true;
  // The image row of buffer row `y`.
  const row = (y: number) => (flip ? h - 1 - y : y);

  // The topmost image row holding a crown pixel: a crown against a flat
  // background has its apex in the first row that differs.
  let topRow = -1;
  let pixels = 0;
  for (let by = 0; by < h && topRow === -1; by++) {
    for (let x = 0; x < w; x++) {
      if (channelDiff(rgba, (row(by) * w + x) * 4, bg) > threshold) {
        topRow = by;
        break;
      }
    }
  }
  if (topRow === -1) return null;

  // Centroid over the whole mask (health count) and over the top band (the apex).
  let su = 0;
  let sv = 0;
  let bandPixels = 0;
  const bandEnd = topRow + 1 + band;
  for (let by = 0; by < h; by++) {
    const inBand = by >= topRow && by < bandEnd;
    for (let x = 0; x < w; x++) {
      if (channelDiff(rgba, (row(by) * w + x) * 4, bg) > threshold) {
        pixels++;
        if (inBand) {
          su += x;
          sv += by;
          bandPixels++;
        }
      }
    }
  }
  if (pixels < minPixels || bandPixels === 0) return null;
  return { u: su / bandPixels, v: sv / bandPixels, pixels };
}
