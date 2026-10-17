import { describe, expect, it } from 'vitest';
import { BUILTIN_GENERATORS } from '@otherhere/core';
import { MemoryLedger, ModelRouter } from '../src/router';
import { ClaudeProvider, ClaudeRefused } from '../src/providers/claude';

function anthropicFetch(text: string, stop_reason = 'end_turn') {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
    });
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text }],
        stop_reason,
        stop_details:
          stop_reason === 'refusal'
            ? { type: 'refusal', category: 'cyber', explanation: 'x' }
            : null,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return Object.assign(f, { calls });
}

const router = () => new ModelRouter({ caps: { claude: 5 }, ledger: new MemoryLedger() });

describe('ClaudeProvider', () => {
  it('authors a generator as validated data, with refusal fallbacks on', async () => {
    const def = {
      ...BUILTIN_GENERATORS.find((g) => g.id === 'prop.bench')!,
      id: 'prop.picnic-table',
    };
    const fetch = anthropicFetch('Here it is:\n' + JSON.stringify(def));
    const claude = new ClaudeProvider(router(), { apiKey: 'k', fetch });
    const r = await claude.authorGenerator('A picnic table');
    expect('def' in r.value && r.value.def.id).toBe('prop.picnic-table');
    expect(r.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
    const call = fetch.calls[0]!;
    expect(call.body.model).toBe('claude-opus-5-5');
    expect(call.body.fallbacks).toBe('default');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('reports validation errors instead of accepting bad generators', async () => {
    const claude = new ClaudeProvider(router(), {
      apiKey: 'k',
      fetch: anthropicFetch('{"id":"Bad Id","ops":[]}'),
    });
    const r = await claude.authorGenerator('anything');
    expect('errors' in r.value && r.value.errors.length).toBeGreaterThan(0);
  });

  it('turns a refusal into an error', async () => {
    const claude = new ClaudeProvider(router(), {
      apiKey: 'k',
      fetch: anthropicFetch('', 'refusal'),
    });
    await expect(claude.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeRefused);
  });
});
