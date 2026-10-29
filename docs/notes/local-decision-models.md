# Local decision models — field notes

What we learned by running decision models on the Thor instead of calling them over the network, with the numbers behind each lesson and what changed because of it. This is the evidence file for [ADR-0019](../adr/0019-local-decision-tiers.md); decisions live in the ADR.

Measurements taken **2026-10-28** on the Thor (NVIDIA Jetson AGX Thor, 122 GiB RAM, CUDA 13.2, `sm_110`), with llama.cpp **0.8.0-dev** (commit `2e0d86b`), CUDA build, GPU offload on, served as `llama-server` exposing `POST /v1/systemone`.

Every model in the tables below was measured on the **same build**, with the same flags (`-ngl 99 --flash-attn on --ctx-size 8192 -ub 4096`), one model at a time, with nothing else running. Latency is the median of 15 calls after 3 warmups; the HTTP round-trip baseline on the same server is **0.6–0.8 ms**, so the numbers are effectively all model time.

## The models

| model          | weights                        | decision type llama.cpp reports | backbone                                                               |
| -------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| `d1-omni-600M` | 407 MB Q8_0 + 263 MB mmproj    | `lfm2-d1-omni`                  | 587M total: 381M trunk + 94M SigLIP2 vision + 112M FastConformer audio |
| `d1-2B`        | 1.85 GB Q8_0 + 203 MB mmproj   | `lfm3-d1`                       | LFM3-VL-2B                                                             |
| `d1-3B`        | 2.87 GB Q8_0 + 583 MB mmproj   | `lfm2-d1`                       | LFM2.5-VL-3B                                                           |
| `clef-flash`   | 6.27 GB Q4_K_M + 879 MB mmproj | `clef`                          | Cloudflare's Qwen3.5-9B + joint schema head                            |

All four answer in Jev's exact shapes — `{ type: 'noul', noul }`, `{ type: 'choice', choice, probabilities, confidence }`, `{ type: 'score', score, legend, probabilities, confidence }` — so `Answer.parse` accepts them unchanged.

## The headline

|                                           | 1 question       | 3 questions, short state | 3 questions, long state | 3 questions + 320 px image |
| ----------------------------------------- | ---------------- | ------------------------ | ----------------------- | -------------------------- |
| **`d1-omni-600M`**                        | **9.7 ms**       | **15.4 ms**              | **33.9 ms**             | **94.9 ms**                |
| `d1-2B`                                   | 20.3 ms          | 60.3 ms                  | 104.6 ms                | 192.8 ms                   |
| `d1-3B`                                   | 27.3 ms          | 90.1 ms                  | 103.6 ms                | 203.2 ms                   |
| `clef-flash` (local)                      | 157.1 ms         | 284.4 ms                 | 386.6 ms                | 476.6 ms                   |
| _cloud Jev (our measurement)_             | —                | —                        | _~334 ms_               | —                          |
| _cloud clef-flash (Cloudflare's numbers)_ | _38.8 ms median_ | _38.8 ms median_         | —                       | —                          |

**The local flash tier beats the cloud by an order of magnitude.** `d1-omni-600M` answers a three-question pack in **15.4 ms** against **~334 ms** for the same pack from cloud Jev — a 22× speedup, and **$0** per call instead of $0.042/M. It is also 2.5× faster than _cloud_ clef-flash, the fastest cloud decision model on the market.

**Local clef-flash is the opposite of an upgrade.** It takes **157 ms for a single question**, which is **4× slower than the cloud clef-flash it is meant to replace** (38.8 ms). Cloudflare runs it on H200/B200 with SGLang; the Thor's consumer GPU cannot keep up with a 9B backbone.

**"Flash" means different things in the two families, and that is the whole story.** Cloudflare's `clef-flash` is 9B — "flash" meaning three times smaller than `clef` (27B). Liquid's smallest is 587M — fifteen times smaller than `d1-3B`. On this box the bottleneck is **backbone prefill**, which scales with parameter count, so the naming does not transfer: the Liquid model with the smallest number in its name is the one that wins.

**The local tier is worth having because it is _free_ and _reproducible_, and — measured on our own packs — close to the cloud arm.** Local clef-flash ties cloud Jev on text (both 100%) and leads it on photos by one answer (87.1% against 83.9%), at $0 against $0.0006 a run. `d1-2B` is within one answer of cloud Jev on text (98.4%) and behind it on photos (71.0%). See the accuracy section below. What that changes is that a local rung can be consulted _first, always_, so the cloud rung only has to be right when the local one is unsure.

## A pack is not one pass

llama.cpp builds **one prompt per question** for the d1 family — `tools/server/server-decision.cpp` says so in the comment on the function that fills a task: _"each question has its own prompt, with the spans that the head reads"_. Latency therefore grows with pack size.

Measured on the **long** state, 8 runs per row:

| questions      | 1        | 2        | 3        | 4        | 6        | 8        |
| -------------- | -------- | -------- | -------- | -------- | -------- | -------- |
| `d1-omni-600M` | 14.4 ms  | 22.3 ms  | 33.4 ms  | 41.2 ms  | 67.2 ms  | 82.9 ms  |
| `d1-2B`        | 35.9 ms  | 70.8 ms  | 104.1 ms | 138.3 ms | 206.6 ms | 280.0 ms |
| `d1-3B`        | 50.4 ms  | 80.8 ms  | 106.0 ms | 126.5 ms | 206.8 ms | 250.7 ms |
| `clef-flash`   | 218.4 ms | 284.6 ms | 387.5 ms | 435.8 ms | 620.3 ms | 742.5 ms |

`d1-omni-600M` pays ~14 ms for the first question (the state prefill) and then ~10 ms for each extra one. **`clef-flash`'s joint head does not make it cheaper here** — its first question alone costs 218 ms, and each additional question still adds ~65–90 ms of joint routing and scoring. The joint head amortises the _backbone_, not the _head_.

**Local pack size has to be budgeted.** A three-question pack is comfortable; an eight-question pack is not a per-tick decision.

## Vision is priced in pixels

Same pack, same model, one image at three sizes:

| image               | tokens | `d1-omni-600M` | `d1-3B`  | `clef-flash` |
| ------------------- | ------ | -------------- | -------- | ------------ |
| 320 px (82 k px)    | 1.2 k  | 94.9 ms        | 203.2 ms | 476.6 ms     |
| 512 px (197 k px)   | 2.6 k  | 159.8 ms       | 316.9 ms | —            |
| 640 px (328 k px)   | 4.3 k  | 234.7 ms       | 387.8 ms | —            |
| 2,050 px (3.4 M px) | 7.8 k  | —              | 2,795 ms | —            |

A full-resolution frame is unusable: **2.8 s**. The same photo at 320 px is 203 ms on `d1-3B`. Any local vision tier needs its own size cap, lower than the cloud's. `JEV_IMAGE_SIDE` in `packages/core/src/capture/image.ts` allows sides up to 1,568 px, which is right for cloud Jev and far too slow for a local model.

**The cloud bound is a floor as well as a ceiling.** Jev accepts an image only when **every** side is inside 280–1,568 px (re-measured 2026-10-28 against the live API: 279 px is rejected, 280 px is accepted — see the accuracy section). The local models have no such floor, so an image that is fine locally can be refused by the cloud. Any image that has to satisfy both has to carry its short side over 280, which for a wide panorama means raising the long side rather than cropping. Getting this wrong is not a small error: it silently scored the cloud arm zero on a five-answer case.

_In code:_ the local path still needs its own fit function, not `fitForJev` — but it must respect the same 280 px floor if the same bytes are to go to both.

**A decision model reads images correctly, not just tokens.** Asked to classify a contact sheet of 3D renders, `clef-flash` returned `kind: 'render'` at 0.98 confidence and `is_grid: 0.94`; `d1-3B` on the same image returned `render` at 0.98, `is_grid: 0.89`, and a count of "21+" at 0.84. The semantics are sound. Only the latency was wrong.

## Serving: the local server _is_ the cloud API

`llama-server` exposes `POST /v1/systemone` — the TypeSafe System One route — and `packages/models/src/providers/jev.ts` already posts to `{baseUrl}/v1/systemone` with the body `{ model, state, questions }`. **A local model is a base-URL change, not a new integration.**

Three differences between the two servers, all small:

- **Images.** Cloud Jev takes an `assets` map plus the `TypeSafe-Danger-Zone-Images: true` header (`askAboutImage` in `jev.ts`). llama.cpp takes `images` as an array of **plain data-URL strings** (`server-decision.cpp`: _"images must be data URLs"_), up to 8.
- **Score scale.** A local model returns a probability-weighted level as a float with a 0-indexed `legend`; the pack schema's score questions are an ordered list of 1–10 levels. Both parse under `Answer.parse`, but `Answer` drops `legend`, so a consumer cannot see the scale from the parsed value alone.
- **Confidence.** A local `choice` or `score` answer may arrive without `confidence`, which `Answer.parse` requires.

_In code:_ `LocalDecisionProvider` in `packages/models/src/providers/local.ts` handles all three, and `localRung` in `packages/models/src/ladder.ts` puts it on the reserved `distilled` rung.

## The local server's exposure

The Thor runs the flash tier as `d1-flash.service`, serving `d1-omni-600M` on **port 8095**.

It is bound to **`0.0.0.0` with no API key**, by the project owner's choice on 2026-10-28, so anything on `192.168.0.0/24` can use the Thor as a shared decision model. Consequences, accepted deliberately:

- **No authentication.** Anyone on the LAN can spend the Thor's GPU for free. The decision model is rate-unlimited.
- **CORS allows every origin.** A browser on the LAN can POST to it from any page it happens to have open, so a stray tab can drive the Thor's GPU.
- **Both are reversible.** This build of `llama-server` supports `--api-key` and `--api-key-file`; adding one is a flag on the unit and a header on the caller.

The provider's default base URL stays `http://127.0.0.1:8095`, because the agent app runs on the Thor itself. A caller elsewhere on the LAN points at `http://192.168.0.78:8095` explicitly.

## Honest negatives

**`d1-2B` does not load on llama.cpp 0.7.0-dev.** Its backbone is LFM3-VL-2B and the build reports `unknown model architecture: 'lfm3'`. Upstream llama.cpp added it later (`model : add LiquidAI/LFM3-1.7B and LiquidAI/LFM3-VL-2B`, #31252) plus LFM3-Omni and LFM3 video input (#31257, #31283). On the upstream build it loads and reports `lfm3-d1`, and it is the second-fastest model here. **This is the one case where the newest small model is unusable and an older bigger one is the only option** — `d1-3B` works on both builds, `d1-2B` only on upstream, and `d1-omni-600M` on both because it is LFM2-based.

**Clef needs its physical batch raised before it will take a real pack.** Its joint head processes the whole prompt in one ubatch, so with the default `-ub 512` a six-question pack fails with HTTP 500: _"input (683 tokens) is too large to process. increase the physical batch size"_. `-ub 4096` fixes it, and raises the image token cap from 256 to 1024. Worth knowing before blaming the model.

**The Cloudflare weights ship as transformers with custom code, not GGUF.** `Cloudflare/clef-flash` is `Qwen3_5ForConditionalGeneration` plus a separate `joint_head.safetensors` (243 MB) and `joint_schema_model.py` — 18.8 GB of BF16 with a `transformers`-only loading path. The official Cloudflare recipe is SGLang in Docker (`lmsysorg/sglang:dev-clef`). It is servable by llama.cpp only because the llama.cpp org converted it (`ggml-org/Clef-Flash-GGUF`, Apache-2.0, `decision_type: clef` in the GGUF metadata). The local path depends on a conversion, not on Cloudflare's own artefacts.

**We compared local and cloud accuracy on the same packs.** See the accuracy section below. The cloud arm turned out not to be the ceiling.

**A local decision model is not bit-reproducible.** Quantization changes logits, so the same pack can answer differently across builds of the same model. That is fine for an advisory rung and fatal inside a deterministic sim (invariant 2), which is why the decision rung stays outside the core and its answers are recorded rather than assumed.

**Local clef-flash is not off-line, and it is the best model on the box.** It was live at `thor.local:8096` the whole time this was measured. It scores highest of any arm on both evals — 100% text, 87.1% photo — at zero cost. It is kept out of the _reflex_ tier only because 1.1 s per pack is too slow for a per-tick decision — not because it is worse. On text it ties cloud Jev at 100%; on photos it leads by one answer, which is noise at this sample size. It is the right choice when the answer must be right, and for offline labelling, evals and checking the fast tier.

## Accuracy on the fixed judge

Latency alone does not say which model should answer a pack. We ran the **same packs through the same fixed judge** (`packages/judge/src/score.ts`, invariant 6 — the judge was not modified), changing only who answers. Harness: `packages/judge/scripts/local-vs-cloud.ts`.

```bash
MODE=text  RUNS=2 pnpm --filter @otherhere/judge exec tsx scripts/local-vs-cloud.ts
MODE=photo RUNS=2 pnpm --filter @otherhere/judge exec tsx scripts/local-vs-cloud.ts
```

- **text** — `building-observations.v1`, 14 cases, **62** labelled field-answers. The model reads a written observation.
- **photo** — `building-photos.v1`, 10 photos, **31** labelled field-answers. The model reads the photo. Every arm saw **byte-identical image data**, so the only variable was the model.

Both tables below are one measurement set: same day, same harness, two runs per arm, **six arms**, **zero failed calls**.

### Text — 62 answers

| arm                      | score     | accuracy | median     | cost/run | spread | errors |
| ------------------------ | --------- | -------- | ---------- | -------- | ------ | ------ |
| `local-omni`             | 41/62     | 66.1%    | 78 ms      | $0       | 0      | 0      |
| `local-2b`               | 61/62     | 98.4%    | 189 ms     | $0       | 0      | 0      |
| `local-3b`               | 58/62     | 93.5%    | 240 ms     | $0       | 0      | 0      |
| **`local-clef`**         | **62/62** | **100%** | 965 ms     | $0       | 0      | 0      |
| **`cloud-jev`**          | **62/62** | **100%** | **114 ms** | $0.0006  | 0      | 0      |
| `cloud-llm` (MiniMax-M3) | 61–62/62  | 99.2%    | 3,705 ms   | $0.0075  | 1      | 0      |

### Photo — 31 answers

| arm                      | score     | accuracy   | median     | cost/run | spread | errors |
| ------------------------ | --------- | ---------- | ---------- | -------- | ------ | ------ |
| `local-omni`             | 4/31      | 12.9%      | 287 ms     | $0       | 0      | 0      |
| `local-2b`               | 22/31     | 71.0%      | 463 ms     | $0       | 0      | 0      |
| `local-3b`               | 21/31     | 67.7%      | 576 ms     | $0       | 0      | 0      |
| **`local-clef`**         | **27/31** | **87.1%**  | 1,048 ms   | $0       | 0      | 0      |
| **`cloud-jev`**          | 26/31     | 83.9%      | **288 ms** | $0.0007  | 0      | 0      |
| `cloud-llm` (MiniMax-M3) | 20–23/31  | 64.5–74.2% | 17,926 ms  | $0.0233  | 1–2    | 0      |

Spread is the difference between the best and worst of two runs. Latency is the median of the
idle-box run; a second run with a build on the machine gave the same scores with medians 20–30%
higher, so the local numbers above are the idle ones.

**Reproducibility, measured across two independent invocations of the whole harness.** The four
local models and cloud Jev returned **exactly** the same scores every time — 4, 22, 21, 27 and 26
on photos, and 41, 61, 58 and 62 with cloud Jev's 62 on text. The cloud LLM did not: 23/22 on
photos in one invocation and 20/21 in the other, and 61/62 on text. One cloud Jev run outside
those two invocations returned 25/31 on photos. **A cloud reading is a sample; a local reading is
a fact.**

### The cloud Jev photo arm was wrong before, and it was the harness

The first run of this comparison reported cloud Jev at **21/31 (67.7%)** on photos with **two failed calls**. Both failures were the same case:

```
error: jev: rejected (HTTP 400) {"detail":{"error_type":"api_usage_error","message":"Invalid image dimensions."}}
```

**Not a transport failure, and not the model's fault.** `p03` is a 600×242 panorama. The harness sized images by their **long** side (512 px), which made `p03` 512×**207** — and the cloud Jev API refuses any image whose **every side** is not inside 280–1,568 px. The repo already knew this: `JEV_IMAGE_SIDE` in `packages/core/src/capture/image.ts`, measured on 2026-10-18 in [ADR-0013](../adr/0013-question-packs-speak-jev.md). The harness was violating the repo's own rule, so the cloud arm was scored zero on a five-answer case for a reason that had nothing to do with Jev.

The fix keeps **both** bounds at once — the long side is raised when the short side would otherwise fall under 280, rather than cropping:

```
shared image (same bytes for every arm): p01=512x383  p02=512x512  p03=695x280  p04=414x512
                                        p05=512x383  p06=512x383  p07=347x512  p08=512x341
                                        p09=512x512  p10=512x429
```

`p03` becomes 695×280 — a mild 1.16× upscale, **no crop**, the whole panorama preserved. The cloud arm then answers it perfectly (5/5), and cloud Jev moves from 21/31 to **26/31**.

**The corrected 26/31 = 83.9% is the number ADR-0013 already recorded** for Jev reading the photo directly with a fitted image ("B, fitted", 26/26/26 across three runs). The harness had drifted below the measurement the repo was already standing on; this run puts it back.

The floor was re-measured against the live API on 2026-10-28, independently of ADR-0013's 150-size bisection — `~/d1-lab/probe_jev_image_floor.py`:

| side   | 200 px | 256 px | 272 px | 279 px | **280 px** | 281 px | 288 px | 512 px |
| ------ | ------ | ------ | ------ | ------ | ---------- | ------ | ------ | ------ |
| result | 400    | 400    | 400    | 400    | **200**    | 200    | 200    | 200    |

**280 px exactly.** The rule in `JEV_IMAGE_SIDE` is correct as written.

### What the numbers say

- **Fast and wrong are not opposites.** `d1-omni-600M` answers in 78 ms and gets 66.1% on text and **12.9% on photos**. It is the fastest model on the box and the worst one on the vision path. Latency and accuracy came apart completely.
- **The cloud Jev is the fastest _perfect_ answerer we have on text.** 62/62 at 114 ms — 8.5× faster than local clef-flash, 1.7× faster than `d1-2B`, and 33× faster than the cloud LLM. It costs $0.0006 a run, and it needs a key and a network; that is the whole of the difference.
- **Local clef-flash is the accuracy champion, by one answer on photos.** 100% on text and 87.1% on photos, against cloud Jev's 100% and 83.9%. **On text they are tied.** On photos the gap is 27 against 26 — one answer, and `model-field-notes.md` is explicit that one answer is noise. Local clef-flash is also **3.6× slower** than cloud Jev on photos (1,048 ms against 288 ms).
- **`d1-2B` is the reflex.** 98.4% on text at 189 ms ≈ 5 Hz, ample for a setpoint the 60 Hz core interpolates toward. `d1-3B` is both slower and less accurate here (93.5% at 240 ms).
- **Local is deterministic _within_ a run; the smallest model is not perfectly reproducible across runs.** Every local model gave identical answers across the two runs of a single invocation, and `d1-2B`, `d1-3B` and `clef-flash` were identical across two _separate_ invocations too. But `d1-omni-600M` scored 42/62 in one invocation and 41/62 in another — one case (`b06`) flipped. The likeliest cause is llama.cpp's batched GPU reductions, whose float order depends on how the prompt was split, which perturbs a near-tie in the smallest model. **The fastest model is also the least numerically stable.**
- **The cloud LLM is the noisiest arm, and cloud Jev is not perfectly reproducible either.** The cloud LLM moved by one answer on text and up to three on photos between invocations. Cloud Jev gave the same 26/31 twice in a row on photos but gave 25/31 on a separate run. Every local model gave identical answers every time. **A cloud reading is a sample; a local reading is a fact you can cache and diff.**

### The honest limits of this comparison

- **31 and 62 answers are small sets.** `model-field-notes.md` is explicit that one to two answers is noise. The 41 → 61 gap on text is 20 answers and is real. The 26 → 27 gap between cloud Jev and `clef-flash` on photos is **one answer and is not**. Treat them as tied.
- **Two packs, one domain.** Street-level building descriptions in Sitka. Nothing here says a local decision model beats a cloud one in general.
- **The local arms and the cloud arm do not get the same _preprocessing_ in production.** Here they get the same bytes, which is what makes the comparison fair. In production the cloud path uses `fitForJev` (crop past 5.6:1, scale into 280–1,568 px) and the local path should use its own smaller fit. The numbers above are about the models, not about the production fits.
- **The cloud arms were paid for.** `cloud-jev` at $0.0006–0.0007 a run and `cloud-llm` at $0.0075–0.0233. The local arms are $0 and are on the box.

## Reproduction

```bash
# serve a decision model
~/llama.cpp-upstream/build-up/bin/llama-server \
  -m ~/models/d1-omni-600M/d1-omni-600M-Q8_0.gguf \
  --mmproj ~/models/d1-omni-600M/mmproj-d1-omni-600M-Q8_0.gguf \
  --host 127.0.0.1 --port 8095 -ngl 99 --flash-attn on --ctx-size 8192 -ub 4096

# bench a pack at several sizes
python3 ~/d1-lab/bench_systemone.py --url http://127.0.0.1:8095/v1/systemone --model d1-omni-600M --n 15
python3 ~/d1-lab/bench_scaling.py  --url http://127.0.0.1:8095/v1/systemone --model d1-omni-600M --n 8
```

Scripts live in `~/d1-lab/` on the Thor: `bench_systemone.py` (latency by question count, state length and image size), `bench_scaling.py` (the pack-size curve), and `sweep2.sh` (every model on one build, one at a time).

The upstream build lives in `~/llama.cpp-upstream/` (a git worktree of `origin/master` at `2e0d86b`), separate from `~/llama.cpp/build` (0.7.0-dev) because `llama-coder30.service` depends on that one.

## Models on the Thor

| path                     | size   | what                                            |
| ------------------------ | ------ | ----------------------------------------------- |
| `~/models/d1-omni-600M/` | 639 MB | fastest on the box; triage gate only            |
| `~/models/d1-2B/`        | 2.0 GB | **the reflex tier** — needs the upstream build  |
| `~/models/d1-3B/`        | 3.3 GB | the decision tier with vision                   |
| `~/models/clef-flash/`   | 7.1 GB | strongest answers; too slow for a per-tick loop |

Fetch scripts: `~/fetch-liquid-d1.sh` and `~/fetch-clef-flash.sh`, both logging to `~/cold-librarian-run.log`. The clef weights were verified by sha256 against the Hugging Face metadata before serving.
