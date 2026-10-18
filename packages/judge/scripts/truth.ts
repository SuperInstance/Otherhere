// Score the live Ladder against the truth eval (spends real money: ~$0.01).
// Usage: TYPESAFEAI_KEY=… pnpm --filter @otherhere/judge truth
import { readFileSync } from 'node:fs';
import { BUILDING_PACK } from '@otherhere/core';
import { JevProvider, MemoryLedger, ModelRouter } from '@otherhere/models';
import { parseTruth, scoreCase, summarize } from '../src/index';

const cases = parseTruth(
  readFileSync(new URL('../evals/truth/building-observations.v1.jsonl', import.meta.url), 'utf8'),
);
const router = new ModelRouter({ caps: { jev: 0.25 }, ledger: new MemoryLedger() });
const jev = new JevProvider(router, { apiKey: process.env.TYPESAFEAI_KEY ?? '' });
let cost = 0;
const scores = [];
for (const c of cases) {
  const r = await jev.ask(BUILDING_PACK, c.observation);
  cost += r.costUsd;
  const s = scoreCase(c, r.value);
  scores.push(s);
  console.log(`${c.id} ${s.correct}/${s.total} ${s.misses.join('; ')}`);
}
const sum = summarize(scores);
console.log(
  `\nJev on building-observations.v1: ${(sum.accuracy * 100).toFixed(1)}% (${sum.correct}/${sum.total}), cost $${cost.toFixed(4)}`,
);
