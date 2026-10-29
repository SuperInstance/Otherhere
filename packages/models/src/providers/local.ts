import { Answer, type Answers, type QuestionPack } from '@otherhere/core';
import { costOf, ProviderUnavailable, type Priced, type Pricing } from '../router';
import type { FetchLike } from './jev';

/**
 * A local decision model costs nothing per call, so it has no price. The
 * pricing record exists so a local answer and a cloud answer travel through
 * the same accounting shapes.
 */
export const LOCAL_PRICING: Pricing = { inputPerM: 0, outputPerM: 0 };

/**
 * The default local endpoint: a `llama-server` on this machine.
 *
 * The agent app runs on the Thor, so loopback is the right default. The
 * server also listens on the LAN at `http://192.168.0.78:8095` with no API
 * key, so a caller on another machine can pass that as `baseUrl` and use the
 * Thor as a shared decision model.
 */
export const LOCAL_BASE_URL = 'http://127.0.0.1:8095';

/**
 * A local decision model served by `llama-server` (or anything else that
 * speaks the TypeSafe System One API).
 *
 * The protocol is identical to TypeSafe Jev's — `POST {baseUrl}/v1/systemone`
 * with `{ model, state, questions }` and the same `noul` / `choice` / `score`
 * answer shapes — so this is a drop-in for {@link JevProvider}: same request
 * body, same response parsing, and the only differences are that there is no
 * API key, no per-call cost, and the image field is a plain data-URL list
 * instead of Jev's `assets` map.
 *
 * Measured on a Jetson AGX Thor (2026-10-28, llama.cpp 0.7.0-dev, GPU offload
 * on): `d1-omni-600M` answers a three-question pack in 16–38 ms, against
 * ~334 ms for the same pack from cloud Jev. See
 * `docs/notes/local-decision-models.md` for the full numbers.
 */
export class LocalDecisionProvider {
  /** The router's budget key for this provider, if it is used through one. */
  readonly id: string;
  constructor(
    private opts: {
      baseUrl?: string;
      model?: string;
      id?: string;
      timeoutMs?: number;
      fetch?: FetchLike;
      pricing?: Pricing;
    },
  ) {
    this.id = this.opts.id ?? 'distilled';
  }

  /** Ask a pack about some state. */
  async ask(pack: QuestionPack, state: unknown): Promise<Priced<Answers>> {
    return this.post({
      model: this.opts.model ?? 'd1-omni-600M',
      state,
      questions: pack.questions,
    });
  }

  /**
   * Ask a pack about an image. `llama-server` takes `images` as an array of
   * data-URL strings (Jev takes an `assets` map plus a danger-zone header).
   *
   * Local vision is slow and scales with pixels: on the Thor, a 320 px image
   * costs about 100 ms on top of the text and a 2,050 px image costs about
   * 2.8 s. Fit the image down before sending it.
   */
  async askAboutImage(
    pack: QuestionPack,
    jpegBase64: string,
    prompt: string,
  ): Promise<Priced<Answers>> {
    return this.post({
      model: this.opts.model ?? 'd1-omni-600M',
      state: prompt,
      images: [`data:image/jpeg;base64,${jpegBase64}`],
      questions: pack.questions,
    });
  }

  private async post(body: unknown): Promise<Priced<Answers>> {
    const pricing = this.opts.pricing ?? LOCAL_PRICING;
    const url = `${(this.opts.baseUrl ?? LOCAL_BASE_URL).replace(/\/$/, '')}/v1/systemone`;
    const t0 = Date.now();
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // The local server being down is the same kind of thing as a cloud
      // provider being unavailable: the caller moves to the next rung.
      throw new ProviderUnavailable(
        this.id,
        0,
        `local decision model unreachable at ${url}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (res.status >= 500) throw new ProviderUnavailable(this.id, res.status, detail);
      throw new Error(`local decision model: HTTP ${res.status} ${detail}`);
    }
    const json = (await res.json()) as {
      model: string;
      answers: Record<string, unknown>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const answers: Answers = {};
    for (const [k, v] of Object.entries(json.answers)) answers[k] = normalizeAnswer(v);
    const usage = { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens };
    return {
      value: answers,
      model: json.model,
      usage,
      // A local model is free per call; `pricing` exists so a caller can still
      // account for it the same way as any other rung.
      costUsd: costOf(usage, pricing),
      provider: this.id,
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Make an answer parseable under `Answer`.
 *
 * A local model returns the same shapes as Jev, but two things vary between
 * servers: a `choice` or `score` answer may arrive without a `confidence`,
 * and the score's level scale is carried in a `legend` that `Answer` drops.
 * When confidence is missing it is derived from the probability distribution,
 * so one flat answer scores 1 and a split answer scores low — the same
 * reading `packConfidence` expects.
 */
export function normalizeAnswer(raw: unknown): Answer {
  const a = raw as {
    type?: string;
    noul?: number;
    choice?: string;
    score?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
    legend?: Record<string, string | number | boolean | null>;
  };
  if (a?.type === 'noul' && typeof a.noul === 'number') {
    return { type: 'noul', noul: a.noul };
  }
  if (a?.type === 'choice' && typeof a.choice === 'string') {
    return {
      type: 'choice',
      choice: a.choice,
      confidence: a.confidence ?? distributionConfidence(a.probabilities),
      ...(a.probabilities ? { probabilities: a.probabilities } : {}),
    };
  }
  if (a?.type === 'score' && typeof a.score === 'number') {
    return {
      type: 'score',
      score: a.score,
      confidence: a.confidence ?? distributionConfidence(a.probabilities),
      ...(a.probabilities ? { probabilities: a.probabilities } : {}),
      ...(a.legend ? { legend: a.legend } : {}),
    };
  }
  // Fall back to the shared parser so a malformed answer fails the same way
  // it would from any other rung.
  return Answer.parse(raw);
}

/** Confidence of a probability distribution: how concentrated it is, 0..1. */
export function distributionConfidence(p?: Record<string, number>): number {
  if (!p) return 0;
  const values = Object.values(p);
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  if (sum <= 0) return 0;
  // Normalised largest share, so a flat distribution scores low and a peaked
  // one scores high, whatever the server's raw probabilities summed to.
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return Math.min(1, Math.max(0, max / sum));
}
