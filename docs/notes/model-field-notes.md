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
_In code:_ only accepted answers become Facts; the Ladder never re-asks a rung to clear its bar.

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

## Keys and environment (2026-10-18)

- Variable names changed mid-session: `TYPESAFE_AI_TOKEN` (was `TYPESAFEAI_KEY`), `CF_TOKEN`, `Z_AI_TOKEN`. Scripts read the new name and fall back to the old one.
- Z.ai authenticates, but every model returns error 1113 "Insufficient balance or no resource package". The plan needs topping up before it can be used.
- `GROQ_KEY` is gone from this environment, so describe-first experiments now use MiniMax-M3 for vision.
