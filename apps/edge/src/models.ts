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
const DEFAULT_CAPS = { jev: 1, groq: 1, minimax: 1, claude: 2 };

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

/** Canned provider responses for tests and offline development (MODEL_FAKE=true). */
const fakeModelFetch: FetchLike = async (url) => {
  if (url.includes('/chat/completions')) {
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
