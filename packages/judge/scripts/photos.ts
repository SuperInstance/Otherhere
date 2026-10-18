// Compare the two ADR-0013 pipelines on the fixed photo eval (spends real money: ~$0.04 per run).
//   A: Groq vision → written observation → Jev        (the accepted default)
//   B: Jev reading the image directly ("danger zone")  (the candidate)
// Each pipeline runs on the raw photo and on the same preprocessed bytes (centre-cropped
// to ≤ 2:1, short side ≥ 448 px), so the crop's effect and the path's effect can be told
// apart. Every column runs RUNS times: the run-to-run spread and per-photo stability are
// reported, and so is coverage (how many photos Jev refused outright).
// Usage: GROQ_KEY=… TYPESAFEAI_KEY=… RUNS=3 pnpm --filter @otherhere/judge photos
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILDING_PACK, type Answers } from '@otherhere/core';
import {
  ChatProvider,
  JevProvider,
  JevRejected,
  MemoryLedger,
  ModelRouter,
  VISION_PROMPT,
} from '@otherhere/models';
import { parsePhotos, scoreCase, summarize, type CaseScore } from '../src/index';

const RUNS = Number(process.env.RUNS ?? 3);
const root = new URL('../evals/truth/', import.meta.url);
const cases = parsePhotos(readFileSync(new URL('building-photos.v1.jsonl', root), 'utf8'));
const router = new ModelRouter({ caps: { jev: 2, groq: 2 }, ledger: new MemoryLedger() });
const jev = new JevProvider(router, { apiKey: process.env.TYPESAFEAI_KEY ?? '' });
const groq = new ChatProvider(router, 'groq', { apiKey: process.env.GROQ_KEY ?? '' });

/** Centre-crop to at most 2:1 and upscale so the short side is ≥ 448 px (Jev rejects small or extreme images). */
const cropForJev = (path: string): string =>
  execFileSync('python3', [
    '-I',
    '-c',
    'import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");w,h=im.size;' +
      'W=min(w,2*h);H=min(h,2*w);im=im.crop(((w-W)//2,(h-H)//2,(w-W)//2+W,(h-H)//2+H));' +
      'k=max(1,448/min(W,H));im=im.resize((round(W*k),round(H*k)));' +
      'b=io.BytesIO();im.save(b,"JPEG",quality=90);sys.stdout.buffer.write(b.getvalue())',
    path,
  ]).toString('base64');

const images = cases.map((c) => {
  const path = new URL(c.image, root).pathname;
  return { raw: readFileSync(path).toString('base64'), crop: cropForJev(path) };
});

type Outcome = { score: CaseScore; signature: string; refused: boolean; costUsd: number };
type Column = { name: string; run: (i: number) => Promise<{ answers: Answers; costUsd: number }> };

const viaVision = (pick: 'raw' | 'crop') => async (i: number) => {
  const seen = await groq.describe(images[i]![pick], VISION_PROMPT);
  const r = await jev.ask(BUILDING_PACK, seen.value);
  return { answers: r.value, costUsd: seen.costUsd + r.costUsd };
};
const direct = (pick: 'raw' | 'crop') => async (i: number) => {
  const r = await jev.askAboutImage(BUILDING_PACK, images[i]![pick], VISION_PROMPT);
  return { answers: r.value, costUsd: r.costUsd };
};
const columns: Column[] = [
  { name: 'A raw ', run: viaVision('raw') },
  { name: 'A crop', run: viaVision('crop') },
  { name: 'B raw ', run: direct('raw') },
  { name: 'B crop', run: direct('crop') },
];

/** What the pipeline decided, ignoring probabilities: used to tell whether a photo's answers repeat. */
const signature = (a: Answers | null): string =>
  a === null
    ? 'none'
    : Object.keys(a)
        .sort()
        .map((k) => {
          const v = a[k]!;
          return `${k}=${v.type === 'choice' ? v.choice : v.type === 'noul' ? v.noul >= 0.5 : '?'}`;
        })
        .join(',');

async function attempt(col: Column, i: number): Promise<Outcome> {
  const c = cases[i]!;
  try {
    const r = await col.run(i);
    return {
      score: scoreCase(c, r.answers),
      signature: signature(r.answers),
      refused: false,
      costUsd: r.costUsd,
    };
  } catch (err) {
    // A refused or failed photo scores zero on the same denominator: it is a real failure of that pipeline.
    const s = scoreCase(c, null);
    const refused = err instanceof JevRejected;
    const why = `${refused ? 'refused' : 'error'}: ${(err as Error).message.slice(0, 100)}`;
    return { score: { ...s, misses: [why] }, signature: why, refused, costUsd: 0 };
  }
}

// results[column][run][case]
const results: Outcome[][][] = columns.map(() => []);
for (let run = 0; run < RUNS; run++) {
  for (const [ci, col] of columns.entries()) {
    const outcomes = await Promise.all(cases.map((_, i) => attempt(col, i)));
    results[ci]!.push(outcomes);
    const s = summarize(outcomes.map((o) => o.score));
    console.log(`run ${run + 1}  ${col.name}  ${s.correct}/${s.total}`);
  }
}

const total = summarize(results[0]![0]!.map((o) => o.score)).total;
console.log(`\n${cases.length} photos, ${total} labelled field-answers, ${RUNS} runs per column\n`);
console.log('column  per run (correct)        mean    spread  stable photos  refused  $/run');
for (const [ci, col] of columns.entries()) {
  const runs = results[ci]!;
  const corrects = runs.map((r) => summarize(r.map((o) => o.score)).correct);
  const mean = corrects.reduce((s, x) => s + x, 0) / RUNS;
  const spread = Math.max(...corrects) - Math.min(...corrects);
  const stable = cases.filter((_, i) => new Set(runs.map((r) => r[i]!.signature)).size === 1);
  const refused = cases.filter((_, i) => runs.some((r) => r[i]!.refused)).map((c) => c.id);
  const cost = runs.flat().reduce((s, o) => s + o.costUsd, 0) / RUNS;
  console.log(
    `${col.name}  ${corrects.join(' ').padEnd(24)} ${((mean / total) * 100).toFixed(1).padStart(5)}%  ` +
      `${String(spread).padStart(6)}  ${`${stable.length}/${cases.length}`.padStart(13)}  ` +
      `${(refused.join(',') || '-').padStart(7)}  ${cost.toFixed(4)}`,
  );
}

console.log('\nper photo, last run:');
for (const [i, c] of cases.entries()) {
  for (const [ci, col] of columns.entries()) {
    const o = results[ci]!.at(-1)![i]!;
    console.log(
      `${c.id} ${col.name} ${o.score.correct}/${o.score.total} ${o.score.misses.join('; ')}`,
    );
  }
}
