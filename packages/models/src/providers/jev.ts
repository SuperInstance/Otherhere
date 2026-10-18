import { Answer, type Answers, type QuestionPack } from '@otherhere/core';
import type { ModelRouter, Pricing, Priced } from '../router';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Placeholder pricing until TypeSafe publishes rates; override in config. Output is free. */
export const JEV_PRICING: Pricing = { inputPerM: 0.5, outputPerM: 0 };

/** TypeSafe Jev: typed answers to a question pack about some state (ADR-0013). */
export class JevProvider {
  readonly id = 'jev';
  constructor(
    private router: ModelRouter,
    private opts: {
      apiKey: string;
      model?: string;
      fetch?: FetchLike;
      pricing?: Pricing;
      baseUrl?: string;
    },
  ) {}

  async ask(pack: QuestionPack, state: unknown): Promise<Priced<Answers>> {
    return this.post(
      JSON.stringify({ model: this.opts.model ?? 'jev-latest', state, questions: pack.questions }),
      {},
    );
  }

  /**
   * Ask about an image directly (the "danger zone" image path, ADR-0013). The
   * placeholder in `state` is replaced by the image on TypeSafe's side.
   */
  async askAboutImage(
    pack: QuestionPack,
    jpegBase64: string,
    prompt: string,
  ): Promise<Priced<Answers>> {
    const placeholder = `img-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      model: this.opts.model ?? 'jev-latest',
      state: `${prompt}\n${placeholder}`,
      assets: { [placeholder]: { type: 'image', format: 'jpg', data_base64: jpegBase64 } },
      questions: pack.questions,
    });
    return this.post(body, { 'TypeSafe-Danger-Zone-Images': 'true' });
  }

  private async post(body: string, headers: Record<string, string>): Promise<Priced<Answers>> {
    const pricing = this.opts.pricing ?? JEV_PRICING;
    // Rough upper bound: ~1 token per 3 characters of text; images are capped like text.
    const estimate = (Math.min(body.length / 3, 8000) * pricing.inputPerM) / 1_000_000;
    return this.router.run(this.id, estimate, pricing, async () => {
      const res = await (this.opts.fetch ?? fetch)(
        `${this.opts.baseUrl ?? 'https://api.typesafe.ai'}/v1/systemone`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
            ...headers,
          },
          body,
        },
      );
      if (!res.ok) throw new Error(`jev: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as {
        model: string;
        answers: Record<string, unknown>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const answers: Answers = {};
      for (const [k, v] of Object.entries(json.answers)) answers[k] = Answer.parse(v);
      return {
        value: answers,
        model: json.model,
        usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
      };
    });
  }
}
