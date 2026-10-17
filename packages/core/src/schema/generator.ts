import { z } from 'zod';
import { FeatureKind } from './feature';

/**
 * Geometry DSL v0 (ADR-0005). A GeneratorDef is data: a list of ops whose
 * parameters are expressions from a small closed language. The interpreter in
 * `geometry/interpret.ts` is the only thing that runs it (invariant 3).
 *
 * Every expression evaluates to a value plus a confidence. Values read from
 * Facts carry the Fact's confidence; values the generator imagines (`rand`,
 * `pick`, `attr` defaults) carry low confidence; literals are neutral. The
 * client renders low-confidence geometry "soft" and high-confidence "crisp".
 */
export type Expr =
  | number
  | string
  | boolean
  | { attr: string; default?: Expr }
  | { param: string }
  | { op: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max'; args: Expr[] }
  | { op: 'eq' | 'lt' | 'gt'; args: [Expr, Expr] }
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; value: Expr }
  | { op: 'has'; attr: string }
  | { op: 'floor'; value: Expr }
  | { op: 'clamp'; value: Expr; min: Expr; max: Expr }
  | { op: 'rand'; min: Expr; max: Expr; key: string }
  | { op: 'pick'; options: Expr[]; key: string; weights?: number[] }
  | { op: 'if'; cond: Expr; then: Expr; else: Expr };

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.strictObject({ attr: z.string(), default: Expr.optional() }),
    z.strictObject({ param: z.string() }),
    z.strictObject({
      op: z.enum(['add', 'sub', 'mul', 'div', 'min', 'max']),
      args: z.array(Expr).min(1),
    }),
    z.strictObject({ op: z.enum(['eq', 'lt', 'gt']), args: z.tuple([Expr, Expr]) }),
    z.strictObject({ op: z.enum(['and', 'or']), args: z.array(Expr).min(1) }),
    z.strictObject({ op: z.literal('not'), value: Expr }),
    z.strictObject({ op: z.literal('has'), attr: z.string() }),
    z.strictObject({ op: z.literal('floor'), value: Expr }),
    z.strictObject({ op: z.literal('clamp'), value: Expr, min: Expr, max: Expr }),
    z.strictObject({ op: z.literal('rand'), min: Expr, max: Expr, key: z.string() }),
    z.strictObject({
      op: z.literal('pick'),
      options: z.array(Expr).min(1).max(256),
      key: z.string(),
      weights: z.array(z.number().nonnegative()).optional(),
    }),
    z.strictObject({ op: z.literal('if'), cond: Expr, then: Expr, else: Expr }),
  ]),
);

const Vec3 = z.tuple([Expr, Expr, Expr]);
const when = {
  /** Skip the op unless this evaluates truthy. */
  when: Expr.optional(),
  /** Upper bound on the shape confidence this op may claim (e.g. imagined windows). */
  confidence: z.number().min(0).max(1).optional(),
};

/** Statements. Footprint ops need an area Feature; `ribbon` a path; solids a position. */
export const Op = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('let'), name: z.string(), value: Expr, ...when }),
  /** Walls: the footprint extruded from `base` to `top` metres. */
  z.strictObject({ op: z.literal('extrude'), base: Expr, top: Expr, colour: Expr, ...when }),
  /** A roof over the footprint from `base` rising `rise` metres. */
  z.strictObject({
    op: z.literal('roof'),
    shape: Expr,
    base: Expr,
    rise: Expr,
    colour: Expr,
    /** Colour for gable ends and shed high walls; defaults to `colour`. */
    wallColour: Expr.optional(),
    ...when,
  }),
  /** A grid of window panes on every wall long enough to hold one. */
  z.strictObject({
    op: z.literal('windows'),
    base: Expr,
    top: Expr,
    floorHeight: Expr,
    width: Expr,
    height: Expr,
    sill: Expr,
    spacing: Expr,
    colour: Expr,
    ...when,
  }),
  /** A flat strip along a path (roads, paths). */
  z.strictObject({ op: z.literal('ribbon'), width: Expr, y: Expr, colour: Expr, ...when }),
  /** Solids placed relative to a point Feature, rotated `yaw` radians about up. */
  z.strictObject({
    op: z.literal('box'),
    at: Vec3,
    size: Vec3,
    yaw: Expr.optional(),
    colour: Expr,
    ...when,
  }),
  z.strictObject({
    op: z.literal('cylinder'),
    at: Vec3,
    radius: Expr,
    height: Expr,
    topRadius: Expr.optional(),
    segments: z.number().int().min(3).max(32),
    colour: Expr,
    ...when,
  }),
  z.strictObject({
    op: z.literal('blob'),
    at: Vec3,
    radius: Expr,
    squash: Expr.optional(),
    detail: z.number().int().min(0).max(2),
    colour: Expr,
    ...when,
  }),
]);
export type Op = z.infer<typeof Op>;

export const GeneratorDef = z.strictObject({
  id: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string(),
  appliesTo: z.array(FeatureKind).min(1),
  geometry: z.enum(['footprint', 'path', 'position']),
  ops: z.array(Op).min(1).max(512),
});
export type GeneratorDef = z.infer<typeof GeneratorDef>;
