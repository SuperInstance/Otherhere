/**
 * An OpenAI-compatible front door for the Thor's local decision models.
 *
 * The decision models speak TypeSafe's System One protocol (`POST /v1/systemone`,
 * answers in `noul` / `choice` / `score` shapes). Most agents speak the OpenAI
 * chat-completions shape. This module is the seam between the two, with no
 * dependency on either side: a plain object in, a plain object out.
 *
 * The interesting problem is that a decision model does not generate text. It
 * answers typed questions. So a chat request has to carry a **question pack**
 * with it, and this module's job is to find one:
 *
 *   1. the last user message that contains a JSON object with a `questions` key
 *      wins — either inline or in a fenced ```json block;
 *   2. otherwise a small built-in pack is used, so a plain-language request still
 *      gets a typed answer instead of an error.
 *
 * Everything else is mechanical: the state is the message text (minus the pack),
 * the pack goes to the model, and the answers come back as JSON text.
 */

import { z } from 'zod';

// ── the models this front door serves ───────────────────────────────────────

/** Model id → the port its llama-server listens on. */
export const DECISION_MODELS = {
  'd1-omni-600M': 8095,
  'd1-2B': 8094,
  'd1-3B': 8093,
  'clef-flash': 8096,
} as const;

export type DecisionModelId = keyof typeof DECISION_MODELS;

/** The model used when the caller does not name one. */
export const DEFAULT_MODEL: DecisionModelId = 'd1-2B';

export const isDecisionModel = (id: string): id is DecisionModelId =>
  Object.prototype.hasOwnProperty.call(DECISION_MODELS, id);

// ── request shapes ──────────────────────────────────────────────────────────

export const ContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]);

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPart)]),
});

export const ChatCompletionRequest = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
});

export type ChatMessageT = z.infer<typeof ChatMessage>;
export type ChatCompletionRequestT = z.infer<typeof ChatCompletionRequest>;

// ── question packs ──────────────────────────────────────────────────────────

/** A question pack in the shape the models accept. */
export type QuestionPack = {
  state?: string;
  questions: Record<string, Record<string, unknown>>;
};

/**
 * The pack used when the caller did not supply one.
 *
 * It is deliberately generic — three questions that fit almost any situation —
 * because the alternative is refusing the request, and a caller who wanted no
 * questions would not have asked a decision model.
 */
export const DEFAULT_PACK: QuestionPack = {
  questions: {
    urgent: {
      type: 'noul',
      instructions: 'Does this require immediate action?',
    },
    severity: {
      type: 'score',
      instructions: 'How severe is it?',
      criteria: ['none', 'minor', 'moderate', 'severe', 'critical'],
    },
    next: {
      type: 'choice',
      instructions: 'What should happen next?',
      criteria: {
        nothing: 'No action is needed',
        observe: 'Keep watching it and record what happens',
        assist: 'Attend to it or send help',
        escalate: 'Escalate it now',
      },
    },
  },
};

/**
 * Pull a JSON object out of a string, respecting strings so a brace inside a
 * quoted value does not end the object early.
 */
const braceObjects = (text: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
};

const asPack = (value: unknown): QuestionPack | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const questions = v['questions'];
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return null;
  if (Object.keys(questions as Record<string, unknown>).length === 0) return null;
  return {
    state: typeof v['state'] === 'string' ? (v['state'] as string) : undefined,
    questions: questions as Record<string, Record<string, unknown>>,
  };
};

/**
 * Find a question pack in the messages. Later user messages win.
 *
 * Returns the pack, the state to put in front of the model, and the text with
 * the pack JSON removed — the state is what the caller actually wrote.
 */
export function extractPack(messages: ChatMessageT[]): {
  pack: QuestionPack;
  state: string;
} {
  const users = messages.filter((m) => m.role === 'user');
  for (const message of users.reverse()) {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
    if (!text) continue;

    const candidates: string[] = [];
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
      if (match[1]) candidates.push(match[1]);
    }
    candidates.push(...braceObjects(text));

    for (const candidate of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const pack = asPack(parsed);
      if (!pack) continue;
      const state = pack.state ?? text.replace(candidate, ' ').trim();
      return { pack, state: state || text.trim() };
    }
  }

  // No pack anywhere: use the built-in one, with the whole conversation as state.
  const state = messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n'),
    )
    .join('\n\n')
    .trim();
  return { pack: DEFAULT_PACK, state };
}

// ── images ──────────────────────────────────────────────────────────────────

/** The data URLs of any image parts in the messages, for the models that take them. */
export function extractImages(messages: ChatMessageT[]): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const url = part.image_url.url;
        if (url.startsWith('data:')) urls.push(url);
      }
    }
  }
  return urls;
}

// ── the System One request ─────────────────────────────────────────────────

export type SystemOneRequest = {
  model: string;
  state: string;
  questions: Record<string, Record<string, unknown>>;
  images?: string[];
};

export function buildSystemOneRequest(
  model: DecisionModelId,
  messages: ChatMessageT[],
): SystemOneRequest {
  const { pack, state } = extractPack(messages);
  const images = extractImages(messages);
  return {
    model,
    state,
    questions: pack.questions,
    ...(images.length ? { images } : {}),
  };
}

// ── the answer, rendered for a chat client ─────────────────────────────────

export type RenderedAnswer = {
  question: string;
  answer: unknown;
};

export type RenderedAnswers = Record<string, RenderedAnswer>;

const instructionsOf = (question: Record<string, unknown> | undefined): string =>
  typeof question?.['instructions'] === 'string' ? (question['instructions'] as string) : '';

/** The answers, keyed by question id, each with its question text beside it. */
export function renderAnswers(
  answers: Record<string, unknown>,
  questions: Record<string, Record<string, unknown>>,
): RenderedAnswers {
  const out: RenderedAnswers = {};
  for (const [id, answer] of Object.entries(answers)) {
    out[id] = {
      question: instructionsOf(questions[id]),
      answer,
    };
  }
  return out;
}

/** The text a chat client receives. JSON, so an agent can parse it. */
export function renderContent(rendered: RenderedAnswers): string {
  return JSON.stringify(rendered, null, 2);
}

// ── the OpenAI-shaped response ──────────────────────────────────────────────

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: 'assistant'; content: string };
      finish_reason: 'stop';
    },
  ];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

let counter = 0;

export function buildChatCompletion(
  model: string,
  content: string,
  promptTokens: number,
): ChatCompletionResponse {
  counter += 1;
  return {
    id: `chatcmpl-${Date.now().toString(36)}-${counter.toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    // A decision model emits no text, so completion tokens are always zero.
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 0,
      total_tokens: promptTokens,
    },
  };
}

/** An OpenAI-shaped error, so a client does not have to special-case us. */
export function buildError(
  message: string,
  code: string,
  status: number,
): { status: number; body: { error: { message: string; type: string; code: string } } } {
  return {
    status,
    body: { error: { message, type: 'invalid_request_error', code } },
  };
}

// ── streaming ───────────────────────────────────────────────────────────────

export type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      delta: { role?: 'assistant'; content?: string };
      finish_reason: 'stop' | null;
    },
  ];
};

/**
 * The chunks of a streamed completion, in order.
 *
 * OpenAI clients expect a role delta, then content deltas, then a finish chunk.
 * A decision model answers in one go, so the content arrives in a single delta —
 * the shape is what the client needs, not how the work was done.
 */
export function buildChunks(
  id: string,
  model: string,
  content: string,
  created: number,
): ChatCompletionChunk[] {
  const base = { id, object: 'chat.completion.chunk' as const, created, model };
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
}
