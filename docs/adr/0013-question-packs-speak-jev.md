---
status: accepted
---

# Question packs use TypeSafe's question shapes; vision stays a separate rung (for now)

Question packs are a **Published Language** we share with TypeSafe Jev, so their schema matches Jev's API exactly:

- `choice` criteria are a map from option name to description (1–255 options);
- `noul` criteria are `{ true, false }` descriptions, and the answer is a probability of "yes";
- `score` criteria are an ordered list of 1–10 level descriptions, and the answer is a probability-weighted level.

Packs can then be sent to Jev without translation, and other rungs (rules, distilled models, an LLM) must answer in the same shape.

**The brief is out of date here:** it says Jev "does not accept images, so the vision step comes first". Jev now accepts image `assets` and `box` questions behind a `TypeSafe-Danger-Zone-Images: true` header. We keep vision → structured observation → Jev as the default path, because the observation text is loggable, cacheable, replayable in evals, and model-agnostic, and because the image path is explicitly a "danger zone" preview. A direct-image Jev rung is a candidate to evaluate against the truth judge once it is stable.

Accepted by the project owner on 2026-10-18.

## Evaluation (2026-10-18, building-photos.v1, 10 CC-licensed photos, 31 labelled answers)

| Pipeline                                                   | Accuracy      | Cost   |
| ---------------------------------------------------------- | ------------- | ------ |
| A: Groq `qwen3.8-27b` vision → observation → Jev (default) | 74.2% (23/31) | $0.011 |
| B: Jev reading the image directly                          | 67.7% (21/31) | $0.009 |

B rejected a wide panorama (aspect 2.5:1) with "Invalid image dimensions". On the other nine photos B scored 21/26 (81%) against A's 18/26 (69%). B recognised a crowded street as "no single building" and read a log cabin correctly, where A did not. Both called the Hearst Tower's roof a hip.

With preprocessing for B (centre-crop to at most 2:1, upscale so the short side is at least 448 px), B accepts every photo:

| Run                 | A: vision → Jev | B: Jev direct                              |
| ------------------- | --------------- | ------------------------------------------ |
| 1, no preprocessing | 74.2%           | 67.7% (panorama rejected)                  |
| 2, crop only        | 67.7%           | 67.7% (panorama still rejected: too small) |
| 3, crop + upscale   | 83.9%           | 83.9%                                      |

B gave the same answers on every run for the images it accepted. A swings between 68% and 84% because the vision model's observation text varies from run to run. B is also about 10% cheaper and one network hop shorter.

**Open decision for the owner:** A remains the default as accepted. The evidence now favours trying B first (it is consistent, cheaper, and as accurate) and falling back to A when B is unsure. That would change the default this ADR accepted, so it needs an explicit decision.
