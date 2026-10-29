---
status: accepted
---

# The decision tier gets an OpenAI-shaped front door

**Accepted by the project owner on 2026-10-29.**

## Context

[ADR-0019](0019-local-decision-tiers.md) put a local decision tier on the Thor: `d1-2B` as
the reflex rung, `clef-flash` as the accuracy tier, all speaking TypeSafe's System One
protocol (`POST /v1/systemone`, answers in `noul` / `choice` / `score` shapes).

The problem is that **the agents that want to use them do not speak System One.** The pi
agent on the ProArt is configured through `~/.pi/agent/models.json`, which is
OpenAI-completions shaped:

```json
{"providers": {"thor": {"api": "openai-completions",
                         "baseUrl": "http://192.168.0.78:8001/v1", "models": [...]}}}
```

`models.json` cannot express a System One provider, and the decision endpoints cannot be
dropped in as-is. So the decision tier was reachable only by code that already knew the
protocol — which is to say, only by this repo.

## Decision

**Put a small OpenAI-compatible server in front of the decision models**, on the Thor, and
point OpenAI-shaped clients at it. It is a front door, not a rewrite: the models still speak
System One, and the seam is one HTTP call wide.

`packages/models/src/server/openai-adapter.ts` holds the logic; `packages/models/scripts/serve-openai.ts`
is the server. It listens on **port 8097** and serves:

| endpoint                    | what                                                |
| --------------------------- | --------------------------------------------------- |
| `GET /health`               | `{"status":"ok","models":[...]}`                    |
| `GET /v1/models`            | the OpenAI model list, one entry per decision model |
| `POST /v1/chat/completions` | a decision answer, shaped as a chat completion      |

### The question is the hard part

A decision model does not generate text. It answers typed questions, so a chat request has
to carry a **question pack** with it. The adapter finds one in this order:

1. **The last user message containing a JSON object with a `questions` key** — inline, or in
   a fenced ` ```json ` block. The rest of that message becomes the `state`.
2. **Otherwise a small built-in pack** (`urgent` / `severity` / `next`), with the whole
   conversation as the state.

So an agent can either send a pack and get exactly those answers, or send plain language and
get a typed judgement on the situation. Both are useful; the second is what most callers
will actually do.

Images are passed through: an `image_url` content part holding a data URL becomes an image
on the System One request, so the multimodal models work over the OpenAI shape too.

### The rules it keeps

- **The answer is JSON, in a chat message.** Each question id maps to
  `{ "question": "...", "answer": { ...the Jev answer shape... } }`, so an agent can parse it
  without knowing the pack.
- **Completion tokens are always zero.** A decision model emits no text. Saying otherwise
  would be a lie about what the tier is.
- **It streams when asked.** OpenAI clients ask for a stream by default, and several treat a
  non-streamed body as a broken stream — the first version of this failed exactly that way.
  The stream is a role delta, one content delta, a finish chunk, then `[DONE]`.
- **An unknown model name still answers.** The request names a model we do not have, the
  adapter falls back to `d1-2B` and sets `x-otherhere-model-fallback`, rather than refusing.
- **The upstream error is the upstream error.** A failed call returns the model's own message
  with HTTP 502, shaped like an OpenAI error. A refusal is not a wrong answer.

## What it does not do

- It does not turn the decision models into chat models. There is no free-text generation and
  no `noul` → prose conversion; the answer is the typed answer.
- It does not add authentication. It inherits the Thor's open-by-choice posture
  (ADR-0019): LAN-open, CORS open to every origin, reversible with a key.
- It does not change the judge, the packs, or the Ladder. It is a transport, in front of a
  tier that already existed.

## Measured

On the Thor, 2026-10-29, over the LAN from the ProArt:

|                             | text pack         | text pack + image |
| --------------------------- | ----------------- | ----------------- |
| `d1-2B` through the adapter | 122 prompt tokens | 743 prompt tokens |

The image path costs 621 extra prompt tokens, which is the vision encoder doing its work —
the same cost the model pays when asked directly.

Verified end to end through the pi agent itself:

```
pi -p --no-session --provider thor-decisions --model d1-2B "..."
→ {"urgent": {"question": "Does this require immediate rescue?",
               "answer": {"type": "noul", "noul": 0.22161016367000558}}}
```

## Evidence

- `packages/models/src/server/openai-adapter.ts` — the logic
- `packages/models/scripts/serve-openai.ts` — the server
- `packages/models/test/openai-adapter.test.ts` — 19 tests over pack extraction, image
  extraction, rendering and the response shapes
- `docs/notes/local-decision-models.md` — the models behind the door
