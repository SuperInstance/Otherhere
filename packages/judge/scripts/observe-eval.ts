// Live check of the production photo path (`observeBuilding`): vision model → Ladder (Jev)
// → per-field Facts, with Jev's visibility gate. Scores the Facts it would write, with and
// without the gate, on the tuning photos (dev) and the judge's photos (held out).
// Spends real money: ~35 vision calls and ~70 Jev calls per run.
// Usage: TYPESAFE_AI_TOKEN=… MINIMAX_KEY=… [GROQ_TOKEN=…] RUNS=2 pnpm --filter @otherhere/judge exec tsx scripts/observe-eval.ts
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildingFacts, fitForJev, type Fact } from '@otherhere/core';
import {
  ChatProvider,
  JevProvider,
  jevRung,
  Ladder,
  MemoryLedger,
  ModelRouter,
  observeBuilding,
} from '@otherhere/models';
import { parsePhotos, type Expected } from '../src/index';

const RUNS = Number(process.env.RUNS ?? 2);
const ledger = new MemoryLedger();
const router = new ModelRouter({ caps: { jev: 2, groq: 2, minimax: 2 }, ledger });
const groqKey = process.env.GROQ_TOKEN ?? process.env.GROQ_KEY;
const vision = groqKey
  ? new ChatProvider(router, 'groq', { apiKey: groqKey })
  : new ChatProvider(router, 'minimax', { apiKey: process.env.MINIMAX_KEY ?? '', maxTokens: 4000 });
const jev = new JevProvider(router, {
  apiKey: process.env.TYPESAFE_AI_TOKEN ?? process.env.TYPESAFEAI_KEY ?? '',
});
const ladder = new Ladder([jevRung(jev)], { log: () => {} });

/** The photo as the client sends it: long side ≤ 1280, every side in Jev's range. */
function asSent(path: string): string {
  const [w, h] = JSON.parse(
    execFileSync('python3', [
      '-I',
      '-c',
      'import sys,json;from PIL import Image;print(json.dumps(Image.open(sys.argv[1]).size))',
      path,
    ]).toString(),
  ) as [number, number];
  const k = Math.min(1, 1280 / Math.max(w, h));
  const f = fitForJev(Math.round(w * k), Math.round(h * k));
  const [sw, sh] = [f.crop.width / k, f.crop.height / k];
  return execFileSync('python3', [
    '-I',
    '-c',
    'import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");x,y,W,H=map(float,sys.argv[2:6]);' +
      'im=im.crop((round(x),round(y),round(x+W),round(y+H))).resize((int(sys.argv[6]),int(sys.argv[7])));' +
      'b=io.BytesIO();im.save(b,"JPEG",quality=85);sys.stdout.buffer.write(b.getvalue())',
    path,
    ...[(w - sw) / 2, (h - sh) / 2, sw, sh, f.width, f.height].map(String),
  ]).toString('base64');
}

const ATTR: Record<string, keyof Expected> = {
  'roof.shape': 'roof_shape',
  levels: 'floors',
  colour: 'wall_colour',
  'roof.colour': 'roof_colour',
};
/** Facts → right / wrong / written for a photo with no single building. */
function grade(facts: Fact[], e: Expected, raw: Record<string, string>) {
  const g = [0, 0, 0];
  for (const f of facts) {
    if (!e.visible) g[2]!++;
    else {
      const q = ATTR[f.attribute]!;
      if (e[q] !== undefined) g[raw[q] === e[q] ? 0 : 1]!++;
    }
  }
  return g;
}

const sets = [
  {
    name: 'dev',
    root: new URL('../../models/tuning/', import.meta.url),
    file: 'building-photos.dev.jsonl',
  },
  {
    name: 'held-out',
    root: new URL('../evals/truth/', import.meta.url),
    file: 'building-photos.v1.jsonl',
  },
];
console.log(`vision: ${vision.id}`);
for (const set of sets) {
  const cases = parsePhotos(readFileSync(new URL(set.file, set.root), 'utf8'));
  const images = cases.map((c) => asSent(new URL(c.image, set.root).pathname));
  for (let r = 0; r < RUNS; r++) {
    const withGate = [0, 0, 0];
    const without = [0, 0, 0];
    let gated = 0;
    let failed = 0;
    for (let i = 0; i < cases.length; i += 4) {
      await Promise.all(
        cases.slice(i, i + 4).map(async (c, j) => {
          const input = {
            jpegBase64: images[i + j]!,
            featureId: c.id,
            source: 'capture' as const,
            observedAt: new Date().toISOString(),
          };
          try {
            const obs = await observeBuilding(input, { vision, ladder, gate: jev });
            const answers = obs.result?.decision.answers;
            if (!answers) return;
            const raw = Object.fromEntries(
              Object.entries(answers).flatMap(([k, a]) =>
                a.type === 'choice' ? [[k, a.choice]] : [],
              ),
            );
            if ('noul' in obs.gate) gated++;
            withGate.forEach((_, k) => (withGate[k]! += grade(obs.facts, c.expected, raw)[k]!));
            const ungated = buildingFacts(answers, input);
            without.forEach((_, k) => (without[k]! += grade(ungated, c.expected, raw)[k]!));
          } catch (err) {
            failed++;
            console.error(`${c.id}: ${(err as Error).message.slice(0, 120)}`);
          }
        }),
      );
    }
    console.log(
      `${set.name} run ${r + 1}: with gate ${withGate.join('/')}   without ${without.join('/')}   (right/wrong/no-building; gate answered ${gated}/${cases.length}, ${failed} failed)`,
    );
  }
}
const day = new Date().toISOString().slice(0, 10);
const spend = await Promise.all(
  ['jev', vision.id].map(async (p) => `${p} $${(await ledger.spent(p, day)).toFixed(4)}`),
);
console.log(`spend: ${spend.join(', ')}`);
