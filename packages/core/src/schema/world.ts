import { z } from 'zod';
import { CellId } from './cell';
import { FeatureId } from './feature';

/** Fog-of-war memory rings, sharpest first. */
export const FogRing = z.enum(['focus', 'recent', 'remembered']);
export type FogRing = z.infer<typeof FogRing>;

export const Essence = z.strictObject({
  town: z.string(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).max(16),
  roofShapes: z.record(z.string(), z.number().min(0)),
  heightM: z.strictObject({ median: z.number(), p90: z.number() }),
  propFamilies: z.record(z.string(), z.number().min(0)),
  sampleCount: z.number().int().min(0),
});
export type Essence = z.infer<typeof Essence>;

export const Salience = z.strictObject({
  dwellS: z.number().min(0),
  friendActivity: z.number().min(0),
  captures: z.number().int().min(0),
  edits: z.number().int().min(0),
  landmark: z.boolean(),
});
export type Salience = z.infer<typeof Salience>;

/** A high-salience place kept at full fidelity forever. */
export const Memory = z.strictObject({
  id: z.string(),
  cells: z.array(CellId).min(1),
  features: z.array(FeatureId),
  salience: Salience,
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Memory = z.infer<typeof Memory>;

export function salienceScore(s: Salience): number {
  return (
    Math.min(s.dwellS / 600, 3) +
    s.friendActivity * 0.5 +
    s.captures * 2 +
    s.edits * 1.5 +
    (s.landmark ? 3 : 0)
  );
}

export const MEMORY_THRESHOLD = 4;

/**
 * Eviction policy stub: decide which ring a Cell's detail belongs in. Cells
 * that hold a Memory are never evicted below full fidelity.
 */
export function ringFor(opts: {
  distanceCells: number;
  lastSeenS: number;
  holdsMemory: boolean;
}): FogRing {
  if (opts.distanceCells <= 1) return 'focus';
  if (opts.holdsMemory || opts.lastSeenS < 3600) return 'recent';
  return 'remembered';
}

/** Two judges: event schemas only in M0. */
export const TruthEvent = z.strictObject({
  kind: z.literal('truth'),
  at: z.iso.datetime(),
  cell: CellId,
  featureId: FeatureId.optional(),
  metric: z.enum(['layout_iou', 'landmark_match', 'height_error_m']),
  value: z.number(),
  captureId: z.string(),
});
export const TasteEvent = z.strictObject({
  kind: z.literal('taste'),
  at: z.iso.datetime(),
  cell: CellId,
  generator: z.string(),
  signal: z.enum(['chose_variant', 'dwell', 'reuse']),
  value: z.number(),
  variant: z.string().optional(),
});
export const JudgeEvent = z.discriminatedUnion('kind', [TruthEvent, TasteEvent]);
export type JudgeEvent = z.infer<typeof JudgeEvent>;
