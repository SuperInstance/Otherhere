import { Answer, type Answers, type QuestionPack } from '@otherhere/core';
import { ProviderUnavailable, type ModelRouter, type Pricing, type Priced } from '../router';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Placeholder pricing until TypeSafe publishes rates; override in config. Output is free. */
export const JEV_PRICING: Pricing = { inputPerM: 0.5, outputPerM: 0 };

/** Jev's direct-image path accepts an image when every side is in this range, at any aspect (measured 2026-10-18). */
export const JEV_IMAGE_SIDE = { min: 280, max: 1568 } as const;

/**
 * The smallest change that makes a `width`×`height` image acceptable to Jev:
 * scale it so every side fits {@link JEV_IMAGE_SIDE}, centre-cropping the long
 * side first only if the image is more elongated than max/min (5.6:1).
 */
export function fitForJev(
  width: number,
  height: number,
): { crop: { width: number; height: number }; width: number; height: number } {
  const { min, max } = JEV_IMAGE_SIDE;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const keptLong = Math.min(long, Math.floor((short * max) / min));
  const crop = width >= height ? { width: keptLong, height } : { width, height: keptLong };
  let k = 1;
  if (short < min) k = min / short;
  if (keptLong * k > max) k = max / keptLong;
  const fit = (n: number) => Math.min(max, Math.max(min, Math.round(n * k)));
  return { crop, width: fit(crop.width), height: fit(crop.height) };
}

/**
 * Jev declined the input itself (a 4xx other than auth or rate limiting), e.g.
 * "Invalid image dimensions". Callers can fall back to another rung on this,
 * unlike a transport or budget failure.
 */
export class JevRejected extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`jev: rejected (HTTP ${status}) ${detail}`);
    this.name = 'JevRejected';
  }
}

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
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        if (res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status)) {
          throw new JevRejected(res.status, detail);
        }
        if (res.status === 429 || res.status === 503)
          throw new ProviderUnavailable('jev', res.status, detail);
        throw new Error(`jev: HTTP ${res.status} ${detail}`);
      }
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
