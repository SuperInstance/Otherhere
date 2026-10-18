import Anthropic from '@anthropic-ai/sdk';
import { GeneratorDef, BUILTIN_GENERATORS } from '@otherhere/core';
import type { ModelRouter, Pricing, Priced } from '../router';
import type { FetchLike } from './jev';

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const CLAUDE_PRICING: Pricing = { inputPerM: 4, outputPerM: 20 };

export class ClaudeRefused extends Error {}

/**
 * Claude: the rare, expensive author of new Generators and Question packs.
 * Its output is data, validated by zod and run only by our interpreter: it is
 * never executed as code (invariant 3).
 */
export class ClaudeProvider {
  readonly id = 'claude';
  private client: Anthropic;

  constructor(
    private router: ModelRouter,
    opts: { apiKey: string; fetch?: FetchLike; baseURL?: string },
  ) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.fetch ? { fetch: opts.fetch as typeof fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(system: string, user: string, maxTokens = 16000): Promise<Priced<string>> {
    const estimate =
      (((system.length + user.length) / 3) * CLAUDE_PRICING.inputPerM +
        maxTokens * CLAUDE_PRICING.outputPerM) /
      1_000_000;
    return this.router.run(this.id, estimate, CLAUDE_PRICING, async () => {
      const msg = await this.client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        // On a policy decline, let the API retry on its default fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: user }],
      });
      if (msg.stop_reason === 'refusal')
        throw new ClaudeRefused(`claude declined (${msg.stop_details?.category ?? 'unspecified'})`);
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        value: text,
        model: msg.model,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    });
  }

  /** Draft a new GeneratorDef from a description. Returns the validated def, or the validation errors. */
  async authorGenerator(
    description: string,
  ): Promise<Priced<{ def: GeneratorDef } | { errors: string[]; raw: string }>> {
    const example = BUILTIN_GENERATORS.find((g) => g.id === 'prop.bench')!;
    const system = [
      'You write generators for a stylized 3D world engine. A generator is a JSON document in a small geometry DSL; it is validated and interpreted, never executed.',
      'Ops: let, extrude, roof, windows, ribbon, box, cylinder, blob. Expressions: numbers, strings, booleans, {attr}, {param}, and {op} with add/sub/mul/div/min/max/eq/lt/gt/and/or/not/has/floor/clamp/rand/pick/if.',
      'Point features use `geometry: "position"`, with `at` offsets as [east, up, north] metres. Use `rand`/`pick` with a `key` for any variation; never use other randomness.',
      'Reply with the JSON document only.',
      `Example:\n${JSON.stringify(example, null, 2)}`,
    ].join('\n\n');
    const r = await this.complete(system, description, 8000);
    const raw = r.value;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return { ...r, value: { errors: ['response was not JSON'], raw } };
    }
    const v = GeneratorDef.safeParse(parsed);
    return {
      ...r,
      value: v.success
        ? { def: v.data }
        : { errors: v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), raw },
    };
  }
}
