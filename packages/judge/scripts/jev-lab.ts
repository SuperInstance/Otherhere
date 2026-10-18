// Jev technique lab (round 2 in docs/notes/model-field-notes.md): request variants from the
// TypeSafe docs and recent papers, each run twice on the tuning photos (dev) and the judge's
// photos (held out). Spends real money, but little: ~$0.10 for every variant.
// Usage: TYPESAFE_AI_TOKEN=… pnpm --filter @otherhere/judge exec tsx scripts/jev-lab.ts [V0,V6,…]
//   OUT=path.json keeps every answer, with probabilities, for offline analysis.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILDING_PACK, type Answers, type Answer } from '@otherhere/core';
import {
  fitForJev,
  JEV_PRICING,
  MemoryLedger,
  ModelRouter,
  VISION_PROMPT,
} from '@otherhere/models';
import { parsePhotos, scoreCase, summarize } from '../src/index';

const KEY = process.env.TYPESAFE_AI_TOKEN ?? '';
const OUT = process.env.OUT ?? 'jev-lab.result.json';
let tokens = 0;
// Raw requests (any state shape, any model) still go through the router: capped and costed (invariant 9).
const router = new ModelRouter({ caps: { jev: 1 }, ledger: new MemoryLedger() });
async function jev(
  model: string,
  state: unknown,
  assets: Record<string, string>,
  questions: Record<string, unknown>,
) {
  const body = {
    model,
    state,
    assets: Object.fromEntries(
      Object.entries(assets).map(([k, b64]) => [
        k,
        { type: 'image', format: 'jpg', data_base64: b64 },
      ]),
    ),
    questions,
  };
  const estimate = (JSON.stringify(body).length / 3 / 1e6) * JEV_PRICING.inputPerM;
  return (
    await router.run('jev', estimate, JEV_PRICING, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${KEY}`,
            'content-type': 'application/json',
            'TypeSafe-Danger-Zone-Images': 'true',
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        const j = (await res.json()) as {
          answers: Record<string, unknown>;
          usage: { input_tokens: number };
          model: string;
        };
        tokens += j.usage.input_tokens;
        return {
          value: j,
          model: j.model,
          usage: { inputTokens: j.usage.input_tokens, outputTokens: 0 },
        };
      }
      throw new Error('rate limited');
    })
  ).value;
}

const py = (script: string, ...args: string[]) =>
  execFileSync('python3', [
    '-I',
    '-c',
    `import sys,io,json;from PIL import Image;${script}`,
    ...args,
  ]);
/** crop (fractions) then fit for Jev; returns base64 jpeg */
function prep(path: string, crop = { left: 0, top: 0, right: 1, bottom: 1 }): string {
  const [w, h] = JSON.parse(
    py('print(json.dumps(Image.open(sys.argv[1]).size))', path).toString(),
  ) as [number, number];
  const [l, t, r, b] = [
    Math.round(crop.left * w),
    Math.round(crop.top * h),
    Math.round(crop.right * w),
    Math.round(crop.bottom * h),
  ];
  const cw = Math.max(1, r - l),
    ch = Math.max(1, b - t);
  const f = fitForJev(cw, ch);
  const ox = l + Math.floor((cw - f.crop.width) / 2),
    oy = t + Math.floor((ch - f.crop.height) / 2);
  return py(
    'im=Image.open(sys.argv[1]).convert("RGB");x,y,W,H,a,b=map(int,sys.argv[2:8]);im=im.crop((x,y,x+W,y+H)).resize((a,b));o=io.BytesIO();im.save(o,"JPEG",quality=90);sys.stdout.buffer.write(o.getvalue())',
    path,
    String(ox),
    String(oy),
    String(f.crop.width),
    String(f.crop.height),
    String(f.width),
    String(f.height),
  ).toString('base64');
}

// Photo-native pack: same IDs and options, instructions that point at `photo`.
type Q = { type: string; instructions: string; criteria?: Record<string, string> };
const base = BUILDING_PACK.questions as unknown as Record<string, Q>;
const NEAREST = 'the building nearest the centre of `photo`';
const PHOTO_PACK: Record<string, Q> = {
  visible: {
    type: 'noul',
    instructions:
      "`photo` clearly shows one building's exterior near its centre, well enough to judge its shape or colour.",
    criteria: {
      true: 'One building stands out near the centre and its walls or roof can be seen.',
      false:
        'No building, only a close-up of a wall or material, an interior, a structure under construction, or several buildings with none standing out.',
    },
  },
  roof_shape: { ...base.roof_shape!, instructions: `Which roof shape does ${NEAREST} have?` },
  floors: {
    ...base.floors!,
    instructions: `How many above-ground floors does ${NEAREST} have, counting the ground floor?`,
  },
  wall_colour: {
    ...base.wall_colour!,
    instructions: `What is the main colour of the walls of ${NEAREST}?`,
  },
  roof_colour: { ...base.roof_colour!, instructions: `What colour is the roof of ${NEAREST}?` },
};
const HYBRID: Record<string, Q> = {
  ...PHOTO_PACK,
  visible: {
    ...base.visible!,
    instructions: "The `photo` clearly shows a single building's exterior.",
  },
};
const reversed = (qs: Record<string, Q>) =>
  Object.fromEntries(
    Object.entries(qs).map(([k, q]) => [
      k,
      q.type === 'choice'
        ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria!).reverse()) }
        : q,
    ]),
  );
const FLOOR_STEPS = [2, 3, 4, 5, 6, 9, 15];
const floorNouls = Object.fromEntries(
  FLOOR_STEPS.map((k) => [
    `floors_ge_${k}`,
    {
      type: 'noul',
      instructions: `${NEAREST[0]!.toUpperCase()}${NEAREST.slice(1)} has at least ${k} above-ground floors (storeys), counting the ground floor.`,
    },
  ]),
);
function floorsFromNouls(a: Record<string, { noul: number }>): string {
  let top = 1;
  for (const k of FLOOR_STEPS) {
    if ((a[`floors_ge_${k}`]?.noul ?? 0) > 0.5) top = k;
    else break;
  }
  return top >= 15 ? '15+' : top >= 9 ? '9-14' : top >= 6 ? '6-8' : String(top);
}
const asAnswers = (a: Record<string, unknown>) => a as Answers;
function averageOrders(x: Answers, y: Answers): Answers {
  const out: Answers = { ...x };
  for (const k of Object.keys(x)) {
    const a = x[k] as Answer & { probabilities?: Record<string, number> },
      b = y[k] as typeof a;
    if (a?.type === 'choice' && b?.type === 'choice' && a.probabilities && b.probabilities) {
      const p: Record<string, number> = {};
      for (const o of Object.keys(a.probabilities))
        p[o] = ((a.probabilities[o] ?? 0) + (b.probabilities[o] ?? 0)) / 2;
      const [choice, prob] = Object.entries(p).sort((u, v) => v[1] - u[1])[0]!;
      out[k] = { type: 'choice', choice, confidence: prob, probabilities: p };
    }
  }
  return out;
}

type Variant = (path: string) => Promise<Answers>;
const REF = 'f3b9c2d4-photo';
const variants: Record<string, Variant> = {
  V0_baseline_113: async (p) =>
    asAnswers(
      (await jev('jev-1.13.0', `${VISION_PROMPT}\n${REF}`, { [REF]: prep(p) }, base)).answers,
    ),
  V1_baseline_114: async (p) =>
    asAnswers(
      (await jev('jev-1.14.0', `${VISION_PROMPT}\n${REF}`, { [REF]: prep(p) }, base)).answers,
    ),
  V2_native_113: async (p) =>
    asAnswers((await jev('jev-1.13.0', { photo: REF }, { [REF]: prep(p) }, PHOTO_PACK)).answers),
  V2_native_114: async (p) =>
    asAnswers((await jev('jev-1.14.0', { photo: REF }, { [REF]: prep(p) }, PHOTO_PACK)).answers),
  V3_native_nounfloors_114: async (p) => {
    const a = (
      await jev('jev-1.14.0', { photo: REF }, { [REF]: prep(p) }, { ...PHOTO_PACK, ...floorNouls })
    ).answers as Record<string, { noul: number }>;
    const out = asAnswers(a);
    out.floors = { type: 'choice', choice: floorsFromNouls(a), confidence: 1 };
    return out;
  },
  V4_native_bothorders_114: async (p) => {
    const img = prep(p);
    const [x, y] = await Promise.all([
      jev('jev-1.14.0', { photo: REF }, { [REF]: img }, PHOTO_PACK),
      jev('jev-1.14.0', { photo: REF }, { [REF]: img }, reversed(PHOTO_PACK)),
    ]);
    return averageOrders(asAnswers(x.answers), asAnswers(y.answers));
  },
  V6_base_bothorders_113: async (p) => {
    const img = prep(p);
    const [x, y] = await Promise.all([
      jev('jev-1.13.0', `${VISION_PROMPT}\n${REF}`, { [REF]: img }, base),
      jev('jev-1.13.0', `${VISION_PROMPT}\n${REF}`, { [REF]: img }, reversed(base)),
    ]);
    return averageOrders(asAnswers(x.answers), asAnswers(y.answers));
  },
  V7_hybrid_113: async (p) =>
    asAnswers((await jev('jev-1.13.0', { photo: REF }, { [REF]: prep(p) }, HYBRID)).answers),
  V8_hybrid_bothorders_113: async (p) => {
    const img = prep(p);
    const [x, y] = await Promise.all([
      jev('jev-1.13.0', { photo: REF }, { [REF]: img }, HYBRID),
      jev('jev-1.13.0', { photo: REF }, { [REF]: img }, reversed(HYBRID)),
    ]);
    return averageOrders(asAnswers(x.answers), asAnswers(y.answers));
  },
  V9_hybrid_bothorders_114: async (p) => {
    const img = prep(p);
    const [x, y] = await Promise.all([
      jev('jev-1.14.0', { photo: REF }, { [REF]: img }, HYBRID),
      jev('jev-1.14.0', { photo: REF }, { [REF]: img }, reversed(HYBRID)),
    ]);
    return averageOrders(asAnswers(x.answers), asAnswers(y.answers));
  },
  V5_native_boxcrop_114: async (p) => {
    const full = await jev(
      'jev-1.14.0',
      { photo: REF },
      { [REF]: prep(p) },
      { ...PHOTO_PACK, where: { type: 'box', instructions: `${NEAREST}` } },
    );
    const b = (
      full.answers.where as { box: { left: number; top: number; right: number; bottom: number } }
    ).box;
    const pad = 0.05;
    const crop = {
      left: Math.max(0, b.left - pad),
      top: Math.max(0, b.top - pad),
      right: Math.min(1, b.right + pad),
      bottom: Math.min(1, b.bottom + pad),
    };
    const cropped = await jev(
      'jev-1.14.0',
      { photo: REF },
      { [REF]: prep(p, crop) },
      {
        roof_shape: PHOTO_PACK.roof_shape,
        floors: PHOTO_PACK.floors,
        wall_colour: PHOTO_PACK.wall_colour,
        roof_colour: PHOTO_PACK.roof_colour,
      },
    );
    return { ...asAnswers(full.answers), ...asAnswers(cropped.answers) };
  },
};

const sets = [
  {
    name: 'dev',
    root: new URL('../../models/tuning/', import.meta.url),
    file: 'building-photos.dev.jsonl',
  },
  {
    name: 'test',
    root: new URL('../evals/truth/', import.meta.url),
    file: 'building-photos.v1.jsonl',
  },
];
const only = process.argv[2]?.split(',');
const dump: Record<string, unknown> = {};
for (const [name, v] of Object.entries(variants)) {
  if (only && !only.some((o) => name.startsWith(o))) continue;
  const line: string[] = [];
  for (const set of sets) {
    const cases = parsePhotos(readFileSync(new URL(set.file, set.root), 'utf8'));
    const total = summarize(cases.map((c) => scoreCase(c, null))).total;
    const runs: number[] = [];
    for (let r = 0; r < 2; r++) {
      const answers: (Answers | null)[] = [];
      for (let i = 0; i < cases.length; i += 6)
        answers.push(
          ...(await Promise.all(
            cases.slice(i, i + 6).map((c) =>
              v(new URL(c.image, set.root).pathname).catch((e) => {
                console.error(name, c.id, (e as Error).message.slice(0, 120));
                return null;
              }),
            ),
          )),
        );
      dump[`${name}/${set.name}/${r}`] = cases.map((c, i) => ({
        id: c.id,
        answers: answers[i],
        misses: scoreCase(c, answers[i]!).misses,
      }));
      runs.push(summarize(cases.map((c, i) => scoreCase(c, answers[i]!))).correct);
    }
    line.push(`${set.name} ${runs.join(' ')}/${total}`);
  }
  console.log(`${name.padEnd(26)} ${line.join('   ')}`);
  writeFileSync(OUT, JSON.stringify(dump));
}
console.log(`input tokens ${tokens} (~$${((tokens * 0.042) / 1e6).toFixed(4)} at $0.042/M)`);
