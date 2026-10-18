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

Those three rows changed the preprocessing and the run at the same time, and A saw the raw photo while B saw the crop, so they could not separate a crop effect from a path effect.

### Like-for-like re-run (3 runs per column)

Each pipeline ran on the raw photo and on the same preprocessed bytes. Rows count correct field-answers out of 31. "Stable" means a photo got the same answers on all three runs. Reproduce with `RUNS=3 pnpm --filter @otherhere/judge photos`.

| Column          | Runs     | Mean  | Spread | Stable photos | Refused | $/run  |
| --------------- | -------- | ----- | ------ | ------------- | ------- | ------ |
| A, raw photo    | 26 21 26 | 78.5% | 5      | 2/10          | none    | $0.011 |
| A, preprocessed | 23 22 25 | 75.3% | 3      | 2/10          | none    | $0.011 |
| B, raw photo    | 21 21 21 | 67.7% | 0      | 9/10          | p03     | $0.009 |
| B, preprocessed | 26 26 26 | 83.9% | 0      | 10/10         | none    | $0.010 |

What this does and does not show:

- **Reproducibility is the solid finding.** B returned identical answers on every run here (but see the re-run below: not always). A's answers changed on 8 of 10 photos, because the vision model's observation text varies and Jev faithfully follows it. This is a difference in kind and needs no larger sample: a reproducible answer can be cached, diffed and re-derived.
- **Preprocessing only buys B coverage.** On the nine photos B accepts raw, raw and preprocessed B score the same (21/26). The whole raw-vs-preprocessed gap is p03, the 2.5:1 panorama B refuses raw. For A, the raw-vs-preprocessed difference (78.5% vs 75.3%) is smaller than A's own run-to-run spread, so no crop effect is visible.
- **Accuracy is unresolved.** A ranges 21–26 of 31 across runs; B sits at 26, A's best. The gap is no larger than A's noise. 31 field-answers is a smoke test, not a comparison; more photos are needed to rank them on accuracy.
- **Coverage on real input is unknown.** Raw B refused 1 of 10 photos here (refusals are scored zero, and now surface as `JevRejected`). Preprocessing removed that, but the refusal rate on a real capture feed is what decides whether B can be the default, and it has not been measured.

### Jev's image limits, measured (2026-10-18)

One photo resized to 150 sizes, then bisected: **Jev accepts an image when every side is between 280 and 1,568 px, at any aspect ratio** (3:1 was accepted at 320–512 px tall). Below 280 or above 1,568 it answers HTTP 400 "Invalid image dimensions". So p03 (600×242) was refused for being 242 px tall, not for being a panorama, and cropping it to 2:1 was never needed. `fitForJev` now does the smallest fix: scale every side into 280–1,568 px, cropping only past 5.6:1.

For the app's real input this nearly settles coverage on dimensions. The client sends photos and video frames at most 1,280 px on the long side, so a refusal needs a short side under 280 px: a panorama wider than about 4.6:1. Ordinary phone photos (4:3, 16:9, portrait) and video frames always fit. Refusals for content rather than size have not been seen and are not measured.

Re-run with the minimal fit (3 runs per column, correct out of 31):

| Column                   | Runs     | Mean  | Spread | Stable photos | Refused |
| ------------------------ | -------- | ----- | ------ | ------------- | ------- |
| A, raw photo             | 25 22 25 | 77.4% | 3      | 1/10          | none    |
| A, fitted                | 24 19 22 | 69.9% | 5      | 2/10          | none    |
| B, raw photo             | 20 21 21 | 66.7% | 1      | 9/10          | p03     |
| B, fitted                | 26 26 26 | 83.9% | 0      | 10/10         | none    |
| B, earlier crop to ≤ 2:1 | 26 26 26 | 83.9% | 0      | 10/10         | none    |

- The minimal fit scores the same as the 2:1 crop without throwing away any of the photo.
- **B is not perfectly reproducible.** On raw photos one answer flipped in one of three runs. Across both re-runs B moved by 1 field-answer in 1 of 4 column sets, against A's 3–5 in every set. B is far steadier than A, but a single B reading near a threshold is still a sample (next section).
- A's two columns again differ by less than A's own spread.

### What reproducibility does and does not buy

A separate measurement on another project asked Jev the same question about the same document five times, for nine claims: no verdict flipped, but scores moved by up to 0.02, and the claim that moved most sat right at its 0.9 threshold. "B is identical on every run" holds for these photos at these confidences. It does not mean a single reading near a threshold is firm. So:

- **The record makes a verdict reproducible, not the judge.** Each rung is asked once per photo. Only a confident answer becomes a Fact (`source: "capture"`), judged field by field: each field's confidence times P(one building visible) must reach 0.7 (amended 2026-10-18, see below). A later capture from the same source replaces the earlier one (ADR-0004). The latest reading is kept, never the best of several.
- **Nothing re-asks the same rung until it passes.** The Ladder escalates to a _different_ rung when one is unsure. When no rung clears the bar, the most confident answer comes back with `accepted: false`; only its fields that are individually confident become Facts. Re-asking the same rung to clear a gate would launder noise into confidence, so it stays out.
- **A refusal is a refusal.** Jev declining the input raises `JevRejected`, and the Ladder logs it as `outcome: "refused"`, not as a low score or a transport error. B-first would then ask A, which is a different rung reading different evidence (the observation text), and both attempts are in the decision log. The eval keeps scoring a refusal as zero, so coverage stays visible.
- **Not done yet:** recording spread. A reading within about 0.02 of the Ladder threshold (0.7) should be treated as uncertain, and when a question is asked more than once the spread belongs in the record. Neither is implemented; the first needs a margin in the Ladder, the second a repeated-ask mode that only the eval uses today.

**Open decision for the owner:** A remains the default as accepted. The case for B-first is reproducibility and cost, not accuracy. B-first would fit the photo with `fitForJev`, ask Jev directly, and fall back to A on a refusal or low confidence. Refusals for size are now known to be limited to extreme panoramas, so the remaining unknowns are refusals for content and accuracy on a larger photo set. Changing the default this ADR accepted needs an explicit decision.

## Amendment (2026-10-18): gate Facts per field, pin the model

- **Per-field gating.** The Ladder still escalates on a pack's weakest answer, but Facts no longer wait for the whole pack. Each field becomes a Fact when its confidence × P(visible) ≥ 0.7. Over saved Jev-direct answers on both photo sets, the old whole-pack gate wrote 19 correct and 4 wrong Facts; gating each field at 0.7 writes over 3× as many correct ones (63 vs 19) with the same 4 wrong, and none for photos with no single building. Evidence: `docs/notes/model-field-notes.md`.
- **Pinned model.** Requests name `jev-1.13.0`, not `jev-latest`. On our photos `jev-1.14.0` scored lower in every variant tried, and the alias moves when a release ships. Re-run the photo eval before moving the pin.
