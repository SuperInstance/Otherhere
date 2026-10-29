---
status: accepted
---

# Local decision models are the reflex rung; the cloud is the arbiter

**Accepted by the project owner on 2026-10-28. Revised the same day after the accuracy
comparison below.**

## Context

Three families can answer a typed question pack, and all three speak the **same protocol** — `POST /v1/systemone`, body `{ model, state, questions }`, answers in Jev's `noul` / `choice` / `score` shapes. That makes them interchangeable rungs, and the only real questions are _where do they run_, _how long do they take_, and _how good are they_.

Our own `JevProvider` already posts to `{baseUrl}/v1/systemone`, so a local `llama-server` is a **base-URL change**, not a new integration.

### Latency, measured on the Thor

2026-10-28, NVIDIA Jetson AGX Thor, 122 GiB RAM, CUDA 13.2, `sm_110`. llama.cpp 0.8.0-dev, GPU offload on, every model on the same build and the same flags, one at a time. Medians of 15 calls after 3 warmups; HTTP round-trip baseline 0.6–0.8 ms.

| model                           | 1 question       | 3 questions, short state | 3 questions, long state | 3 questions + 320 px image |
| ------------------------------- | ---------------- | ------------------------ | ----------------------- | -------------------------- |
| `d1-omni-600M` (587M)           | 9.7 ms           | 15.4 ms                  | 33.9 ms                 | 94.9 ms                    |
| `d1-2B` (LFM3-VL-2B)            | 20.3 ms          | 60.3 ms                  | 104.6 ms                | 192.8 ms                   |
| `d1-3B` (LFM2.5-VL-3B)          | 27.3 ms          | 90.1 ms                  | 103.6 ms                | 203.2 ms                   |
| `clef-flash` (Q4_K_M, local)    | 157.1 ms         | 284.4 ms                 | 386.6 ms                | 476.6 ms                   |
| _cloud Jev (our measurement)_   | —                | —                        | _~334 ms_               | —                          |
| _cloud clef-flash (Cloudflare)_ | _38.8 ms median_ | _38.8 ms median_         | —                       | —                          |

**Local clef-flash is 4× slower than the cloud clef-flash it would replace** — Cloudflare runs that on H200/B200 with SGLang, and a 9B backbone on a Thor's consumer GPU does not compete. "Flash" means 9B in Cloudflare's family and 587M in Liquid's, and the bottleneck here is backbone prefill, which scales with parameter count.

### Accuracy, measured on the fixed judge

Latency alone does not say which model should answer. So we ran the **same packs through the same fixed judge** (`packages/judge/src/score.ts`, invariant 6 — the judge was not modified), changing only who answers.

Two evals, both in the repo:

- **text** — `building-observations.v1`, 14 cases, 62 labelled field-answers, the model reads a written observation.
- **photo** — `building-photos.v1`, 10 photos, 31 labelled field-answers, the model reads the photo. **Every arm saw byte-identical image data** (one 512 px fit), so the only variable was the model.

Two runs per arm, `packages/judge/scripts/local-vs-cloud.ts`:

**Text (62 answers)**

| arm                      | score      | accuracy  | median     | cost/run  | spread |
| ------------------------ | ---------- | --------- | ---------- | --------- | ------ |
| `local-omni`             | 42/62      | 67.7%     | 61 ms      | $0        | 0      |
| **`local-2b`**           | **61/62**  | **98.4%** | 147 ms     | $0        | 0      |
| `local-3b`               | 58/62      | 93.5%     | 217 ms     | $0        | 0      |
| **`local-clef`**         | **62/62**  | **100%**  | 945 ms     | $0        | 0      |
| _cloud-llm (MiniMax-M3)_ | _60–61/62_ | _97.6%_   | _2,658 ms_ | _$0.0076_ | _1_    |

**Photo (31 answers)**

| arm                      | score      | accuracy  | median      | cost/run  | spread |
| ------------------------ | ---------- | --------- | ----------- | --------- | ------ |
| `local-omni`             | 3/31       | 9.7%      | 274 ms      | $0        | 0      |
| `local-2b`               | 22/31      | 71.0%     | 478 ms      | $0        | 0      |
| `local-3b`               | 21/31      | 67.7%     | 571 ms      | $0        | 0      |
| **`local-clef`**         | **27/31**  | **87.1%** | 1,136 ms    | $0        | 0      |
| _cloud-llm (MiniMax-M3)_ | _25–26/31_ | _82.3%_   | _14,067 ms_ | _$0.0229_ | _1_    |

Three things fall out of this.

1. **The fastest model is the worst one.** `d1-omni-600M` answers in 61 ms and gets 67.7% on text and **9.7% on photos**. Speed and accuracy come apart completely on the vision path.
2. **Local clef-flash beats the cloud arm on both evals** — 100% vs 97.6% on text, 87.1% vs 82.3% on photos — while being 3× faster on text, **12× faster on photos**, and free. The cloud is not the accuracy ceiling here; the cloud is just _also_ slow.
3. **The local models are deterministic and the cloud arm is not.** Spread across two runs: 0 for every local model, 1 answer for the cloud LLM.

Cloud Jev could not be run — there is no `TYPESAFE_AI_TOKEN` on this machine. Its numbers in the repo's field notes (62/62 on the text eval; 67.7% raw and 83.9% crop-and-upscale on the photo eval) are a **recorded measurement from an earlier session**, not a side-by-side run today.

## Decision

A **five-tier stack**. Authority flows **down** and never up: only the bottom tier can move anything, only the top tier can change code.

| tier                      | clock       | where                    | what                                                                                          | authority                            |
| ------------------------- | ----------- | ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| **T0 deterministic core** | 60 Hz       | CPU, in-process          | state machines, behaviour trees, spatial awareness, pathfinding, collision detection          | **owns physics and invariants**      |
| **T1 local reflex rung**  | ~7 Hz       | Thor GPU, `llama-server` | **`d1-2B`** — text packs, one to three questions                                              | **advisory** — emits setpoints       |
| **T2 perception**         | 2–5 Hz      | Thor GPU                 | **`d1-2B`** on a fitted frame (71.0%); **`clef-flash`** when the answer must be right (87.1%) | **advisory** — emits observations    |
| **T3 cloud arbitration**  | on demand   | cloud                    | `clef-flash`, then Jev, then an LLM                                                           | advisory, and only when T1 is unsure |
| **T4 reflection**         | out of band | cloud LLM API            | reads the trace journal, proposes code and weight changes                                     | **writes PRs, never acts in a tick** |

**T1 is `d1-2B`, not `d1-omni-600M`.** The 587M model is fast but wrong: 67.7% on text and 9.7% on photos. `d1-2B` gets 98.4% on text at 147 ms — about 7 Hz, which is plenty for a setpoint that the 60 Hz core interpolates toward. `d1-omni-600M` survives as a cheap **triage gate** for questions whose answers are trivially easy, not as a policy.

**Local clef-flash is the accuracy champion, and it is not off-line.** It is live at `thor.local:8096`, and it scores the best of any model on the box. It is kept out of T1 only because 1.1 s per pack is too slow for a per-tick decision — not because it is worse. It is the right tier for T2's "the answer must be right" case and for offline labelling.

**The cloud may not be needed for these packs at all.** Local clef-flash matched or beat the cloud arm on both evals at zero cost. The cloud stays as the arbiter for packs too large for a local model and for work the local models have never seen — but the ladder should no longer assume the cloud is the ceiling.

### The rules that make it work

1. **The core never asks the model what to do.** T0 owns movement, collision, and the invariants. A model answer is a _setpoint_ the core interpolates toward — advisory by construction, not by convention.
2. **A decision rung is never in the deterministic path** (invariant 2). Model output is recorded with provenance and folded into the content address like any other fact; the sim stays a pure function of its inputs. A quantized model is not bit-reproducible across builds, so it must not reach Bundle bytes as a hidden dependency.
3. **The perception tier must be independent of the decision tier.** A critic that shares the builder's context cannot criticise it. The `night-street` build makes this a hard rule — _"the critic must never be the same agent that built it. It should only see the rendered output, not the code"_ — and the same separation is what keeps T2 from rubber-stamping T1.
4. **Pack size is a budget.** T1 answers a small pack and escalates. Local clef-flash's _joint_ head does not make it cheaper here (218 ms for the first question, ~65–90 ms for each extra one) — "one pass for the whole pack" is a cloud advantage on datacenter hardware, not one the Thor can bank.
5. **Vision has its own size cap.** Local vision cost is linear in pixels: 320 px is 95 ms, 2,050 px is 2.8 s on `d1-3B`. The local path needs its own fit function; `JEV_IMAGE_SIDE` (up to 1,568 px) is a cloud limit and too slow locally.
6. **Escalation is measured, not assumed.** T1's confidence decides, exactly as `packConfidence` already does for the existing Ladder — and the accuracy table above is the evidence for the threshold.
7. **The reflection tier is fenced.** T4 may propose changes to T0's code and T1's weights, but it may not touch the judge (invariant 6), and its proposals land as reviewable PRs.

### The two halves

- **Yang** is T0 + T1: fast, local, deterministic, bright. It runs every tick and decides the next setpoint.
- **Yin** is T2 + T3 + T4: slow, global, reflective. It runs occasionally, sees aggregates, and changes the yang from above.

They exchange through the **trace journal** — decision logs and observation hashes, never raw payloads, never the judge. That journal is what T4 reads. That is the whole mechanism: a fast half that acts and a slow half that reads what the fast half did.

### The budget law

`quilt-dba` already runs a conservation law: `γ + η ≤ C`, where `γ` is compute cost and `η` is surprise, with `C = log₂3 ≈ 1.585`. We adopt the shape, not the constant: **γ is local GPU milliseconds plus cloud dollars, η is the model's own disagreement or surprise.** A T1 answer with low surprise spends almost none; a pack that breaches the budget does not escalate — it falls back to the deterministic core.

## How this lands in the SuperInstance stack

| repo            | cell or seam                                                                       | what changes                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quilt-pincher` | `hitThreshold` 0.80 / `confirmThreshold` 0.55 cosine bands in `src/core/engine.ts` | the decision model can _replace_ the similarity score with a calibrated `noul` over the top-k candidates; its serve round-trip is 2.1–2.6 ms and its LLM compiler ~5 s, so a 147 ms local model slots cleanly between them                                                  |
| `exoj`          | the field `(γ, η, Δ, ι)`                                                           | the field is the state a decision model reads. A reflex no longer has to be a vector match; it can be a question over amplitudes. `quilt-pincher/src/hdc/exoj-field.ts` already carries the field encoding                                                                  |
| `quilt-dba`     | `teacher.jev_gate` in the 12-cell seed, and `dba/jev_live.mjs`                     | `jev_live.mjs` already speaks `/v1/systemone` with a `transport` dependency-injection seam; pointing it at `127.0.0.1:8094` replaces the 334 ms cloud call with a 147 ms local one and no spend. The sheet's `jev_gate` is currently a labelled _mock_ — this makes it real |
| `Otherhere`     | the `distilled` rung in `RUNGS` (`packages/core/src/schema/ladder.ts`)             | the rung was reserved and unimplemented; a local `llama-server` is exactly what it is for. The Ladder's escalation order becomes `rule → distilled(local) → jev(cloud) → …`                                                                                                 |

## What this does not do

- It does not put a model inside the simulation loop. The core stays a pure function.
- It does not claim the local models are universally better. They beat the cloud arm **on these two packs**; the cloud arm is a general LLM and the local models are narrow. The comparison is a fact about this benchmark, not a law.
- It does not retire the cloud rung. Cloud clef-flash is 38.8 ms for a whole pack with no GPU of ours involved, and it stays the arbiter for packs too large for T1.

## Evidence

Measurements, scripts and the honest negatives are in [`docs/notes/local-decision-models.md`](../notes/local-decision-models.md).

## References

- Cloudflare Clef-Flash model card and the System One API shape — <https://huggingface.co/Cloudflare/clef-flash>
- Clef weights as GGUF, converted by the llama.cpp org — <https://huggingface.co/ggml-org/Clef-Flash-GGUF>
- Liquid AI d1 decision models — <https://docs.liquid.ai/lfm/models/decision-models>
- TypeSafe System One — <https://docs.typesafe.ai/concepts/system-one.md>
- Edge vs cloud placement, model cascading — <https://huggingface.co/blog/daya-shankar/edge-vs-cloud-gpu>
