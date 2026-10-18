import { failedResponse, type ModelRouter, type Pricing, type Priced } from '../router';
import type { FetchLike } from './jev';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content:
    string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
};

/** Placeholder rates; set real ones in config. */
export const CHAT_DEFAULTS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    pricing: { inputPerM: 0.3, outputPerM: 0.6 },
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-M3',
    pricing: { inputPerM: 0.3, outputPerM: 1.2 },
  },
} as const;

/**
 * Reasoning models may prefix their answer with a <think> block; we keep only the answer.
 * A block left open (the reply ran out of tokens while thinking) leaves no answer at all.
 */
export const stripThinking = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim();

/**
 * An OpenAI-compatible chat endpoint (Groq, MiniMax). Used as the vision rung
 * (pixels → a written observation) and as an LLM rung that answers packs.
 */
export class ChatProvider {
  constructor(
    private router: ModelRouter,
    readonly id: 'groq' | 'minimax',
    private opts: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      pricing?: Pricing;
      fetch?: FetchLike;
      maxTokens?: number;
    },
  ) {}

  async complete(
    messages: ChatMessage[],
    opts: { maxTokens?: number; json?: boolean } = {},
  ): Promise<Priced<string>> {
    const d = CHAT_DEFAULTS[this.id];
    const pricing = this.opts.pricing ?? d.pricing;
    const maxTokens = opts.maxTokens ?? this.opts.maxTokens ?? 800;
    const chars = JSON.stringify(messages).length;
    // Images dominate request size but not tokens; cap the input estimate at 8k tokens.
    const estimate =
      (Math.min(chars / 3, 8000) * pricing.inputPerM + maxTokens * pricing.outputPerM) / 1_000_000;
    return this.router.run(this.id, estimate, pricing, async () => {
      const res = await (this.opts.fetch ?? fetch)(
        `${this.opts.baseUrl ?? d.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.opts.model ?? d.model,
            max_tokens: maxTokens,
            messages,
            ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        },
      );
      if (!res.ok) await failedResponse(this.id, res);
      const json = (await res.json()) as {
        model: string;
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = json.choices[0]?.message.content;
      if (typeof content !== 'string') throw new Error(`${this.id}: empty response`);
      return {
        value: stripThinking(content),
        model: json.model,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    });
  }

  /** Vision: describe what an image shows, guided by `prompt`. */
  describe(jpegBase64: string, prompt: string): Promise<Priced<string>> {
    return this.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
        ],
      },
    ]);
  }
}
