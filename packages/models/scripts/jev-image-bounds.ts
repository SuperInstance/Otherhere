// Map which image sizes Jev's direct-image path accepts (ADR-0013), using one
// real photo resized to a grid of short sides and aspect ratios, both orientations.
// Spends real money, but little: one single-question call per size (~$0.0005 each).
// Usage: TYPESAFEAI_KEY=… pnpm --filter @otherhere/models exec tsx scripts/jev-image-bounds.ts <photo.jpg>
import { execFileSync } from 'node:child_process';
import type { QuestionPack } from '@otherhere/core';
import { JevProvider, JevRejected, MemoryLedger, ModelRouter } from '../src/index';

const photo = process.argv[2];
if (!photo) throw new Error('usage: jev-image-bounds.ts <photo.jpg>');
const router = new ModelRouter({ caps: { jev: 1 }, ledger: new MemoryLedger() });
const jev = new JevProvider(router, { apiKey: process.env.TYPESAFEAI_KEY ?? '' });
const PACK: QuestionPack = {
  id: 'probe',
  version: '1',
  description: 'Probe: is the image accepted at all?',
  questions: {
    visible: {
      type: 'noul',
      instructions: 'Is a building visible?',
      criteria: { true: 'A building is visible.', false: 'No building is visible.' },
    },
  },
};

/** Centre-crop the photo to w×h's aspect, then resize to exactly w×h. */
const render = (w: number, h: number): string =>
  execFileSync('python3', [
    '-I',
    '-c',
    'import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");w,h=int(sys.argv[2]),int(sys.argv[3]);' +
      'W,H=im.size;a=w/h;cw,ch=(min(W,round(H*a)),min(H,round(W/a)));im=im.crop(((W-cw)//2,(H-ch)//2,(W-cw)//2+cw,(H-ch)//2+ch)).resize((w,h));' +
      'b=io.BytesIO();im.save(b,"JPEG",quality=85);sys.stdout.buffer.write(b.getvalue())',
    photo,
    String(w),
    String(h),
  ]).toString('base64');

const shorts = [224, 320, 400, 440, 447, 448, 449, 512, 720, 960];
const aspects = [1, 4 / 3, 16 / 9, 2, 2.05, 2.25, 2.5, 3];
const results: { w: number; h: number; ok: boolean; why: string }[] = [];
let cost = 0;
const jobs = shorts.flatMap((s) =>
  aspects.flatMap((a) => [
    [Math.round(s * a), s],
    [s, Math.round(s * a)],
  ]),
);
const unique = [...new Map(jobs.map(([w, h]) => [`${w}x${h}`, [w!, h!] as const])).values()];
for (let i = 0; i < unique.length; i += 8) {
  await Promise.all(
    unique.slice(i, i + 8).map(async ([w, h]) => {
      try {
        const r = await jev.askAboutImage(PACK, render(w, h), 'A photo taken in a street.');
        cost += r.costUsd;
        results.push({ w, h, ok: true, why: '' });
      } catch (err) {
        const why = err instanceof JevRejected ? err.detail : `ERROR ${(err as Error).message}`;
        results.push({ w, h, ok: false, why: why.replace(/\s+/g, ' ').slice(0, 140) });
      }
    }),
  );
}
results.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h) || a.w / a.h - b.w / b.h);
for (const r of results)
  console.log(
    `${`${r.w}x${r.h}`.padEnd(10)} short ${String(Math.min(r.w, r.h)).padStart(4)} aspect ${(Math.max(r.w, r.h) / Math.min(r.w, r.h)).toFixed(2)} ${r.ok ? 'ok' : `REFUSED ${r.why}`}`,
  );
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} accepted, $${cost.toFixed(4)}`,
);
