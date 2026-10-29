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

/**
 * The fit for one image that has to satisfy **both** tiers at once: legal for Jev,
 * and cheap enough for a local model.
 *
 * The two bounds pull in opposite directions on a wide frame. A local model's cost
 * grows with pixels, so the local tier wants a small long side; Jev refuses any
 * image whose every side is under {@link JEV_IMAGE_SIDE}.min, so shrinking a
 * panorama to the local cap can push its short side under the floor. Sizing by the
 * long side alone silently produced an image the cloud refuses — HTTP 400 "Invalid
 * image dimensions" — which on the 2026-10-28 photo eval cost the cloud arm five
 * labelled answers for a reason that had nothing to do with the model.
 *
 * So this **raises the long side** when the short side would otherwise fall under
 * the floor, and crops only when the frame is more elongated than Jev allows
 * (past max/min). The frame is never cropped to satisfy the local cap.
 *
 * `cap` is the target long side for an ordinary frame. A frame too wide for the
 * floor at that cap comes back slightly larger than `cap` — the floor wins, because
 * an image the cloud refuses is worth nothing to anyone.
 */
export function fitForShared(
  width: number,
  height: number,
  cap = 512,
): { width: number; height: number } {
  const { min, max } = JEV_IMAGE_SIDE;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  // Jev-legal aspect: past max/min the frame has to be cropped, as `fitForJev` does.
  const keptLong = Math.min(long, Math.floor((short * max) / min));
  const cropped = width >= height ? keptLong : width;
  const croppedOther = width >= height ? height : keptLong;
  const cLong = Math.max(cropped, croppedOther);
  const cShort = Math.min(cropped, croppedOther);
  // The long side needed for the short side to clear the floor.
  const needed = Math.ceil((min * cLong) / cShort);
  // Never upscale past the source unless the floor demands it.
  const targetLong = Math.max(Math.min(cLong, cap), needed);
  const k = targetLong / cLong;
  return {
    width: Math.max(1, Math.round(cropped * k)),
    height: Math.max(1, Math.round(croppedOther * k)),
  };
}
