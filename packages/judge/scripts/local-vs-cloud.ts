// Local vs cloud decision models, on the FIXED judge.
//
// The judge (packages/judge/src/score.ts and the eval sets) is never modified here —
// invariant 6. This script only chooses WHO answers the pack; the scoring is the
// same fixed code for every arm.
//
// Usage:
//   MODE=text  RUNS=2 pnpm --filter @otherhere/judge exec tsx scripts/local-vs-cloud.ts
//   MODE=photo RUNS=2 pnpm --filter @otherhere/judge exec tsx scripts/local-vs-cloud.ts
//
//   ARMS=local-omni,cloud-jev   pick arms (default: all that are reachable)
//   LOCAL_SIDE=512              long side, px, for the LOCAL image arms
//
// Arms:
//   local-omni  LiquidAI d1-omni-600M  @ 127.0.0.1:8095
//   local-2b    LiquidAI d1-2B         @ 127.0.0.1:8094
//   local-3b    LiquidAI d1-3B         @ 127.0.0.1:8093
//   local-clef  Cloudflare clef-flash @ 127.0.0.1:8096
//   cloud-jev   TypeSafe Jev          (needs TYPESAFE_AI_TOKEN)
//   cloud-llm   MiniMax-M3 answering the pack in Jev's shapes (needs MINIMAX_KEY)
//
// Text mode asks about a written observation; photo mode asks about the photo itself.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILDING_PACK, type Answers } from '@otherhere/core';
import {
  ChatProvider,
  JevProvider,
  LocalDecisionProvider,
  MemoryLedger,
  ModelRouter,
  VISION_PROMPT,
  llmRung,
} from '@otherhere/models';
import { parsePhotos, parseTruth, scoreCase, summarize, type CaseScore } from '../src/index';

const MODE = (process.env.MODE ?? 'text') as 'text' | 'photo';
const RUNS = Number(process.env.RUNS ?? 2);
const LOCAL_SIDE = Number(process.env.LOCAL_SIDE ?? 512);
const root = new URL('../evals/truth/', import.meta.url);

const router = new ModelRouter({
  caps: { jev: 50, minimax: 50, groq: 50 },
  ledger: new MemoryLedger(),
});

type Arm = {
  name: string;
  ask: (state: string, image?: string) => Promise<{ answers: Answers; costUsd: number }>;
};

// ── the arms ────────────────────────────────────────────────────────────────
function buildArms(): Arm[] {
  const want = process.env.ARMS?.split(',').map((s) => s.trim());
  const arms: Arm[] = [];

  const local = (name: string, port: number, model: string): Arm => ({
    name,
    ask: async (state, image) => {
      const p = new LocalDecisionProvider({ baseUrl: `http://127.0.0.1:${port}`, model });
      const r = image
        ? await p.askAboutImage(BUILDING_PACK, image, state)
        : await p.ask(BUILDING_PACK, state);
      return { answers: r.value, costUsd: r.costUsd };
    },
  });

  arms.push(local('local-omni', 8095, 'd1-omni-600M'));
  arms.push(local('local-2b', 8094, 'd1-2B'));
  arms.push(local('local-3b', 8093, 'd1-3B'));
  arms.push(local('local-clef', 8096, 'clef-flash'));

  const jevKey = process.env.TYPESAFE_AI_TOKEN ?? process.env.TYPESAFEAI_KEY ?? '';
  if (jevKey) {
    const jev = new JevProvider(router, { apiKey: jevKey });
    arms.push({
      name: 'cloud-jev',
      ask: async (state, image) => {
        const r = image
          ? await jev.askAboutImage(BUILDING_PACK, image, state)
          : await jev.ask(BUILDING_PACK, state);
        return { answers: r.value, costUsd: r.costUsd };
      },
    });
  }

  const mmKey = process.env.MINIMAX_KEY ?? '';
  if (mmKey) {
    const chat = new ChatProvider(router, 'minimax', { apiKey: mmKey, maxTokens: 4000 });
    const rung = llmRung(chat);
    arms.push({
      name: 'cloud-llm',
      ask: async (state, image) => {
        // In photo mode the cloud arm is the production path: vision → written
        // observation → the pack. In text mode there is no image to describe.
        const observed = image ? await chat.describe(image, state) : null;
        const r = await rung.decide({
          pack: BUILDING_PACK,
          state: observed?.value ?? state,
          subject: 'eval',
        });
        return { answers: r?.answers ?? {}, costUsd: (observed?.costUsd ?? 0) + (r?.costUsd ?? 0) };
      },
    });
  }

  return want ? arms.filter((a) => want.includes(a.name)) : arms;
}

// ── the cases ───────────────────────────────────────────────────────────────
const PIL = (script: string, ...args: string[]): string =>
  execFileSync('python3', [
    '-I',
    '-c',
    `import sys,io;from PIL import Image;${script}`,
    ...args,
  ]).toString('base64');
const save = 'b=io.BytesIO();im.save(b,"JPEG",quality=90);sys.stdout.buffer.write(b.getvalue())';

/**
 * The image every arm sees: a long side of LOCAL_SIDE.
 *
 * Deliberately the SAME bytes for every arm, so the only variable is the model.
 * (Jev's own path uses `fitForJev` — a centre crop into 280–1568 px — so a Jev arm
 * would need its own run to compare against the historical numbers in
 * `model-field-notes.md`. Identical bytes is what makes today's arms comparable
 * to each other.)
 */
const localSized = (path: string): string =>
  PIL(
    'im=Image.open(sys.argv[1]).convert("RGB");w,h=im.size;k=min(1,float(sys.argv[2])/max(w,h));' +
      'im=im.resize((max(1,round(w*k)),max(1,round(h*k))));' +
      save,
    path,
    String(LOCAL_SIDE),
  );

type Case = {
  id: string;
  expected: {
    visible: boolean;
    roof_shape?: string;
    floors?: string;
    wall_colour?: string;
    roof_colour?: string;
  };
  state: string;
  /** The SAME bytes for every arm, so the only variable is the model. */
  image?: string;
};

let cases: Case[];
if (MODE === 'text') {
  const truth = parseTruth(readFileSync(new URL('building-observations.v1.jsonl', root), 'utf8'));
  cases = truth.map((t) => ({ id: t.id, expected: t.expected, state: t.observation }));
} else {
  const photos = parsePhotos(readFileSync(new URL('building-photos.v1.jsonl', root), 'utf8'));
  cases = photos.map((p) => {
    const path = new URL(p.image, root).pathname;
    return {
      id: p.id,
      expected: p.expected,
      state: VISION_PROMPT,
      image: localSized(path),
    };
  });
}

// ── run ─────────────────────────────────────────────────────────────────────
type Outcome = { score: CaseScore; ms: number; costUsd: number; error?: string };

async function attempt(arm: Arm, c: Case): Promise<Outcome> {
  const t0 = Date.now();
  try {
    const image = MODE === 'photo' ? c.image : undefined;
    const r = await arm.ask(c.state, image);
    return { score: scoreCase(c, r.answers), ms: Date.now() - t0, costUsd: r.costUsd };
  } catch (err) {
    const why = `error: ${(err as Error).message.slice(0, 120)}`;
    // A failed call scores zero on the same denominator: it is a real failure of that arm.
    return {
      score: { ...scoreCase(c, null), misses: [why] },
      ms: Date.now() - t0,
      costUsd: 0,
      error: why,
    };
  }
}

const arms = buildArms();
console.log(`mode: ${MODE}   runs: ${RUNS}   cases: ${cases.length}`);
console.log(`arms: ${arms.map((a) => a.name).join(', ')}\n`);

const results = new Map<string, Outcome[][]>();
for (const arm of arms) {
  const runs: Outcome[][] = [];
  for (let r = 0; r < RUNS; r++) {
    const outcomes: Outcome[] = [];
    for (const c of cases) outcomes.push(await attempt(arm, c));
    runs.push(outcomes);
    const s = summarize(outcomes.map((o) => o.score));
    const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    console.log(
      `run ${r + 1}  ${arm.name.padEnd(12)} ${s.correct}/${s.total}   median ${ms[Math.floor(ms.length / 2)]} ms`,
    );
  }
  results.set(arm.name, runs);
}

const total = summarize(results.get(arms[0]!.name)![0]!.map((o) => o.score)).total;
console.log(`\n${cases.length} cases, ${total} labelled field-answers, ${RUNS} runs per arm\n`);
console.log('arm             per run        mean      spread   median ms   cost/run   errors');
console.log('-'.repeat(88));
for (const arm of arms) {
  const runs = results.get(arm.name)!;
  const corrects = runs.map((r) => summarize(r.map((o) => o.score)).correct);
  const mean = corrects.reduce((s, x) => s + x, 0) / RUNS;
  const spread = Math.max(...corrects) - Math.min(...corrects);
  const allMs = runs
    .flat()
    .map((o) => o.ms)
    .sort((a, b) => a - b);
  const med = allMs[Math.floor(allMs.length / 2)] ?? 0;
  const cost = runs.flat().reduce((s, o) => s + o.costUsd, 0) / RUNS;
  const errors = runs.flat().filter((o) => o.error).length;
  console.log(
    `${arm.name.padEnd(16)} ${corrects.join(' ').padEnd(14)} ${((mean / total) * 100).toFixed(1).padStart(5)}%  ` +
      `${String(spread).padStart(7)}   ${String(med).padStart(8)}   ${cost.toFixed(4).padStart(8)}   ${errors}`,
  );
}

console.log('\nper case, last run:');
for (const [i, c] of cases.entries()) {
  const parts = arms.map((arm) => {
    const o = results.get(arm.name)!.at(-1)![i]!;
    return `${arm.name}=${o.score.correct}/${o.score.total}`;
  });
  console.log(`  ${c.id.padEnd(6)} ${parts.join('  ')}`);
}
