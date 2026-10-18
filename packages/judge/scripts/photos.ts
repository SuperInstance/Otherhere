// Compare the two ADR-0013 pipelines on the fixed photo eval (spends real money: ~$0.02).
//   A: Groq vision → written observation → Jev        (the accepted default)
//   B: Jev reading the image directly ("danger zone"), centre-cropped to ≤ 2:1, short side ≥ 448 px  (the candidate)
// Usage: GROQ_KEY=… TYPESAFEAI_KEY=… pnpm --filter @otherhere/judge photos
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILDING_PACK } from '@otherhere/core';
import {
  ChatProvider,
  JevProvider,
  MemoryLedger,
  ModelRouter,
  VISION_PROMPT,
} from '@otherhere/models';
import { parsePhotos, scoreCase, summarize, type CaseScore } from '../src/index';

const root = new URL('../evals/truth/', import.meta.url);
const cases = parsePhotos(readFileSync(new URL('building-photos.v1.jsonl', root), 'utf8'));
const router = new ModelRouter({ caps: { jev: 0.5, groq: 0.5 }, ledger: new MemoryLedger() });
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

const a: CaseScore[] = [];
const b: CaseScore[] = [];
let costA = 0;
let costB = 0;
for (const c of cases) {
  const img = readFileSync(new URL(c.image, root)).toString('base64');
  const seen = await groq.describe(img, VISION_PROMPT);
  const viaText = await jev.ask(BUILDING_PACK, seen.value);
  costA += seen.costUsd + viaText.costUsd;
  a.push(scoreCase(c, viaText.value));
  try {
    const direct = await jev.askAboutImage(
      BUILDING_PACK,
      cropForJev(new URL(c.image, root).pathname),
      VISION_PROMPT,
    );
    costB += direct.costUsd;
    b.push(scoreCase(c, direct.value));
  } catch (err) {
    // A rejected image scores zero: it is a real failure of that pipeline.
    const s = scoreCase(c, null);
    b.push({ ...s, misses: [`error: ${(err as Error).message.slice(0, 120)}`] });
  }
  console.log(`${c.id}  A ${a.at(-1)!.correct}/${a.at(-1)!.total} ${a.at(-1)!.misses.join('; ')}`);
  console.log(
    `${' '.repeat(c.id.length)}  B ${b.at(-1)!.correct}/${b.at(-1)!.total} ${b.at(-1)!.misses.join('; ')}`,
  );
}
const sa = summarize(a);
const sb = summarize(b);
console.log(
  `\nA vision→Jev:  ${(sa.accuracy * 100).toFixed(1)}% (${sa.correct}/${sa.total}), $${costA.toFixed(4)}`,
);
console.log(
  `B Jev direct:  ${(sb.accuracy * 100).toFixed(1)}% (${sb.correct}/${sb.total}), $${costB.toFixed(4)}`,
);
