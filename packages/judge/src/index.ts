import type { TruthCase } from './score';

export * from './score';

/** Eval sets are JSON Lines; read them with your runtime's file API and parse here. */
export function parseTruth(jsonl: string): TruthCase[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TruthCase);
}

/** Files that make up the judge. Their hashes are pinned in JUDGE.lock.json. */
export const JUDGE_FILES = ['src/score.ts', 'evals/truth/building-observations.v1.jsonl'] as const;
