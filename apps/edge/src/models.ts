import {
  ChatProvider,
  ClaudeProvider,
  JevProvider,
  Ladder,
  ModelRouter,
  jevRung,
  llmRung,
  type FetchLike,
} from '@otherhere/models';
import type { LadderRung } from '@otherhere/core';
import type { Env } from './env';
import { opsLedger, opsStub } from './ops';

/** Daily USD caps per provider. Conservative defaults; override with the MODEL_CAPS_USD var. */
const DEFAULT_CAPS = {
  jev: 1,
  'jev-place': 1,
  // The hourly drift canary: 24 calls a day at ~$0.00003 is under a mil, and a
  // runaway bug cannot spend past this nickel.
  'jev-canary': 0.05,
  groq: 1,
  minimax: 1,
  claude: 2,
};

export type Models = {
  vision: ChatProvider;
  ladder: Ladder;
  claude: ClaudeProvider | null;
  /** Jev reading the photo itself, only to decide whether it shows one building. */
  gate?: JevProvider;
};

/**
 * Build the model stack for one request, or null if no vision provider is
 * configured. Every provider shares one router, so every paid call is capped
 * and logged (invariant 9). Keys are Worker secrets, never in code.
 */
export function makeModels(env: Env): Models | null {
  const fetch: FetchLike | undefined = env.MODEL_FAKE === 'true' ? fakeModelFetch : undefined;
  const caps = {
    ...DEFAULT_CAPS,
    ...(env.MODEL_CAPS_USD ? (JSON.parse(env.MODEL_CAPS_USD) as Record<string, number>) : {}),
  };
  const keys =
    env.MODEL_FAKE === 'true'
      ? {
          GROQ_KEY: 'fake',
          TYPESAFE_KEY: 'fake',
          MINIMAX_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
        }
      : env;
  const router = new ModelRouter({ caps, ledger: opsLedger(env) });

  const vision = keys.GROQ_KEY
    ? new ChatProvider(router, 'groq', { apiKey: keys.GROQ_KEY, fetch })
    : keys.MINIMAX_KEY
      ? // MiniMax-M3 reads images. It reasons before answering, so leave room: a reply cut
        // off mid-thought has no description at all.
        new ChatProvider(router, 'minimax', { apiKey: keys.MINIMAX_KEY, fetch, maxTokens: 4000 })
      : null;
  if (!vision) return null;

  const rungs: LadderRung[] = [];
  const jev = keys.TYPESAFE_KEY
    ? new JevProvider(router, { apiKey: keys.TYPESAFE_KEY, fetch })
    : undefined;
  if (jev) rungs.push(jevRung(jev));
  if (keys.MINIMAX_KEY)
    rungs.push(
      llmRung(
        new ChatProvider(router, 'minimax', { apiKey: keys.MINIMAX_KEY, fetch, maxTokens: 2000 }),
      ),
    );
  const claude = keys.ANTHROPIC_API_KEY
    ? new ClaudeProvider(router, { apiKey: keys.ANTHROPIC_API_KEY })
    : null;
  if (claude) rungs.push(llmRung(claude));
  if (!rungs.length) return null;

  const ops = opsStub(env);
  return {
    vision,
    ladder: new Ladder(rungs, { log: (d) => ops.logDecision(d) }),
    claude,
    ...(jev ? { gate: jev } : {}),
  };
}

/**
 * A Jev provider for the place battery (ADR-0018), or null when Jev is not
 * configured. Like `makeModels`, every call goes through one capped router
 * (invariant 9) and the ledger is the OpsDO's — but under its own `jev-place`
 * budget key, so place vectors can neither spend the capture path's `jev` cap
 * nor be crowded out by it.
 */
export function placeJev(env: Env): JevProvider | null {
  const apiKey = env.MODEL_FAKE === 'true' ? 'fake' : env.TYPESAFE_KEY;
  if (!apiKey) return null;
  const caps = {
    ...DEFAULT_CAPS,
    ...(env.MODEL_CAPS_USD ? (JSON.parse(env.MODEL_CAPS_USD) as Record<string, number>) : {}),
  };
  return new JevProvider(new ModelRouter({ caps, ledger: opsLedger(env) }), {
    apiKey,
    id: 'jev-place',
    ...(env.MODEL_FAKE === 'true' ? { fetch: fakeModelFetch } : {}),
  });
}

/**
 * A Jev provider for the drift canary (see drift.ts), or null when Jev is not
 * configured. Asks `jev-latest` — deliberately not the pin — under its own
 * `jev-canary` budget key, so the hourly watch can neither spend nor be
 * crowded out by any product path (invariant 9).
 */
export function canaryJev(env: Env): JevProvider | null {
  const apiKey = env.MODEL_FAKE === 'true' ? 'fake' : env.TYPESAFE_KEY;
  if (!apiKey) return null;
  const caps = {
    ...DEFAULT_CAPS,
    ...(env.MODEL_CAPS_USD ? (JSON.parse(env.MODEL_CAPS_USD) as Record<string, number>) : {}),
  };
  return new JevProvider(new ModelRouter({ caps, ledger: opsLedger(env) }), {
    apiKey,
    model: 'jev-latest',
    id: 'jev-canary',
    ...(env.MODEL_FAKE === 'true' ? { fetch: fakeModelFetch } : {}),
  });
}

/** Canned provider responses for tests and offline development (MODEL_FAKE=true). */
const fakeModelFetch: FetchLike = async (url, init) => {
  if (url.includes('/chat/completions')) {
    // Failure injection for the observe route's error mapping (#59): the
    // marker rides in the test photo's base64, and only the vision call
    // reads it — the gate goes through /v1/systemone and stays healthy.
    const body = String(init.body);
    if (body.includes('UNAVAILABLE99'))
      return new Response('upstream rate limit for account 4242 (internal detail)', {
        status: 429,
      });
    if (body.includes('NETWORK99')) throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.9:443');
    return Response.json({
      model: 'fake-vision',
      choices: [
        {
          message: {
            content: 'A two-storey house of red brick with a gable roof covered in red clay tiles.',
          },
        },
      ],
      usage: { prompt_tokens: 1800, completion_tokens: 25 },
    });
  }
  if (url.includes('/v1/systemone')) {
    const questions = (JSON.parse(String(init.body)) as { questions?: Record<string, unknown> })
      .questions;
    // The drift canary's one question (drift.ts): a mid-band reading, so the
    // fake exercises the recording path without flipping anything real.
    if (questions && 'calm' in questions) {
      return Response.json({
        model: 'fake-jev',
        answers: { calm: { type: 'noul', noul: 0.93 } },
        usage: { input_tokens: 320, output_tokens: 21 },
      });
    }
    // The place battery gets its own canned answers (the sealed round's Zürich
    // medians, so the fake reads like the real instrument does on the seed block).
    if (questions && 'steep_roofs' in questions) {
      return Response.json({
        model: 'fake-jev',
        answers: {
          tall_for_a_town: { type: 'noul', noul: 0.23 },
          steep_roofs: { type: 'noul', noul: 0.17 },
          uniform_roofs: { type: 'noul', noul: 0.04 },
          dense_not_spread: { type: 'noul', noul: 0.59 },
          warm_earthy_walls: { type: 'noul', noul: 0.71 },
          mostly_conifers: { type: 'noul', noul: 0.02 },
          rainy_coast: { type: 'noul', noul: 0.06 },
          heights_recorded: { type: 'noul', noul: 0.27 },
          height_scale: { type: 'score', score: 4.27, confidence: 0.9 },
          known_in_detail: { type: 'score', score: 1.54, confidence: 0.9 },
          green_setting: { type: 'score', score: 1.41, confidence: 0.9 },
        },
        usage: { input_tokens: 700, output_tokens: 90 },
      });
    }
    return Response.json({
      model: 'fake-jev',
      answers: {
        visible: { type: 'noul', noul: 0.97 },
        roof_shape: { type: 'choice', choice: 'gable', confidence: 0.95 },
        floors: { type: 'choice', choice: '2', confidence: 0.9 },
        wall_colour: { type: 'choice', choice: 'brick', confidence: 0.9 },
        roof_colour: { type: 'choice', choice: 'red', confidence: 0.92 },
      },
      usage: { input_tokens: 700, output_tokens: 90 },
    });
  }
  return new Response('not mocked', { status: 599 });
};
