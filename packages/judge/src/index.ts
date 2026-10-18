import type { Expected, TruthCase } from './score';

/** A photo (path relative to evals/truth/) and what it shows, with its CC BY credit. */
export type PhotoCase = {
  id: string;
  image: string;
  expected: Expected;
  credit: { title: string; creator: string; license: string; source: string };
};

export function parsePhotos(jsonl: string): PhotoCase[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PhotoCase);
}

export * from './score';

/** Eval sets are JSON Lines; read them with your runtime's file API and parse here. */
export function parseTruth(jsonl: string): TruthCase[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TruthCase);
}

/** Files that make up the judge. Their hashes are pinned in JUDGE.lock.json. */
export const JUDGE_FILES = [
  'src/score.ts',
  'evals/truth/building-observations.v1.jsonl',
  'evals/truth/building-photos.v1.jsonl',
  ...Array.from(
    { length: 10 },
    (_, i) => `evals/truth/photos/p${String(i + 1).padStart(2, '0')}.jpg`,
  ),
] as const;
