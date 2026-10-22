# Round 14 — Arc 0 finished: the three P0s, each red first

The review of rounds 08–13 named three P0s; all three are closed with tests that fail the way the real bug fails. Three PRs, each merged only on green, each verified in production after its deploy. No new feature work: Arc 0 before Arc 1, as agreed.

## Played

Production was read before changing anything — by the reviewer, whose round-08–13 review (played at 1280×800 and 390 px the day before) set this round's queue; I re-read it rather than re-walking pre-change (honest note: no fresh pre-change walk from me this round). After the merges I played production at both sizes: `r14-after-desktop` (walk scene end to end, demo lot, Lincoln St; 7/7 then 10 ready, 0 errors, 0 mismatched), `r14-after-phone` (full phone walk, scene done; 7/7, 0 errors), and `r14-after-tables` after the address change deployed — the run that matters for P0 #3: **7/7 verified, 0 mismatched, on a world whose every Bundle address had just moved**. Evidence in `round-14/`: the settled street after the rebuild (desktop) and the phone view.

## Found

- The material-recording mock in `world.test.ts` is per-**file**, not per-test: earlier tests' disposed materials polluted the new test's leak assertion until it baselined its own. Test-honesty finding, fixed inside #79.
- The probe writes its artifacts to a doubled `otherhere-lab/otherhere-lab/` directory — one more `../` than intended, and the exact class of path problem the P3 tooling item names.
- Both long desktop sessions ended with the browser closing itself mid-scene (during late HUD interaction, after 6+ minutes of software GL). Walks and screenshots before that are clean and 0-error; unknown whether it is our leak or the container. Watching it — issue open.
- #52 (phone HUD input starvation) reproduced exactly as in round 13, unchanged by this round's fixes.

## Fixed

- **#79 `client: carry an interrupted wake across a reload chain (review P0 #1)`** — the `else if (s?.stale)` branch of `reload()` handed the stale Bundle on but dropped the wake: one leaked shader program per double reload, and `advanceWakes` stopped tracking it. The wake rides the chain now, and `stats().waking` counts wakes on loading states (a carried wake is breathing on the stale Bundle on screen — the counter and the status line should see it).
- **#80 `client: settle a video seek only when the browser is no longer seeking (review P0 #2)`** — Chrome and Firefox move `currentTime` on assignment, so a late `seeked` from a timed-out seek read "at target" for the replacement seek and settled it: the wrong frame sharpened a building. The guard now also requires `!video.seeking`, and the fake video behaves like a real browser (moves on assignment, raises `seeking`, late-`seeked` while still seeking).
- **#81 `core: hash the lookup tables into the content address (review P0 #3)`** — `REGION_PRIORS`, `GENERIC_PRIOR`, `FOREST_BIOMES`, `FOREST_SPECIES`, `RAINFOREST_BOX` and the extracted `REGION_BOX` are hashed as data, unconditionally. Table edits move the address the way Fact edits do; no convention left to remember. Interpreter 0.6.0 → 0.6.1, golden re-pinned (vertexCount unchanged: 3701).

## Measured

- Red before → green after, all three (assertion output in the PR bodies): P0 #1 `expected +0 to be 1` at `world.test.ts:502`; P0 #2 `expected true to be false` at `capture.test.ts:122`; P0 #3 `a region wall colour: expected '4863318a…' not to be '4863318a…'`.
- Tests: 361 → **362** (core 133 → 134), all packages green; e2e **20/20** specs green locally (chunked; the container's Chromium is build 1200 while Playwright 1.64 pins 1248, so runs go through `PW_CHROMIUM`).
- Production after each deploy: `/api/health` `{"ok":true,"interpreter":"0.6.1"}`; arrival settle 12.0 s desktop / 10.4 s phone before the address change, 16.3 s immediately after (every Bundle rebuilt once under new addresses — the same one-time cost class as round 13's re-imagined town), 7/7 verified, 0 mismatched on all three runs.
- Adversarial self-review before merging (two seats, per the brief): DeepSeek-V3 found no real bugs in #80/#81; its one surviving hypothesis on #79 (`advanceWakes` never visiting loading states → a delayed leak) was judged **not real** by Jev (typesafe SystemOne, confidence 0.98) against the actual `advanceWakes` code, which iterates every state. Ledger with costs sealed at `scripts/reviews/r14-adversarial.jsonl` (outside the repo).
- Model spend: **$0.000990** (DeepSeek) + four Jev judgment calls — under a thousandth of the $1 round budget.

## Next

1. **P1 #4** — the region prior overrides the large-building roof rule (`building.basic` 0.3.1: gate the region's roof weights on footprint; in-region large-building test; golden re-pinned). Issue open with acceptance check.
2. **P1 #5** — the postcard pixel bound is one CI measurement: find the root cause (uniform precision across contexts is the lead) or measure 10 runs and set the bound from the spread, numbers in the PR.
3. **P1 #6** — the wind wrap limits the jitter but doesn't remove it: wrap per term (or a period the shader's rates divide), wrap `sceneTimeU`, and make the e2e check fail without the fix.
