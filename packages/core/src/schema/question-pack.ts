import { z } from 'zod';

/** Typed questions answered by a decision model (e.g. TypeSafe Jev). */
export const Question = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('noul'), instructions: z.string(), criteria: z.string() }),
  z.strictObject({
    type: z.literal('choice'),
    instructions: z.string(),
    criteria: z.string(),
    options: z.array(z.string()).min(2).max(255),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: z.string(),
    criteria: z.string(),
    levels: z.number().int().min(2).max(10),
  }),
]);
export type Question = z.infer<typeof Question>;

export const QuestionPack = z.strictObject({
  id: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string(),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), Question),
});
export type QuestionPack = z.infer<typeof QuestionPack>;
