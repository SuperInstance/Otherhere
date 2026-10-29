---
status: accepted
---

# Local decision models are the reflex rung; the cloud is the arbiter

**Accepted by the project owner on 2026-10-28.**

## Context

Three families can answer a typed question pack, and all three speak the **same protocol** — `POST /v1/systemone`, body `{ model, state, questions }`, answers in Jev's `noul` / `choice` / `score` shapes. That makes them interchangeable rungs, and the only real questions are _where do they run_ and _how long do they take_.

| model                 | where                | protocol        | marginal cost               |
| --------------------- | -------------------- | --------------- | --------------------------- |
| TypeSafe Jev          | cloud                | `/v1/systemone` | $0.042/M input, output free |
| Cloudflare clef-flash | cloud                | `/v1/systemone` | $0.038/M input, output free |
| Liquid d1 family      | local `llama-server` | `/v1/systemone` | $0                          |

Our own `JevProvider` already posts to `{baseUrl}/v1/systemone`, so a local `llama-server` is a **base-URL change**, not a new integration.

### What the Thor actually does

Measured 2026-10-28 on the Thor (NVIDIA Jetson AGX Thor, 122 GiB RAM, CUDA 13.2, `sm_110`), llama.cpp 0.8.0-dev, GPU offload on, every model on the same build and the same flags, one at a time. Medians of 15 calls after 3 warmups; HTTP round-trip baseline 0.6–0.8 ms.

| model                           | 1 question       | 3 questions, short state | 3 questions, long state | 3 questions + 320 px image |
| ------------------------------- | ---------------- | ------------------------ | ----------------------- | -------------------------- |
| **`d1-omni-600M`** (587M)       | **9.7 ms**       | **15.4 ms**              | **33.9 ms**             | **94.9 ms**                |
| `d1-2B` (LFM3-VL-2B)            | 20.3 ms          | 60.3 ms                  | 104.6 ms                | 192.8 ms                   |
| `d1-3B` (LFM2.5-VL-3B)          | 27.3 ms          | 90.1 ms                  | 103.6 ms                | 203.2 ms                   |
| `clef-flash` (Q4_K_M, local)    | 157.1 ms         | 284.4 ms                 | 386.6 ms                | 476.6 ms                   |
| _cloud Jev (our measurement)_   | —                | —                        | _~334 ms_               | —                          |
| _cloud clef-flash (Cloudflare)_ | _38.8 ms median_ | _38.8 ms median_         | —                       | —                          |

Three facts follow, and they decide the design.

1. **The local tier is an order of magnitude cheaper than the cloud tier we already use.** `d1-omni-600M` answers a three-question pack in 15.4 ms against ~334 ms from cloud Jev — 22× faster, and $0 per call.
2. **Local clef-flash is the opposite of an upgrade.** It takes 157 ms for a _single_ question — 4× slower than the cloud clef-flash it is meant to replace. Cloudflare runs it on H200/B200 with SGLang; a 9B backbone on the Thor's consumer GPU does not compete. "Flash" means 9B in Cloudflare's family and 587M in Liquid's, and on this box the bottleneck is backbone prefill, so the smaller model wins by an order of magnitude.
3. **A pack is not one pass.** llama.cpp builds one prompt per question for the d1 family, so latency grows with pack size: `d1-omni-600M` runs ~10 ms per extra question. Pack size is a budget, not an accident.

## Decision

We run a **five-tier stack**. Authority flows **down** the stack and never up: only the bottom tier can move anything, and only the top tier can change code.

| tier                      | clock       | where                    | what                                                                                 | authority                            |
| ------------------------- | ----------- | ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------ |
| **T0 deterministic core** | 60 Hz       | CPU, in-process          | state machines, behaviour trees, spatial awareness, pathfinding, collision detection | **owns physics and invariants**      |
| **T1 local reflex rung**  | 20–40 Hz    | Thor GPU, `llama-server` | `d1-omni-600M` — one to three questions, text                                        | **advisory** — emits setpoints       |
| **T2 perception**         | 2–5 Hz      | Thor GPU                 | a standard vision model on fitted frames; I-JEPA / V-JEPA2 already on `jev-rack`     | **advisory** — emits observations    |
| **T3 cloud arbitration**  | on demand   | cloud                    | `clef-flash` (38.8 ms median for a whole pack), then Jev, then an LLM                | advisory, and only when T1 is unsure |
| **T4 reflection**         | out of band | cloud LLM API            | reads the trace journal, proposes code and weight changes                            | **writes PRs, never acts in a tick** |

Local `clef-flash` is **not** in T1: at 157 ms per question it cannot be a reflex. It stays on the box for offline work — labelling, evals, and checking the flash tier against a stronger model.

T1's server is reachable on the LAN (`0.0.0.0:8095`, no API key), so the Thor can serve as a shared decision model for the other machines. That is a deliberate choice with a cost — unauthenticated callers can spend the GPU — and it is reversible with `--api-key`. The provider's default base URL stays loopback, because the agent app runs on the Thor itself.

### The rules that make it work

1. **The core never asks the model what to do.** T0 owns movement, collision, and the invariants. A model answer is a _setpoint_ the core interpolates toward — advisory by construction, not by convention.
2. **A decision rung is never in the deterministic path** (invariant 2). Model output is recorded with provenance and folded into the content address like any other fact; the sim stays a pure function of its inputs. A quantized model is not bit-reproducible across builds, so it must not reach Bundle bytes as a hidden dependency.
3. **Pack size is a budget.** T1 answers a small pack and escalates. Escalating to T3 is what buys the larger pack — but note that local clef-flash's _joint_ head does not make it cheaper here (218 ms for the first question, ~65–90 ms for each extra one), so "one pass for the whole pack" is a cloud advantage on datacenter hardware, not one the Thor can bank.
4. **Vision has its own size cap.** Local vision cost is linear in pixels: 320 px is 95 ms, 2,050 px is 2.8 s on `d1-3B`. The local path needs its own fit function; `JEV_IMAGE_SIDE` (up to 1,568 px) is a cloud limit and too slow locally.
5. **Escalation is measured, not assumed.** T1's confidence decides, exactly as `packConfidence` already does for the existing Ladder.
6. **The reflection tier is fenced.** T4 may propose changes to T0's code and T1's weights, but it may not touch the judge (invariant 6), and its proposals land as reviewable PRs. The loop is slow and out of band by design.

### The two halves

- **Yang** is T0 + T1: fast, local, deterministic, bright. It runs every tick and decides the next setpoint.
- **Yin** is T2 + T3 + T4: slow, global, reflective. It runs occasionally, sees aggregates, and changes the yang from above.

They exchange through the **trace journal** — decision logs and observation hashes, never raw payloads, never the judge. The journal is what T4 reads. That is the whole mechanism: a fast half that acts and a slow half that reads what the fast half did.

### The budget law

`quilt-dba` already runs a conservation law: `γ + η ≤ C`, where `γ` is compute cost and `η` is surprise, with `C = log₂3 ≈ 1.585`. We adopt the shape, not the constant: **γ is local GPU milliseconds plus cloud dollars, η is the model's own disagreement or surprise.** Escalation to T3 spends γ; a T1 answer with low surprise and high confidence spends almost none. A pack that breaches the budget does not escalate — it falls back to the deterministic core.

## How this lands in the SuperInstance stack

| repo            | cell or seam                                                                       | what changes                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quilt-pincher` | `hitThreshold` 0.80 / `confirmThreshold` 0.55 cosine bands in `src/core/engine.ts` | the decision model can _replace_ the similarity score with a calibrated `noul` ("is this reflex the right one?") over the top-k candidates; its own serve round-trip is 2.1–2.6 ms and its LLM compiler is ~5 s, so a 15–34 ms local model slots cleanly between them         |
| `exoj`          | the field `(γ, η, Δ, ι)`                                                           | the field is the state a decision model reads. A reflex no longer has to be a vector match; it can be a question over amplitudes. `quilt-pincher/src/hdc/exoj-field.ts` already carries the field encoding                                                                    |
| `quilt-dba`     | `teacher.jev_gate` in the 12-cell seed, and `dba/jev_live.mjs`                     | `jev_live.mjs` already speaks `/v1/systemone` with a `transport` dependency-injection seam; pointing it at `127.0.0.1:8095` replaces the 334 ms cloud call with a 15–34 ms local one and no spend. The sheet's `jev_gate` is currently a labelled _mock_ — this makes it real |
| `Otherhere`     | the `distilled` rung in `RUNGS` (`packages/core/src/schema/ladder.ts`)             | the rung was reserved and unimplemented; a local `llama-server` is exactly what it is for. The Ladder's escalation order becomes `rule → distilled(local) → jev(cloud) → …`, and the cloud call only happens when the local model is unsure                                   |

## What this does not do

- It does not put a model inside the simulation loop. The core stays a pure function.
- It does not make the local model better than the cloud one. It makes it _close enough and free enough_ to be consulted first. The accuracy comparison on the same packs is still open, and the repo's own field notes warn that one to two answers on small sets is noise.
- It does not retire the cloud rung. Cloud clef-flash is 38.8 ms for a whole pack with no GPU of ours involved, and it stays the arbiter for packs too large for T1.

## Evidence

Measurements, scripts and the honest negatives are in [`docs/notes/local-decision-models.md`](../notes/local-decision-models.md).

## References

- Cloudflare Clef-Flash model card and the System One API shape — <https://huggingface.co/Cloudflare/clef-flash>
- Clef weights as GGUF, converted by the llama.cpp org — <https://huggingface.co/ggml-org/Clef-Flash-GGUF>
- Liquid AI d1 decision models — <https://docs.liquid.ai/lfm/models/decision-models>
- TypeSafe System One — <https://docs.typesafe.ai/concepts/system-one.md>
