import { z } from 'zod';
import type { Answers, QuestionPack } from './question-pack';

/** The Ladder, cheapest rung first. */
export const RUNGS = ['rule', 'distilled', 'jev', 'groq', 'minimax', 'claude', 'human'] as const;
export const Rung = z.enum(RUNGS);
export type Rung = z.infer<typeof Rung>;

/** Every attempt on every rung is logged with its cost and confidence. */
export const DecisionLog = z.strictObject({
  id: z.string(),
  at: z.iso.datetime(),
  pack: z.string(),
  packVersion: z.string(),
  /** What the decision was about, e.g. a Feature ID. */
  subject: z.string(),
  rung: Rung,
  outcome: z.enum(['accepted', 'escalated', 'unavailable', 'error']),
  costUsd: z.number().min(0),
  latencyMs: z.number().min(0),
  confidence: z.number().min(0).max(1),
  answers: z.json().nullable(),
  error: z.string().optional(),
});
export type DecisionLog = z.infer<typeof DecisionLog>;

export type DecisionRequest = { pack: QuestionPack; state: unknown; subject: string };
export type Decision = { answers: Answers; confidence: number; costUsd: number };

/** One rung. Returns null when it cannot answer at all (e.g. no rule applies, no key). */
export interface LadderRung {
  readonly rung: Rung;
  decide(req: DecisionRequest): Promise<Decision | null>;
}

/** A pack decision is only as sure as its least sure answer. */
export function packConfidence(answers: Answers): number {
  let c = 1;
  for (const a of Object.values(answers)) {
    c = Math.min(c, a.type === 'noul' ? Math.max(a.noul, 1 - a.noul) : a.confidence);
  }
  return c;
}
