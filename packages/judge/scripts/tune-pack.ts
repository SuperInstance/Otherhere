// Refine the building question pack's wording with an author model and the fixed judge
// (spends real money: ~$0.25 for the defaults). The judge is read, never changed (invariant 6).
//
//   author: MiniMax proposes rewrites of the pack's text (instructions and option descriptions)
//   answerer: Jev answers each variant
//   dev set: packages/models/tuning/building-photos.dev (25 photos) → used to choose between variants
//   test set: the judge's building-photos.v1 (10 photos) → held out, scored only at the end
//   guard: the judge's building-observations.v1 (text) → a chosen pack must not do worse on it
// Photos are read by Jev directly, fitted with `fitForJev` (ADR-0013).
//
// Only wording can change: question IDs, types and option keys are fixed by `withText`, so a
// tuned pack still maps to Facts exactly as before. Packs are data, never code (invariant 3).
// Usage: TYPESAFE_AI_TOKEN=… MINIMAX_KEY=… ROUNDS=3 VARIANTS=4 pnpm --filter @otherhere/judge exec tsx scripts/tune-pack.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILDING_PACK, QuestionPack, type Answers } from '@otherhere/core';
import {
  ChatProvider,
  fitForJev,
  JevProvider,
  MemoryLedger,
  ModelRouter,
  VISION_PROMPT,
} from '@otherhere/models';
import { parsePhotos, parseTruth, scoreCase, summarize, type Expected } from '../src/index';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const VARIANTS = Number(process.env.VARIANTS ?? 4);
const TEST_RUNS = Number(process.env.TEST_RUNS ?? 2);
const OUT = process.env.OUT ?? 'tune-pack.result.json';

const root = new URL('../evals/truth/', import.meta.url);
const tuning = new URL('../../models/tuning/', import.meta.url);
const text = parseTruth(readFileSync(new URL('building-observations.v1.jsonl', root), 'utf8'));
const dev = parsePhotos(readFileSync(new URL('building-photos.dev.jsonl', tuning), 'utf8'));
const test = parsePhotos(readFileSync(new URL('building-photos.v1.jsonl', root), 'utf8'));
const router = new ModelRouter({ caps: { jev: 2, minimax: 2 }, ledger: new MemoryLedger() });
const jev = new JevProvider(router, {
  apiKey: process.env.TYPESAFE_AI_TOKEN ?? process.env.TYPESAFEAI_KEY ?? '',
});
const author = new ChatProvider(router, 'minimax', {
  apiKey: process.env.MINIMAX_KEY ?? '',
  maxTokens: 24000,
});

type Pack = typeof BUILDING_PACK;

/** Take only the wording from a proposal; everything structural stays as in `base`. */
export function withText(base: Pack, proposal: unknown, version: string): Pack {
  const p = (proposal ?? {}) as {
    questions?: Record<string, { instructions?: unknown; criteria?: Record<string, unknown> }>;
  };
  const text = (v: unknown, fallback: string) =>
    typeof v === 'string' && v.trim() && v.length <= 400 ? v.trim() : fallback;
  const questions = Object.fromEntries(
    Object.entries(base.questions).map(([id, q]) => {
      const pq = p.questions?.[id];
      const criteria = q.criteria as Record<string, string>;
      return [
        id,
        {
          ...q,
          instructions: text(pq?.instructions, q.instructions as string),
          criteria: Object.fromEntries(
            Object.entries(criteria).map(([k, d]) => [k, text(pq?.criteria?.[k], d)]),
          ),
        },
      ];
    }),
  );
  return QuestionPack.parse({ ...base, version, questions }) as Pack;
}

type Result = { correct: number; total: number; misses: string[] };

/** One Jev answer per case; a refusal or error scores zero on the same denominator. */
async function score<C extends { id: string; expected: Expected }>(
  cases: C[],
  ask: (c: C, i: number) => Promise<Answers>,
  describe: (c: C) => string,
): Promise<Result> {
  const scores = await Promise.all(
    cases.map(async (c, i) => {
      try {
        return scoreCase(c, await ask(c, i));
      } catch (err) {
        return { ...scoreCase(c, null), misses: [`error: ${(err as Error).message.slice(0, 80)}`] };
      }
    }),
  );
  const s = summarize(scores);
  const misses = scores.flatMap((x, i) => x.misses.map((m) => `[${describe(cases[i]!)}] → ${m}`));
  return { correct: s.correct, total: s.total, misses };
}

/** A photo as Jev should see it: the smallest resize into its accepted sizes. */
function fitted(path: string): string {
  const [w, h] = JSON.parse(
    execFileSync('python3', [
      '-I',
      '-c',
      'import sys,json;from PIL import Image;print(json.dumps(Image.open(sys.argv[1]).size))',
      path,
    ]).toString(),
  ) as [number, number];
  const f = fitForJev(w, h);
  return execFileSync('python3', [
    '-I',
    '-c',
    'import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");w,h=im.size;W,H=int(sys.argv[2]),int(sys.argv[3]);' +
      'im=im.crop(((w-W)//2,(h-H)//2,(w-W)//2+W,(h-H)//2+H)).resize((int(sys.argv[4]),int(sys.argv[5])));' +
      'b=io.BytesIO();im.save(b,"JPEG",quality=90);sys.stdout.buffer.write(b.getvalue())',
    path,
    ...[f.crop.width, f.crop.height, f.width, f.height].map(String),
  ]).toString('base64');
}
const devImages = dev.map((c) => fitted(new URL(c.image, tuning).pathname));
const testImages = test.map((c) => fitted(new URL(c.image, root).pathname));

const scoreDev = (pack: Pack) =>
  score(
    dev,
    async (_, i) => (await jev.askAboutImage(pack, devImages[i]!, VISION_PROMPT)).value,
    (c) => `${c.id}: ${c.credit.title}`,
  );
const scoreText = (pack: Pack) =>
  score(
    text,
    async (c) => (await jev.ask(pack, c.observation)).value,
    (c) => `"${c.observation}"`,
  );
async function scoreTest(pack: Pack): Promise<number[]> {
  const runs: number[] = [];
  for (let r = 0; r < TEST_RUNS; r++) {
    const s = await score(
      test,
      async (_, i) => (await jev.askAboutImage(pack, testImages[i]!, VISION_PROMPT)).value,
      (c) => c.id,
    );
    runs.push(s.correct);
  }
  return runs;
}

const AUTHOR_SYSTEM =
  'You improve question packs for TypeSafe Jev, a model that answers typed questions about a state: here, a street-level photo of a building. ' +
  'Each question has "instructions" and "criteria": descriptions of each allowed option (for noul: of true and false). ' +
  'Jev picks the option whose description best matches the state, so descriptions should be concrete, mutually exclusive, ' +
  'and say what the option looks like in a photo (cues to look for, common confusions to avoid). ' +
  'You may change only the wording of instructions and option descriptions (each at most 300 characters). ' +
  'Never add, remove or rename questions or options. Reply with JSON only.';

async function propose(best: Pack, misses: string[], n: number): Promise<unknown[]> {
  const text = Object.fromEntries(
    Object.entries(best.questions).map(([id, q]) => [
      id,
      { instructions: q.instructions, criteria: q.criteria },
    ]),
  );
  const prompt =
    `Current pack wording:\n${JSON.stringify({ questions: text }, null, 1)}\n\n` +
    `Mistakes Jev made with it on labelled photos (photo title → what went wrong):\n` +
    `${misses.slice(0, 40).join('\n') || '(none)'}\n\n` +
    `Write ${n} different improved versions that would fix these mistakes without overfitting to these exact sentences. ` +
    `Vary your approach between versions (e.g. sharper boundaries between options, typical phrasings, what to do when unstated). ` +
    `Reply as {"variants":[{"questions":{...same shape as above...}}, ...]}.`;
  const r = await author.complete(
    [
      { role: 'system', content: AUTHOR_SYSTEM },
      { role: 'user', content: prompt },
    ],
    { json: true },
  );
  const json = r.value.slice(r.value.indexOf('{'), r.value.lastIndexOf('}') + 1);
  try {
    const v = (JSON.parse(json) as { variants?: unknown[] }).variants;
    if (Array.isArray(v) && v.length) return v.slice(0, n);
  } catch {
    // Reported below.
  }
  console.log(
    `author reply unusable (${r.usage.outputTokens} tokens out): ${r.value.slice(0, 200)}`,
  );
  return [];
}

const log: unknown[] = [];
let best = BUILDING_PACK as Pack;
let bestDev = await scoreDev(best);
console.log(`baseline  dev ${bestDev.correct}/${bestDev.total}`);
log.push({ round: 0, version: best.version, dev: bestDev.correct, total: bestDev.total });

for (let round = 1; round <= ROUNDS; round++) {
  const proposals = await propose(best, bestDev.misses, VARIANTS);
  const scored = await Promise.all(
    proposals.map(async (p, i) => {
      const pack = withText(best, p, `1.0.${round * 10 + i + 1}`);
      return { pack, dev: await scoreDev(pack) };
    }),
  );
  for (const s of scored) {
    console.log(`round ${round}  ${s.pack.version}  dev ${s.dev.correct}/${s.dev.total}`);
    log.push({ round, version: s.pack.version, dev: s.dev.correct, total: s.dev.total });
  }
  const top = scored.sort((a, b) => b.dev.correct - a.dev.correct)[0];
  // Strictly better on the dev set, or keep what we have.
  if (top && top.dev.correct > bestDev.correct) [best, bestDev] = [top.pack, top.dev];
}

console.log(`\nchosen ${best.version}: dev ${bestDev.correct}/${bestDev.total}`);
const [baseText, bestText] = [await scoreText(BUILDING_PACK as Pack), await scoreText(best)];
console.log(
  `text guard: baseline ${baseText.correct}/${baseText.total}, chosen ${bestText.correct}/${bestText.total}`,
);
const [baseTest, bestTest] = [await scoreTest(BUILDING_PACK as Pack), await scoreTest(best)];
console.log(`held-out photos, ${TEST_RUNS} runs each (correct of 31):`);
console.log(`  baseline ${BUILDING_PACK.version}: ${baseTest.join(' ')}`);
console.log(`  chosen   ${best.version}: ${bestTest.join(' ')}`);
writeFileSync(
  OUT,
  JSON.stringify(
    {
      log,
      baseText: baseText.correct,
      bestText: bestText.correct,
      baseTest,
      bestTest,
      chosen: best,
    },
    null,
    1,
  ),
);
console.log(`wrote ${OUT}`);
