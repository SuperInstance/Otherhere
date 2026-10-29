/**
 * Serve the Thor's local decision models over the OpenAI chat-completions API.
 *
 * Why this exists: the decision models speak TypeSafe's System One protocol, but
 * the agents that want to use them (the pi agent on the ProArt, and anything
 * else shaped like an OpenAI client) speak the OpenAI chat API. This is the
 * front door between the two, so those agents can use the Thor's decision tier
 * without a bespoke client.
 *
 * Usage:
 *   pnpm --filter @otherhere/models exec tsx scripts/serve-openai.ts
 *   PORT=8097 HOST=0.0.0.0 pnpm --filter @otherhere/models exec tsx scripts/serve-openai.ts
 *
 * Endpoints:
 *   GET  /health               → {"status":"ok"}
 *   GET  /v1/models            → the OpenAI model list
 *   POST /v1/chat/completions  → a decision answer, shaped as a chat completion
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ChatCompletionRequest,
  DEFAULT_MODEL,
  DECISION_MODELS,
  buildChatCompletion,
  buildChunks,
  buildError,
  buildSystemOneRequest,
  isDecisionModel,
  renderAnswers,
  renderContent,
  type DecisionModelId,
} from '../src/server/openai-adapter';

const PORT = Number(process.env['PORT'] ?? 8097);
const HOST = process.env['HOST'] ?? '0.0.0.0';
/** Where the llama-servers live. Every one of them is on this machine. */
const UPSTREAM_HOST = process.env['UPSTREAM_HOST'] ?? '127.0.0.1';
const TIMEOUT_MS = Number(process.env['UPSTREAM_TIMEOUT_MS'] ?? 120_000);

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const cors = (res: ServerResponse): void => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Ask the model. The upstream speaks System One; this returns its answers. */
async function askSystemOne(
  model: DecisionModelId,
  body: unknown,
): Promise<{ answers: Record<string, unknown>; inputTokens: number }> {
  const res = await fetch(`http://${UPSTREAM_HOST}:${DECISION_MODELS[model]}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `upstream ${model} on ${DECISION_MODELS[model]} answered HTTP ${res.status}: ${detail}`,
    );
  }
  const json = (await res.json()) as {
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    answers: json.answers ?? {},
    inputTokens: json.usage?.input_tokens ?? 0,
  };
}

const modelList = {
  object: 'list',
  data: Object.keys(DECISION_MODELS).map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'thor',
  })),
};

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      json(res, 200, { status: 'ok', models: Object.keys(DECISION_MODELS) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      json(res, 200, modelList);
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      const failure = buildError('the request body is not JSON', 'invalid_json', 400);
      json(res, failure.status, failure.body);
      return;
    }

    const request = ChatCompletionRequest.safeParse(parsed);
    if (!request.success) {
      const failure = buildError(
        `the request is not a chat completion: ${request.error.issues[0]?.message ?? 'unknown'}`,
        'invalid_request',
        400,
      );
      json(res, failure.status, failure.body);
      return;
    }

    const asked = request.data.model ?? DEFAULT_MODEL;
    const model: DecisionModelId = isDecisionModel(asked) ? asked : DEFAULT_MODEL;
    if (!isDecisionModel(asked)) {
      // Say so, but answer anyway: an agent that named a model we do not have
      // still wants the answer it came for.
      res.setHeader('x-otherhere-model-fallback', asked);
    }

    const upstream = buildSystemOneRequest(model, request.data.messages);
    try {
      const { answers, inputTokens } = await askSystemOne(model, upstream);
      const content = renderContent(renderAnswers(answers, upstream.questions));

      if (request.data.stream) {
        // OpenAI clients ask for a stream by default, and several of them treat a
        // non-streamed body as a broken stream. So stream it: a role delta, the
        // content, a finish chunk, then [DONE].
        cors(res);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const id = `chatcmpl-${Date.now().toString(36)}`;
        const created = Math.floor(Date.now() / 1000);
        for (const chunk of buildChunks(id, model, content, created)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      json(res, 200, buildChatCompletion(model, content, inputTokens));
    } catch (err) {
      const failure = buildError((err as Error).message, 'upstream_error', 502);
      json(res, failure.status, failure.body);
    }
  })().catch((err: unknown) => {
    json(res, 500, { error: { message: (err as Error).message } });
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `decision models over the OpenAI chat API on http://${HOST}:${PORT}/v1 — ${Object.keys(DECISION_MODELS).join(', ')}`,
  );
});
