import { z } from 'zod';

/**
 * A distilled capture riding beside the Bundle (M-integration design): the
 * `asset.capture` Fact's value. The payload bytes are NOT in the Bundle —
 * they live beside the place that carries the Fact, addressed by their own
 * sha256 exactly the way a Bundle is addressed by its output hash. What the
 * Bundle carries is this sidecar (in its content address, via the Fact) and
 * the derived display extras (see `assetExtras` in bundle/build).
 *
 * Tier ladder, coarsest last-resort first in spirit: `card` is the smallest
 * photograph (the lite profile's only tier), `impostor` the larger one, and
 * `splat` the true 3D capture (a gaussian field, .spz). A client picks the
 * richest tier its profile and the viewer's distance allow; the Bundle
 * itself never degrades.
 */
export const AssetTier = z.object({
  /** Path of the payload, relative to the directory serving the place file. */
  path: z.string().min(1),
  /** sha256 of the payload bytes, lower-case hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  contentType: z.string().min(1),
});
export type AssetTier = z.infer<typeof AssetTier>;

export const AssetCapture = z.object({
  family: z.string().min(1),
  version: z.string().min(1),
  tiers: z.object({
    splat: AssetTier.optional(),
    impostor: AssetTier.optional(),
    card: AssetTier.optional(),
  }),
  params: z.object({
    /**
     * Placement in the anchor Cell's local frame (metres, x east / y up /
     * z = -north, the Bundle's own convention): the similarity that takes
     * the capture's native frame onto the Cell's. Applied as
     * position + quaternion * (scale * p).
     */
    position: z.tuple([z.number(), z.number(), z.number()]),
    quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    scale: z.number().positive(),
    /** The asset's height above its own ground plane, metres. */
    heightM: z.number().positive(),
    /**
     * Compass azimuth (deg, 0 = north, 90 = east) of the asset's principal
     * photographed face: the direction from the asset toward the camera
     * position the `card`/`impostor` tiers were baked from.
     */
    frontAzimuthDeg: z.number().min(0).lt(360),
    /**
     * The impostor/card quad's metric frame, when the tiers exist: the
     * baked photograph is a frustum slice at the asset's distance, so the
     * quad is the slice's size in metres and `centreYM` is its centre's
     * height above the asset's ground plane.
     */
    cardQuad: z
      .object({
        widthM: z.number().positive(),
        heightM: z.number().positive(),
        centreYM: z.number(),
      })
      .optional(),
  }),
});
export type AssetCapture = z.infer<typeof AssetCapture>;
