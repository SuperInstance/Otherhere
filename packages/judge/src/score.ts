// THE JUDGE IS FIXED (invariant 6). Automated improvement processes must never
// modify this file or the eval sets; JUDGE.lock.json pins their hashes.
import type { Answers } from '@otherhere/core';

/** Expected answers, hand-labelled. A field is left out when it cannot be judged. */
export type Expected = {
  visible: boolean;
  roof_shape?: string;
  floors?: string;
  wall_colour?: string;
  roof_colour?: string;
};

/** A written observation and what it says about the building. */
export type TruthCase = {
  id: string;
  observation: string;
  expected: {
    visible: boolean;
    roof_shape?: string;
    floors?: string;
    wall_colour?: string;
    roof_colour?: string;
  };
};

export type CaseScore = { id: string; correct: number; total: number; misses: string[] };

/** One point per expected answer. `visible` is right when the noul is on the right side of 0.5. */
export function scoreCase(
  c: { id: string; expected: Expected },
  answers: Answers | null,
): CaseScore {
  const misses: string[] = [];
  let correct = 0;
  let total = 0;
  const vis = answers?.visible;
  total++;
  if (vis?.type === 'noul' && vis.noul >= 0.5 === c.expected.visible) correct++;
  else misses.push(`visible: expected ${c.expected.visible}`);
  if (c.expected.visible) {
    for (const q of ['roof_shape', 'floors', 'wall_colour', 'roof_colour'] as const) {
      const want = c.expected[q];
      if (want === undefined) continue;
      total++;
      const a = answers?.[q];
      const got = a?.type === 'choice' ? a.choice : undefined;
      if (got === want) correct++;
      else misses.push(`${q}: expected ${want}, got ${got ?? 'nothing'}`);
    }
  }
  return { id: c.id, correct, total, misses };
}

export function summarize(scores: CaseScore[]): {
  accuracy: number;
  correct: number;
  total: number;
} {
  const correct = scores.reduce((s, x) => s + x.correct, 0);
  const total = scores.reduce((s, x) => s + x.total, 0);
  return { accuracy: total ? correct / total : 0, correct, total };
}
