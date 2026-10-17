import { z } from 'zod';

// Question packs are a Published Language shared with TypeSafe Jev (ADR-0013):
// the shapes below are exactly what POST /v1/systemone accepts.

const Text = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

export const Question = z.discriminatedUnion('type', [
  /** Yes/no: the answer is the probability of "yes". */
  z.strictObject({
    type: z.literal('noul'),
    instructions: Text,
    criteria: z.strictObject({ true: Text, false: Text }).optional(),
  }),
  /** One of 1–255 named options, each with a description of when it applies. */
  z.strictObject({
    type: z.literal('choice'),
    instructions: Text,
    criteria: z.record(z.string(), Text.nullable()).refine((c) => {
      const n = Object.keys(c).length;
      return n >= 1 && n <= 255;
    }, '1–255 choices'),
  }),
  /** An ordered rubric of 1–10 levels; the answer is the probability-weighted level. */
  z.strictObject({
    type: z.literal('score'),
    instructions: Text,
    criteria: z.array(Text).min(1).max(10),
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

/** Answers, in Jev's response shapes. */
export const Answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()).optional(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()).optional(),
  }),
]);
export type Answer = z.infer<typeof Answer>;
export type Answers = Record<string, Answer>;
