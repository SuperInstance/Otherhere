/** Jev's direct-image path accepts an image when every side is in this range, at any aspect (measured 2026-10-18). */
export const JEV_IMAGE_SIDE = { min: 280, max: 1568 } as const;

/**
 * The smallest change that makes a `width`×`height` image acceptable to Jev:
 * scale it so every side fits {@link JEV_IMAGE_SIDE}, centre-cropping the long
 * side first only if the image is more elongated than max/min (5.6:1).
 */
export function fitForJev(
  width: number,
  height: number,
): { crop: { width: number; height: number }; width: number; height: number } {
  const { min, max } = JEV_IMAGE_SIDE;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const keptLong = Math.min(long, Math.floor((short * max) / min));
  const crop = width >= height ? { width: keptLong, height } : { width, height: keptLong };
  let k = 1;
  if (short < min) k = min / short;
  if (keptLong * k > max) k = max / keptLong;
  const fit = (n: number) => Math.min(max, Math.max(min, Math.round(n * k)));
  return { crop, width: fit(crop.width), height: fit(crop.height) };
}
