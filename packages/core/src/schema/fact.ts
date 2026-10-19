import { z } from 'zod';
import { FeatureId } from './feature';

/**
 * Lowest to highest rank (invariant 4). `imagined` is below every observed
 * source and is never a Fact: it marks values the generators derived from
 * nothing (e.g. an imagined tree's position), which exist only inside a Bundle
 * build and lose every conflict by construction.
 */
export const SOURCES = [
  'imagined',
  'osm',
  'overture',
  'satellite_inference',
  'street_imagery',
  'capture',
  'manual_edit',
] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const sourceRank = (s: Source): number => SOURCES.indexOf(s);

const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export type LngLat = z.infer<typeof LngLat>;

export const ROOF_SHAPES = ['flat', 'gable', 'hip', 'shed'] as const;
export const RoofShape = z.enum(ROOF_SHAPES);
export type RoofShape = z.infer<typeof RoofShape>;

const Colour = z.string().regex(/^#[0-9a-f]{6}$/, 'lower-case #rrggbb');

/**
 * Value schemas for well-known attributes. Facts about other attributes are
 * allowed (any JSON), so new sources can add knowledge before code knows it.
 */
export const ATTRIBUTES = {
  footprint: z.array(LngLat).min(3),
  path: z.array(LngLat).min(2),
  position: LngLat,
  height: z.number().positive().max(1000),
  minHeight: z.number().min(0).max(1000),
  levels: z.number().int().positive().max(300),
  'roof.shape': RoofShape,
  'roof.height': z.number().min(0).max(100),
  'roof.colour': Colour,
  colour: Colour,
  building: z.string(),
  highway: z.string(),
  width: z.number().positive().max(200),
  name: z.string(),
  /** A tree's species, as a code from `FOREST_SPECIES`. */
  species: z.enum(['hemlock', 'spruce', 'cedar', 'alder', 'salmonberry', 'broadleaf']),
  /** A landcover polygon's cover class. */
  landcover: z.enum(['forest', 'scrub', 'meadow']),
  'osm.tags': z.record(z.string(), z.string()),
} as const;
export type KnownAttribute = keyof typeof ATTRIBUTES;

export const Fact = z
  .object({
    featureId: FeatureId,
    attribute: z.string().min(1),
    value: z.json(),
    source: Source,
    confidence: z.number().min(0).max(1),
    observedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .superRefine((f, ctx) => {
    // Facts are observed; imagination is derived at build time and never stored.
    if (f.source === 'imagined') {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'imagined is not a Fact source' });
    }
    const schema = (ATTRIBUTES as Record<string, z.ZodType>)[f.attribute];
    if (schema && !schema.safeParse(f.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `invalid ${f.attribute}` });
    }
  });
export type Fact = z.infer<typeof Fact>;
