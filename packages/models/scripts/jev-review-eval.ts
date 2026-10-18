// Measure jev-review on a labelled set of synthetic diff hunks (tuning/review-hunks.jsonl:
// written by MiniMax, labels read by hand, ambiguous ones excluded). Spends ~$0.001.
// Usage: TYPESAFE_AI_TOKEN=… pnpm --filter @otherhere/models exec tsx scripts/jev-review-eval.ts
import { readFileSync } from 'node:fs';
import { JevProvider, MemoryLedger, ModelRouter } from '../src/index';
import { INVARIANTS, scoreHunk } from './jev-review';

type Row = { check: string; file: string; code: string; violates: boolean; ambiguous?: boolean };
const rows = readFileSync(new URL('../tuning/review-hunks.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => !r.ambiguous);
const jev = new JevProvider(new ModelRouter({ caps: { jev: 0.5 }, ledger: new MemoryLedger() }), {
  apiKey: process.env.TYPESAFE_AI_TOKEN ?? process.env.TYPESAFEAI_KEY ?? '',
});
const T = Number(process.env.THRESHOLD ?? 0.5);
const scores: Awaited<ReturnType<typeof scoreHunk>>[] = [];
for (let i = 0; i < rows.length; i += 8)
  scores.push(
    ...(await Promise.all(
      rows.slice(i, i + 8).map((r) => scoreHunk(jev, { file: r.file, added: r.code })),
    )),
  );

for (const mode of ['raw', 'discounted'] as const) {
  console.log(
    `\n${mode} (threshold ${T})   check: TP FN FP TN on its own snippets | false alarms on other checks' snippets`,
  );
  let falseAlarms = 0;
  for (const check of Object.keys(INVARIANTS)) {
    const c = { tp: 0, fn: 0, fp: 0, tn: 0 };
    rows.forEach((r, i) => {
      const flagged = scores[i]![check]![mode] >= T;
      if (r.check === check) {
        const k = r.violates ? (flagged ? 'tp' : 'fn') : flagged ? 'fp' : 'tn';
        c[k]++;
        if (mode === 'discounted' && (k === 'fn' || k === 'fp'))
          console.log(
            `    ${k.toUpperCase()} ${r.file} (p=${scores[i]![check]![mode].toFixed(2)})`,
          );
      } else if (flagged && !(r.violates && crossViolation(r, check))) {
        falseAlarms++;
        if (mode === 'discounted')
          console.log(`    false alarm: ${check} on ${r.file} (written for ${r.check})`);
      }
    });
    console.log(`  ${check.padEnd(26)} ${c.tp} ${c.fn} ${c.fp} ${c.tn}`);
  }
  console.log(`  cross-check false alarms: ${falseAlarms}`);
}

/** A snippet written for one check can genuinely break another (e.g. a hard-coded key in a direct API call). */
function crossViolation(r: Row, check: string): boolean {
  return check === 'secret_in_code' && /sk-|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]/i.test(r.code);
}
