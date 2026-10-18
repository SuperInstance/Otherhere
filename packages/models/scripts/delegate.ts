// Hand a coding task to a cheaper model and get files back for review. A local tool, not
// CI or runtime: it calls a paid API (invariant 9) and its output is only ever written to
// a scratch directory as text. Nothing it returns is run (invariant 3); a person or agent
// reviews it, then copies what is good into the repository.
//
// Prompt layout is for prefix caching: the system prompt and the context files come first
// and in a fixed order, the task last, so a second task over the same files is mostly a
// cache hit. Every call is appended to tuning/delegate-log.jsonl (model, tokens, cache
// hits, cost, seconds) so the process can be compared and improved over time.
//
// Usage: pnpm --filter @otherhere/models exec tsx scripts/delegate.ts \
//          --task task.md --out <dir> [--model deepseek-flash|glm-4.7|MiniMax-M3] [context files…]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

type Provider = { url: string; key: string | undefined; inPerM: number; hitPerM: number; outPerM: number };

/** OpenAI-compatible endpoints. Prices are USD per million tokens, for the log only. */
const PROVIDERS: Record<string, Provider> = {
  'deepseek-flash': {
    url: 'https://api.deepseek.com/chat/completions',
    key: process.env.DEEPSEEK_TOKEN,
    inPerM: 0.14,
    hitPerM: 0.014,
    outPerM: 0.28,
  },
  'glm-4.7': {
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    key: process.env.Z_AI_TOKEN,
    inPerM: 0,
    hitPerM: 0,
    outPerM: 0,
  },
  'MiniMax-M3': {
    url: 'https://api.minimax.io/v1/chat/completions',
    key: process.env.MINIMAX_KEY,
    inPerM: 0,
    hitPerM: 0,
    outPerM: 0,
  },
};

export const SYSTEM = [
  'You are a senior TypeScript engineer contributing to a monorepo. You are given files from it, then a task.',
  'Match the surrounding code: its naming, comment density and idiom. Strict TypeScript, no `any`, no new dependencies unless the task allows them.',
  'Reply with complete files only, each as:',
  '=== FILE: <repo-relative path> ===',
  '<entire file content>',
  '=== END FILE ===',
  'After the files, add a section "=== NOTES ===" listing assumptions and anything you were unsure of. Do not wrap files in markdown fences.',
].join('\n');

/** Parse `=== FILE: p ===` blocks. Paths are kept inside the output directory. */
export function parseFiles(text: string): { files: { path: string; body: string }[]; notes: string } {
  const files: { path: string; body: string }[] = [];
  const re = /=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===/g;
  for (const m of text.matchAll(re)) {
    const path = normalize(m[1]!.trim()).replace(/^(\.\.(\/|$))+/, '');
    if (path.startsWith('/')) continue;
    files.push({ path, body: m[2]! + '\n' });
  }
  const notes = text.split('=== NOTES ===')[1]?.trim() ?? '';
  return { files, notes };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
  const model = arg('--model') ?? 'deepseek-flash';
  const p = PROVIDERS[model];
  if (!p?.key) throw new Error(`no key for ${model}`);
  const task = readFileSync(arg('--task')!, 'utf8');
  const out = arg('--out')!;
  const flags = new Set(['--task', '--out', '--model', '--effort']);
  const context = process.argv
    .slice(2)
    .filter((a, i, all) => !flags.has(a) && !flags.has(all[i - 1]!))
    .sort(); // a fixed order keeps the cached prefix identical between tasks
  const files = context
    .map((f) => `=== CONTEXT: ${f} ===\n${readFileSync(join(root, f), 'utf8')}`)
    .join('\n\n');
  const t0 = Date.now();
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      // Reasoning tokens count toward this: at 32k, deepseek-flash spent all of them
      // thinking and returned no content (tuning/delegate-log.jsonl, first entry).
      max_tokens: 160_000,
      ...(arg('--effort') ? { reasoning_effort: arg('--effort') } : {}),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${files}\n\n=== TASK ===\n${task}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    choices: { message: { content: string; reasoning_content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const text = (body.choices[0]!.message.content ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const u = body.usage ?? {};
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = (u.prompt_tokens ?? 0) - hit;
  const usd = (miss * p.inPerM + hit * p.hitPerM + (u.completion_tokens ?? 0) * p.outPerM) / 1e6;
  const parsed = parseFiles(text);
  mkdirSync(out, { recursive: true });
  for (const f of parsed.files) {
    mkdirSync(dirname(join(out, f.path)), { recursive: true });
    writeFileSync(join(out, f.path), f.body);
  }
  writeFileSync(join(out, 'REPLY.txt'), text);
  const entry = {
    at: new Date().toISOString(),
    model,
    task: task.split('\n')[0]!.slice(0, 120),
    context: context.length,
    promptTokens: u.prompt_tokens,
    cacheHitTokens: hit,
    outputTokens: u.completion_tokens,
    reasoningTokens:
      u.completion_tokens_details?.reasoning_tokens ??
      Math.round((body.choices[0]!.message.reasoning_content?.length ?? 0) / 4),
    finish: body.choices[0]!.finish_reason,
    effort: arg('--effort') ?? 'default',
    usd: Number(usd.toFixed(5)),
    seconds: (Date.now() - t0) / 1000,
    files: parsed.files.map((f) => f.path),
  };
  appendFileSync(join(root, 'packages/models/tuning/delegate-log.jsonl'), JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry, null, 2));
  if (parsed.notes) console.log(`\nNOTES:\n${parsed.notes}`);
}
