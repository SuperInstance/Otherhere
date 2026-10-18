// Review a diff against the brief's invariants with Jev: one Noul per invariant, asked of
// every hunk in one request per hunk (speculative fan-out). Checks that code can do
// exactly (which files changed) are done in code, as TypeSafe's docs advise.
// A local tool, not CI: it calls a paid API (invariant 9).
// Usage: TYPESAFE_AI_TOKEN=… pnpm --filter @otherhere/models exec tsx scripts/jev-review.ts [git-range]
//   default range: origin/main...HEAD.  THRESHOLD=0.5 sets when a hunk is flagged.
import { execFileSync } from 'node:child_process';
import type { QuestionPack } from '@otherhere/core';
import { JevProvider, MemoryLedger, ModelRouter } from '../src/index';

/** The invariants Jev is asked about, phrased literally (Jev reads literally). */
export const INVARIANTS: Record<string, { invariant: number; question: string }> = {
  paid_call_outside_router: {
    invariant: 9,
    question:
      "The added code sends a request to a paid AI model API (TypeSafe, Groq, MiniMax, Anthropic, OpenAI or similar) directly, for example with fetch or an SDK client, instead of through the project's ModelRouter (`router.run`).",
  },
  executes_model_output: {
    invariant: 3,
    question:
      'The added code runs text produced by an AI model as program code, for example with eval, new Function, a dynamic import of generated source, or by writing a script and executing it.',
  },
  nondeterministic_output: {
    invariant: 2,
    question:
      'The added code makes generated geometry, bundles, materials or other derived output depend on any unseeded source of randomness (Math.random, crypto.getRandomValues, crypto.randomUUID), on the current time or date, or on the order network responses arrive in, instead of only on stable IDs and Facts.',
  },
  google_imagery: {
    invariant: 8,
    question:
      'The added code fetches images or map data from Google Maps, Google Street View or another Google imagery service.',
  },
  shares_private_data: {
    invariant: 5,
    question:
      'The added code makes user photos, video, locations or captures visible to people other than their owner, or publishes them, without checking a privacy scope or blurring faces and licence plates.',
  },
  secret_in_code: {
    invariant: 0,
    question:
      'The added code contains a real-looking API key, access token or password written directly into the source, rather than read from the environment.',
  },
};

/**
 * Asked alongside the checks: text that *describes* a violation (a comment, a test name,
 * this file's own questions) reads to Jev like code that commits one. A high answer
 * here discounts every check for that hunk.
 */
const MENTIONS_ONLY =
  'The lines in `hunk` only mention or describe these things (in comments, documentation, string literals, test names or question text) rather than doing them.';

const PACK: QuestionPack = {
  id: 'pack.review.invariants',
  version: '1.1.0',
  description: 'Does a diff hunk break one of the project invariants?',
  questions: {
    ...Object.fromEntries(
      Object.entries(INVARIANTS).map(([id, q]) => [
        id,
        { type: 'noul', instructions: `In \`hunk\`: ${q.question}` },
      ]),
    ),
    mentions_only: { type: 'noul', instructions: MENTIONS_ONLY },
  },
};

export type Hunk = { file: string; added: string };

const WINDOW = 80;

/** Split a unified diff into hunks of added lines (removed lines cannot break anything new). */
export function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file = '';
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) out.push({ file, added: cur.join('\n') });
    cur = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      file = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@')) flush();
    else if (line.startsWith('+') && !line.startsWith('+++')) cur.push(line.slice(1));
  }
  flush();
  // Long hunks (a new file) become windows: a small, focused state answers better.
  return out
    .filter((h) => h.added.trim())
    .flatMap((h) => {
      const lines = h.added.split('\n');
      if (lines.length <= WINDOW) return [h];
      const parts: Hunk[] = [];
      for (let i = 0; i < lines.length; i += WINDOW)
        parts.push({ file: h.file, added: lines.slice(i, i + WINDOW).join('\n') });
      return parts;
    });
}

/** Exact, path-based checks: no model needed. */
export function pathFindings(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (/^packages\/judge\/(evals\/|src\/score\.ts|JUDGE\.lock\.json)/.test(f))
      out.push(`${f}: changes the fixed judge (invariant 6); needs the owner's review`);
  }
  return out;
}

/** Every check's probability for one hunk: the raw answer and the mention-discounted one. */
export async function scoreHunk(jev: JevProvider, h: Hunk) {
  const r = await jev.ask(PACK, { file: h.file, hunk: h.added });
  const m = r.value.mentions_only;
  const real = 1 - (m?.type === 'noul' ? m.noul : 0);
  return Object.fromEntries(
    Object.keys(INVARIANTS).map((id) => {
      const a = r.value[id];
      const raw = a?.type === 'noul' ? a.noul : 0;
      return [id, { raw, discounted: raw * real }];
    }),
  );
}

export async function review(jev: JevProvider, list: Hunk[], threshold = 0.5) {
  const flagged: { file: string; check: string; p: number; excerpt: string }[] = [];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(
      list.slice(i, i + 8).map(async (h) => {
        // State is only the hunk and its file: unrelated context costs Jev accuracy.
        const r = await jev.ask(PACK, { file: h.file, hunk: h.added });
        const mention = r.value.mentions_only;
        const real = 1 - (mention?.type === 'noul' ? mention.noul : 0);
        for (const id of Object.keys(INVARIANTS)) {
          const a = r.value[id];
          // P(violation) × P(it is code doing it, not text describing it).
          const p = a?.type === 'noul' ? a.noul * real : 0;
          if (p >= threshold)
            flagged.push({ file: h.file, check: id, p, excerpt: h.added.slice(0, 160) });
        }
      }),
    );
  }
  return flagged.sort((a, b) => b.p - a.p);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const range = process.argv[2] ?? 'origin/main...HEAD';
  // Diff from the repository root: a relative pathspec would only cover the current package.
  const root = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
  const diff = execFileSync('git', ['diff', '--unified=0', range, '--', ':!pnpm-lock.yaml'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  const list = hunks(diff);
  const jev = new JevProvider(new ModelRouter({ caps: { jev: 0.5 }, ledger: new MemoryLedger() }), {
    apiKey: process.env.TYPESAFE_AI_TOKEN ?? process.env.TYPESAFEAI_KEY ?? '',
  });
  for (const f of pathFindings([...new Set(list.map((h) => h.file))])) console.log(`PATH  ${f}`);
  const flagged = await review(jev, list, Number(process.env.THRESHOLD ?? 0.5));
  for (const f of flagged)
    console.log(
      `${f.p.toFixed(2)}  ${f.check}  ${f.file}\n      ${f.excerpt.replace(/\s+/g, ' ')}`,
    );
  console.log(`\n${list.length} hunks reviewed in ${range}, ${flagged.length} flagged.`);
}
