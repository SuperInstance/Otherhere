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

- **Reproducibility is the solid finding.** B returned identical answers on every run. A's answers changed on 8 of 10 photos, because the vision model's observation text varies and Jev faithfully follows it. This is a difference in kind and needs no larger sample: a reproducible answer can be cached, diffed and re-derived.
- **Preprocessing only buys B coverage.** On the nine photos B accepts raw, raw and preprocessed B score the same (21/26). The whole raw-vs-preprocessed gap is p03, the 2.5:1 panorama B refuses raw. For A, the raw-vs-preprocessed difference (78.5% vs 75.3%) is smaller than A's own run-to-run spread, so no crop effect is visible.
- **Accuracy is unresolved.** A ranges 21–26 of 31 across runs; B sits at 26, A's best. The gap is no larger than A's noise. 31 field-answers is a smoke test, not a comparison; more photos are needed to rank them on accuracy.
- **Coverage on real input is unknown.** Raw B refused 1 of 10 photos here (refusals are scored zero, and now surface as `JevRejected`). Preprocessing removed that, but the refusal rate on a real capture feed is what decides whether B can be the default, and it has not been measured.

### What reproducibility does and does not buy

A separate measurement on another project asked Jev the same question about the same document five times, for nine claims: no verdict flipped, but scores moved by up to 0.02, and the claim that moved most sat right at its 0.9 threshold. "B is identical on every run" holds for these photos at these confidences. It does not mean a single reading near a threshold is firm. So:

- **The record makes a verdict reproducible, not the judge.** Each rung is asked once per photo. Only an accepted answer becomes Facts (`source: "capture"`), and a later capture from the same source replaces the earlier one (ADR-0004). The latest reading is kept, never the best of several.
- **Nothing re-asks the same rung until it passes.** The Ladder escalates to a _different_ rung when one is unsure. When no rung clears the bar, the most confident answer comes back with `accepted: false` as a hint and is never written as a Fact. Re-asking the same rung to clear a gate would launder noise into confidence, so it stays out.
- **A refusal is a refusal.** Jev declining the input raises `JevRejected`, and the Ladder logs it as `outcome: "refused"`, not as a low score or a transport error. B-first would then ask A, which is a different rung reading different evidence (the observation text), and both attempts are in the decision log. The eval keeps scoring a refusal as zero, so coverage stays visible.
- **Not done yet:** recording spread. A reading within about 0.02 of the Ladder threshold (0.7) should be treated as uncertain, and when a question is asked more than once the spread belongs in the record. Neither is implemented; the first needs a margin in the Ladder, the second a repeated-ask mode that only the eval uses today.

**Open decision for the owner:** A remains the default as accepted. The case for B-first is reproducibility and cost, not accuracy. B-first would preprocess the photo, ask Jev directly, and fall back to A on a refusal or low confidence. Changing the default this ADR accepted needs an explicit decision, ideally after measuring B's refusal rate on real captures.
