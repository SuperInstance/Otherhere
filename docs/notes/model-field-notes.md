# Model field notes

What working with TypeSafe Jev and MiniMax has taught us, with the numbers behind each lesson and what changed in the code because of it. This is a living log: add to it when an experiment teaches something, including experiments that didn't work. Decisions still go in ADRs (ADR-0013 for the photo pipeline); this file is the evidence.

Unless noted, photo numbers are correct field-answers on the fixed judge's `building-photos.v1` (10 photos, 31 answers) and on the tuning set `packages/models/tuning/building-photos.dev` (25 photos: 59 answers in the earlier experiments, 56 after the label clean-up below, which only the prompt experiment used).

## TypeSafe Jev

**Image limits are about size, not shape.** One photo resized to 150 sizes and bisected: Jev accepts an image when every side is 280–1,568 px, at any aspect ratio. Outside that it returns HTTP 400 "Invalid image dimensions". 280 and 1,568 are 20 and 112 patches of 14 px.
_In code:_ `JEV_IMAGE_SIDE` and `fitForJev` (the smallest resize into range, cropping only past 5.6:1).

**Don't upscale beyond the minimum.** The same photos sent at the minimum fit, at 1,024 px on the long side, and at 1,568 px: dev 54/54, 53/52, 53/52; held-out 27/27, 27/27, 26/26. More pixels from an upscaled thumbnail add nothing and can cost a point.
_In code:_ `fitForJev` only scales up when a side is under 280.

**A 4xx that isn't auth or rate limiting is a verdict on the input.** Treat it as a refusal, not a low score or a transport error.
_In code:_ `JevRejected`; the Ladder logs `outcome: "refused"` and moves to the next rung.

**Direct reads are steadier than describe-then-answer, but not perfectly steady.** Over two 3-run sets, Jev reading the photo moved by at most 1 answer; the describe-first path moved by 3–5. Scores near a threshold still flip occasionally (see ADR-0013), so one reading is a sample.
_In code:_ only confident fields become Facts; the Ladder never re-asks a rung to clear its bar.

**Its remaining errors are systematic, not noise.** A confidence-weighted vote over three harmless views (original, mirrored, 90% centre crop) scored the same as a single read: dev 54 vs 54, held-out 26 vs 26. Every view made the same mistakes: floors off by one, and a bias toward "shed" for flat or gabled roofs.
_In code:_ nothing. Self-consistency on one model doesn't fix systematic errors, so it isn't worth 3× the calls.

**It is cheap enough to measure everything.** A full experiment (hundreds of calls) costs cents, which is what made the rest of this file possible.

## MiniMax

**MiniMax-M3 reads images; M2.x doesn't.** M3 described a photo correctly (flat roof, 4 floors) that Jev-direct got wrong. M2.7 answered "I don't have the ability to view images".
_In code:_ the edge already falls back to MiniMax for vision when there is no Groq key. Its token allowance is now 4,000 (see the next note).

**M3 thinks before answering, and the thinking counts toward `max_tokens`.** A reply cut off mid-thought has no answer at all.
_In code:_ `stripThinking` also drops an unclosed `<think>` block, so a truncated reply reads as empty instead of as garbage. Vision and authoring calls get room (4,000 and 24,000 tokens).

**The Token Plan has a rolling rate limit.** After a few hundred calls in an hour it returns HTTP 429 "Token Plan rate limit reached (2062)" for every model.
_In code:_ a 429 or 503 from any provider raises `ProviderUnavailable`, and the Ladder skips that rung as `unavailable`, just like a spent daily budget. The tuner skips a round instead of crashing. Plan experiments around the window.

**As an author of question-pack wording, it produces valid variants but no real gain.** Three rounds of four rewrites each, judged on the dev photos: the best scored 57/59 against the baseline's 54–55. That's no more than run-to-run noise, the classic winner's curse of picking the best of twelve. On the held-out photos it scored 26/26, the same as the baseline, and it lost a point on the text set.
_In code:_ the tuner (`packages/judge/scripts/tune-pack.ts`) stays as tooling, and the pack stays at 1.0.0. The remaining errors are perception, not wording.

## Combining them

**Different model families make different mistakes.** On the held-out photos, MiniMax-M3 describing and Jev answering (A′) scored 27–28 against Jev-direct's 26. Taking roof shape and floors from A′ and the rest from Jev-direct scored 28–29. On the dev photos, though, A′ scored 46–49 and the combination 53–55 against Jev-direct's 54–55. Chosen on dev, as the protocol says, Jev-direct alone wins, so nothing was adopted. Ensembling across families is the most promising lever found so far, and it needs a larger dev set to settle.

**A describe-first pipeline needs to be allowed to say "no building".** A′ lost most of its dev points on `visible`: told to describe "the building nearest the centre", the vision model always found one, even on a skyline, a terrace row, an interior or a timber frame. A prompt allowing "No single building is clearly shown" fixed those, but misfired on close-cropped façades. Net: A′ dev misses on `visible` went from 4 to 3; Jev-direct went 55, 55 → 54, 55 on dev and 26, 26 → 27, 27 held-out.
_In code:_ not adopted (no gain on the dev set). The lesson stands for any describe-first path: the description prompt must not contradict the pack's own definition of `visible`.

## Evaluating

- **The text eval is saturated:** the current pack scores 62/62 on `building-observations.v1`, so it can't rank variants. It now serves only as a regression guard.
- **Choose on one set, report on another.** Every comparison above picks on the tuning photos and reports the fixed judge as held out. Twice, the held-out set alone would have suggested adopting something the dev set didn't support.
- **When models disagree with a label, re-examine it, but never flip it to their answer.** Three tuning labels (d07, d08, d10) were genuinely ambiguous and were removed (see `packages/models/tuning/photos/ATTRIBUTION.md`).
- **Small sets mean ±1–2 answers of noise.** Run everything at least twice and treat differences of 1–2 as unresolved.

## Round 2: what TypeSafe's docs and recent research said, tested

Read in full: TypeSafe's Box, Images, Models, Choice and "Jev 1.13 jaggedness" pages, plus five 2026 papers and the community project lists (sources below). Each idea was then tested on both photo sets, two runs each, picking on dev (56 answers) and reporting held-out (31). The whole round cost about $0.10 at Jev's real price.

| Variant (Jev reading the photo)                                                  | Dev        | Held-out |
| -------------------------------------------------------------------------------- | ---------- | -------- |
| V0: today's request, Jev 1.13                                                    | 54, 55     | 26, 26   |
| V1: same on Jev 1.14                                                             | 53, 53     | 26, 27   |
| V2: image under `photo` in the state, every question rewritten to point at it    | 48, 48     | 26, 26   |
| V3: V2 on 1.14, floors counted in code from "at least N floors" yes/no questions | 48, 46     | 27, 26   |
| V4: V2 on 1.14, both option orders, probabilities averaged                       | 48, 49     | 28, 27   |
| V5: V2 on 1.14, a Box finds the building, attributes asked on the crop           | 47, 48     | 27, 27   |
| V6: V0 asked in both option orders                                               | **55, 56** | 26, 26   |
| V7: photo-native questions but the original `visible` wording                    | 54, 53     | 27, 27   |
| V8: V7 in both option orders                                                     | 54, 54     | 27, 27   |
| V9: V8 on Jev 1.14                                                               | 50, 50     | 25, 26   |

**Jev 1.14 is worse than 1.13 on our photos,** in every pairing (V0/V1, V2, V8/V9). `jev-latest` points at 1.13 today but will move.
_In code:_ requests pin `JEV_MODEL = 'jev-1.13.0'`.

**The `visible` wording is fragile.** Every rewrite that referred to `photo` said "yes" to skylines, terraces and timber frames (V2–V5 lost 5–6 dev points, all on `visible`). The original wording, written for text, works best. This matches "JevOut" (natural context redirects decisions) and the docs' "literal reading" warning: small wording changes move a gate a lot, so change the gate only with an eval.

**Counting in code, Box crops and option-order averaging helped on held-out but not on dev.** The docs say Jev "does not count reliably" and recommend counting in code. V4 removed both held-out floor errors, but none of these held up on dev. Not adopted; worth re-testing with a bigger dev set.

**Readouts: the ordinal median of the floor probabilities scored the same as argmax (32/36).** The RLCD paper's "soft beats argmax" result is about ranking (AUROC), not about picking one label.

**Gate each field, not the whole pack: the biggest win so far.** The paper reports that keeping only the most confident half of decisions raised accuracy from 0.79 to 0.93. Our Ladder gated the whole pack on its least confident answer, so one shaky floor count threw away three good answers. Replayed over all saved answers:

| Gate                                            | Correct Facts | Wrong Facts |
| ----------------------------------------------- | ------------- | ----------- |
| Whole pack, minimum ≥ 0.7 (before)              | 19            | 4           |
| Each field: confidence × P(visible) ≥ 0.7 (now) | 63            | 4           |
| Each field at 0.55                              | 78            | 7           |

No Facts were written for photos without a single building. The wrong ones that remain are confident (0.7–0.9), so they are Jev's systematic errors, not noise.
_In code:_ `MIN_ANSWER_CONFIDENCE = 0.7`, and `observeBuilding` writes a field's Fact whenever that field clears it, accepted pack or not (ADR-0013 amendment).

**Jev's real price is $0.042 per million input tokens, and output is free.** Our placeholder was $0.50, so earlier cost figures in this file and in ADR-0013 are about 12× too high.
_In code:_ `JEV_PRICING` corrected.

### From the research, not yet built

- **Distilled rung.** Open decision models with the same `/v1/systemone` shape exist (StartLux-Decision, 0.8B–27B, with vision; weights are non-commercial). Jevstiller trains a local head on Jev's answers and answers locally only where it agrees. Both fit the brief's "distilled" Ladder rung, run as a Plugin job (ADR-0015).
- **Answer caching** keyed by state hash (pg-jev, jevql): makes repeat readings reproducible and free.
- **Per-question thresholds** fitted on labelled data (jevcal). Its authors warn that under about 100 labelled rows a fitted threshold is unreliable; our sets are 31 and 56, so 0.7 stays a single hand-picked bar.
- **Name polarity** ("Type-safe is not error-free"): option names can override their definitions, worst with yes/no names. Our options are short descriptive names, which is the safer case; worth checking if a pack ever uses yes/no option names.

Sources: [TypeSafe docs](https://docs.typesafe.ai/llms.txt) (Box, Images, Models, Jev 1.13 jaggedness); [Just Ask Jev (RLCD), arXiv 2609.29429](https://arxiv.org/html/2609.29429v1); [JevOut, arXiv 2609.30243](https://arxiv.org/html/2609.30243); [Type-safe is not error-free, arXiv 2609.26758](https://arxiv.org/abs/2609.26758); [ufakzeka-karar (order-invariant scoring), arXiv 2610.06744](https://arxiv.org/html/2610.06744v1); [StartLux-Decision](https://github.com/StartLuxLabs/Startlux-Decision); [awesome-typesafe-jev](https://github.com/AbdelStark/awesome-typesafe-jev).

## Round 3: Jev as a gate in front of other models, and as a reviewer of my own work

### For the app: a visibility gate

**Check each technique on the pipeline production actually runs.** Round 2's per-field gating was measured on Jev reading photos (path B). Production's default is path A: a vision model describes the photo, then Jev answers from the text. Replaying path A′ (MiniMax describing, then Jev) showed a worse, older problem. Told to describe "the building nearest the centre", the vision model always finds one, so path A writes Facts for skylines, terraces, interiors and timber frames.

**Jev reading the pixels is reliable at exactly that one decision.** Path B never wrote a Fact for a photo without a single building. So `observeBuilding` now also asks Jev, from the photo itself and in parallel with the vision call, the one `visible` question, and uses that answer when making Facts.

| Facts written (right / wrong / for photos with no building)         | Dev             | Held-out       |
| ------------------------------------------------------------------- | --------------- | -------------- |
| Path A′, replayed                                                   | 101 / 11 / 42   | 35 / 4 / 5     |
| Path A′ with Jev's visibility gate, replayed                        | 78 / 10 / 0     | 33 / 4 / 0     |
| Live, real `observeBuilding` (MiniMax vision, 2 runs): without gate | 26/2/12, 22/5/9 | 15/2/3, 16/4/3 |
| Live: with gate                                                     | 19/2/0, 17/4/0  | 15/2/0, 16/4/0 |

Live and replayed agree: the gate removes every no-building Fact, costs nothing on held-out, and costs a few correct Facts on dev. The live check costs $0.007 of Jev and $0.04 of MiniMax.
_In code:_ `VISIBLE_PACK` and the `gate` in `observeBuilding`; the edge wires the Jev provider in as the gate and logs each gate decision (`pack.building.visible`). If Jev refuses the image, the observation's own answer is used. The client now sizes photos and video frames with `fitForJev` (`sendSize`), so the gate isn't refused for size. The live check is `packages/judge/scripts/observe-eval.ts`.

**Combining the two paths didn't pay.** Writing a Fact only when both paths agree trimmed held-out wrong Facts (4 → 2 over two runs) but cost 10–25% of the correct ones. Path B's fields with path A′ filling gaps (dev 91/2, held-out 34/6) is the best mix by count, but needs your B-first decision (ADR-0013).

### For my work: Jev reviews my diffs against the invariants

`packages/models/scripts/jev-review.ts` splits a diff into hunks of added lines, using windows of at most 80 lines because a small state answers better. It asks Jev one literal Noul per semantic invariant: a paid call outside the router, executing model output, nondeterministic output, Google imagery, sharing private data, and a secret in code. All of a hunk's questions go in one request. Exact checks, such as "this edits the judge", stay in code, as TypeSafe's docs advise. It's a local tool, not CI, because it calls a paid API.

- **Its first run found a real problem in my code.** `jev-lab.ts` called TypeSafe with a raw `fetch`, outside the ModelRouter, so its spend was uncapped (p = 0.96). Fixed. Re-run on the commit before the fix, it still catches it (0.84), and the current branch reviews clean.
- **It also found a bug in itself.** Run from `packages/models`, `git diff -- .` only covered that package, so the first "0 of 36 hunks flagged" meant nothing. It now diffs from the repository root.
- **Text about a violation reads as a violation.** Its own source, which quotes every invariant question, was flagged on all five checks. This is the literal-reading and natural-context failure that TypeSafe's jaggedness page and the JevOut paper describe. A companion Noul ("these lines only mention or describe these things") discounts every check (p × (1 − mentions)), which cleared it. This is the Box docs' companion-question pattern, reused.
- **Measured on 60 synthetic hunks:** MiniMax wrote five violations and five hard negatives per invariant in this project's style. I read every label and excluded one as ambiguous (Google Places JSON). Result: 29 of 30 violations caught and no false positives among 30 hard negatives (28 of 30 after the fake keys in the set were replaced with `EXAMPLE…` placeholders, because GitGuardian flagged the realistic ones; a key that is obviously a placeholder no longer reads as "real-looking"). The one miss is borderline (`Date.now()` in a cache key). There was one cross-check alarm, a provider file that hard-codes a key and also calls Anthropic directly, which is arguably real. Costs about $0.001 a run.
- **Jev reads literally, so name the cases.** The randomness question first said only `Math.random` and missed `crypto.getRandomValues`. Naming "any unseeded source of randomness" with examples fixed it.
  _In code:_ `scripts/jev-review.ts` and `scripts/jev-review-eval.ts`, with the labelled set in `packages/models/tuning/review-hunks.jsonl`.

**The gate now runs first and can skip the vision call.** Over saved readings, photos of a building scored at least 0.49 and photos without one at most 0.34. Below `SKIP_BELOW = 0.25` the vision call and the Ladder are skipped. That saves about 25× the gate's cost on about half the no-building readings, adds the gate's latency (under a second) to every photo, and would have skipped no photo of a building.

### Ideas queued

- Run `jev-review` before every push.
- Have Jev gate other places where a cheap typed check beats a big model. Candidates: deciding whether a filmed-walk frame is worth sending at all (motion blur, no building in view), and judging whether an Overpass response looks truncated before it is ingested.

## Keys and environment (2026-10-18)

- Variable names changed mid-session: `TYPESAFE_AI_TOKEN` (was `TYPESAFEAI_KEY`), `CF_TOKEN`, `Z_AI_TOKEN`. Scripts read the new name and fall back to the old one.
- Z.ai authenticates, but every model returns error 1113 "Insufficient balance or no resource package". The plan needs topping up before it can be used.
- `GROQ_KEY` is gone from this environment, so describe-first experiments now use MiniMax-M3 for vision. A new Groq key is stored as `GROQ_TOKEN`; it reaches new sessions only.
