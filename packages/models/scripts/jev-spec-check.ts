// Check delegated code against its spec with Jev: one Noul per requirement, "the code does
// X", asked of each file in one request. It points the reviewer at what a draft probably
// skipped before anyone reads it line by line; it is a triage, not a proof.
// A local tool, not CI: it calls a paid API (invariant 9).
// Usage: TYPESAFE_AI_TOKEN=… pnpm --filter @otherhere/models exec tsx scripts/jev-spec-check.ts \
//          <checklist.txt> <file…>
//   checklist: one requirement per line, `id: requirement`, phrased as a literal claim
//   about the code. Lines starting with # are comments.
import { readFileSync } from 'node:fs';
import type { QuestionPack } from '@otherhere/core';
import { JevProvider, MemoryLedger, ModelRouter } from '../src/index';

export function parseChecklist(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z0-9_]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function specPack(checks: Record<string, string>): QuestionPack {
  return {
    id: 'pack.review.spec',
    version: '1.0.0',
    description: 'Does a source file do what its spec asks?',
    questions: Object.fromEntries(
      Object.entries(checks).map(([id, q]) => [
        id,
        { type: 'noul', instructions: `In \`code\`, read literally: ${q}` },
      ]),
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [checklist, ...files] = process.argv.slice(2);
  const checks = parseChecklist(readFileSync(checklist!, 'utf8'));
  const jev = new JevProvider(new ModelRouter({ caps: { jev: 0.5 }, ledger: new MemoryLedger() }), {
    apiKey: process.env.TYPESAFE_AI_TOKEN ?? '',
  });
  for (const f of files) {
    const r = await jev.ask(specPack(checks), { file: f, code: readFileSync(f, 'utf8') });
    console.log(`\n${f}  ($${r.costUsd.toFixed(5)})`);
    const rows = Object.keys(checks).map((id) => {
      const a = r.value[id];
      return { id, p: a?.type === 'noul' ? a.noul : NaN };
    });
    for (const { id, p } of rows.sort((a, b) => a.p - b.p))
      console.log(`  ${p < 0.5 ? 'MISS' : '  ok'}  ${p.toFixed(2)}  ${id}`);
  }
}
