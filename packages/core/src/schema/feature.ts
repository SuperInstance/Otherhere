import { z } from 'zod';
import { CellId } from './cell';

/**
 * Stable, source-namespaced Feature IDs (ADR-0003):
 * `osm:w123`, `osm:n456`, `osm:w123:n1-n2` (a road segment), `cap:<id>`, `edit:<id>`.
 */
export const FeatureId = z
  .string()
  .regex(/^(osm:[nwr]\d+(:n\d+-n\d+)?|cap:[\w-]+|edit:[\w-]+)$/, 'invalid Feature ID');
export type FeatureId = z.infer<typeof FeatureId>;

export const FEATURE_KINDS = [
  'building',
  'road',
  'tree',
  'landcover',
  'bench',
  'streetlight',
] as const;
export const FeatureKind = z.enum(FEATURE_KINDS);
export type FeatureKind = z.infer<typeof FeatureKind>;

export const Feature = z.object({
  id: FeatureId,
  kind: FeatureKind,
  anchorCell: CellId,
});
export type Feature = z.infer<typeof Feature>;
