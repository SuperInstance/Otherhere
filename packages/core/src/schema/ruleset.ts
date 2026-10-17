import { z } from 'zod';

/**
 * A Ruleset is the game being played. Fog is a rule, not a property of the
 * World: knowledge is shared within Scope, visibility is decided here.
 */
export const FogRule = z.strictObject({
  /** `none`: everything known is visible. `team`: a team shares sight. `personal`: only you. */
  mode: z.enum(['none', 'team', 'personal']),
  revealRadiusM: z.number().positive().max(1000),
  /** Seconds before revealed ground fades back to remembered. 0 = never. */
  fadeAfterS: z.number().min(0),
});

export const Objective = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('explore') }),
  z.strictObject({
    type: z.literal('capture_the_flag'),
    flagsPerTeam: z.number().int().min(1).max(5),
    capturesToWin: z.number().int().min(1).max(10),
  }),
]);

export const Ruleset = z.strictObject({
  id: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  teams: z.number().int().min(0).max(8),
  durationS: z.number().int().positive().nullable(),
  objectives: z.array(Objective).min(1),
  fog: FogRule,
});
export type Ruleset = z.infer<typeof Ruleset>;
