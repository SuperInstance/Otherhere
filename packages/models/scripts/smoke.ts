// Live smoke test of the real providers (spends real money, a fraction of a cent).
// Never run in CI. Usage: GROQ_KEY=… TYPESAFEAI_KEY=… pnpm --filter @otherhere/models smoke <image.(png|jpg)>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { DecisionLog } from '@otherhere/core';
import {
  ChatProvider,
  JevProvider,
  Ladder,
  MemoryLedger,
  ModelRouter,
  jevRung,
  llmRung,
  observeBuilding,
} from '../src/index';

const path = process.argv[2];
if (!path || !process.env.GROQ_KEY || !process.env.TYPESAFEAI_KEY) {
  console.error('usage: GROQ_KEY=… TYPESAFEAI_KEY=… [MINIMAX_KEY=…] smoke <image>');
  process.exit(1);
}
// Send a JPEG; convert with Python/Pillow if given something else.
const jpeg = path.endsWith('.jpg')
  ? readFileSync(path)
  : execFileSync('python3', [
      '-I',
      '-c',
      'import sys,io;from PIL import Image;b=io.BytesIO();Image.open(sys.argv[1]).convert("RGB").save(b,"JPEG",quality=85);sys.stdout.buffer.write(b.getvalue())',
      path,
    ]);

const ledger = new MemoryLedger();
const router = new ModelRouter({ caps: { groq: 0.1, jev: 0.1, minimax: 0.1 }, ledger });
const vision = new ChatProvider(router, 'groq', { apiKey: process.env.GROQ_KEY });
const rungs = [jevRung(new JevProvider(router, { apiKey: process.env.TYPESAFEAI_KEY }))];
if (process.env.MINIMAX_KEY)
  rungs.push(
    llmRung(
      new ChatProvider(router, 'minimax', { apiKey: process.env.MINIMAX_KEY, maxTokens: 2000 }),
    ),
  );
const logs: DecisionLog[] = [];
const ladder = new Ladder(rungs, { log: (d) => void logs.push(d) });

const r = await observeBuilding(
  {
    jpegBase64: jpeg.toString('base64'),
    featureId: 'osm:w1',
    source: 'capture',
    observedAt: new Date().toISOString(),
  },
  { vision, ladder },
);
console.log('OBSERVATION\n', r.observation);
console.log('\nLADDER');
for (const l of logs)
  console.log(
    ` ${l.rung.padEnd(8)} ${l.outcome.padEnd(10)} conf=${l.confidence.toFixed(2)} cost=$${l.costUsd.toFixed(6)} ${l.latencyMs}ms ${l.error ?? ''}`,
  );
console.log('\nANSWERS', JSON.stringify(r.result?.decision.answers, null, 1));
console.log('\nFACTS');
for (const f of r.facts)
  console.log(` ${f.attribute} = ${JSON.stringify(f.value)} (confidence ${f.confidence})`);
console.log(`\nvision cost $${r.visionCostUsd.toFixed(6)}`);
