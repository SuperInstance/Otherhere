import { z } from 'zod';

/** The Ladder, cheapest rung first. */
export const RUNGS = ['rule', 'distilled', 'jev', 'groq', 'claude', 'human'] as const;
export const Rung = z.enum(RUNGS);
export type Rung = z.infer<typeof Rung>;

/** Every decision is logged with its rung, cost, and confidence. */
export const DecisionLog = z.strictObject({
  id: z.string(),
  at: z.iso.datetime(),
  questionPack: z.string(),
  packVersion: z.string(),
  questionId: z.string(),
  rung: Rung,
  costUsd: z.number().min(0),
  latencyMs: z.number().min(0),
  confidence: z.number().min(0).max(1),
  answer: z.json(),
  escalatedFrom: Rung.optional(),
});
export type DecisionLog = z.infer<typeof DecisionLog>;

export type DecisionRequest = {
  pack: string;
  packVersion: string;
  questionId: string;
  state: unknown;
};
export type Decision = { answer: unknown; confidence: number; costUsd: number };

/** One rung. Returns null when it cannot answer and the Ladder should escalate. */
export interface LadderRung {
  readonly rung: Rung;
  decide(req: DecisionRequest): Promise<Decision | null>;
}
