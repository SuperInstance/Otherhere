import { z } from 'zod';
import { Scope } from './scope';
import { Fact } from './fact';
import { GeneratorRef } from './bundle';
import { Ruleset } from './ruleset';
import { CellId } from './cell';
import { Feature } from './feature';
import { Essence } from './world';

/**
 * A shareable package. Capsules snapshot their Facts (ADR-0008) and never ship
 * Bundles, which are regenerable. Every place Capsule is also an arena: its
 * Cells are the play area and its spawn points are optional.
 */
export const Capsule = z
  .strictObject({
    format: z.literal('otherhere.capsule'),
    formatVersion: z.literal(1),
    id: z.string().min(8),
    kind: z.enum(['place', 'capture', 'ruleset', 'match']),
    title: z.string().trim().min(1).max(200),
    scope: Scope,
    createdAt: z.iso.datetime(),
    cells: z.array(CellId).min(1).max(61),
    /** Where the viewer starts: a point, and optionally a pose in the frame of `cells[0]`'s centre. */
    view: z
      .strictObject({
        center: z.strictObject({ lat: z.number(), lng: z.number() }),
        pose: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).optional(),
      })
      .optional(),
    snapshot: z.strictObject({
      features: z.array(Feature),
      facts: z.array(Fact),
      /** The Essence of each Town the Cells belong to, so Bundles rebuild identically (ADR-0014). */
      essences: z.record(z.string(), Essence).optional(),
      generators: z.array(GeneratorRef),
    }),
    ruleset: Ruleset.optional(),
    arena: z
      .strictObject({ spawns: z.array(z.tuple([z.number(), z.number()])).max(64) })
      .optional(),
    liveRef: z.strictObject({ town: z.string(), cells: z.array(CellId) }).optional(),
    privacy: z.strictObject({
      /** Faces and plates blurred in every attached Capture. */
      blurred: z.boolean(),
      /** If set, locations within home areas are snapped to this many metres. */
      locationFuzzM: z.number().positive().optional(),
    }),
    /** Kid accounts can never publish (invariant 5). */
    ownerIsKid: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.scope !== 'private' && !c.privacy.blurred) {
      ctx.addIssue({
        code: 'custom',
        path: ['privacy', 'blurred'],
        message: 'Capsules must be blurred before leaving private scope (invariant 5)',
      });
    }
    if (c.ownerIsKid && c.scope === 'public') {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'Kid accounts never have public scope (invariant 5)',
      });
    }
  });
export type Capsule = z.infer<typeof Capsule>;
