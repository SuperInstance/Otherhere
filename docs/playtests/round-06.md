# Round 06 — the paid call comes off the public endpoint

## Played

Production at both sizes before any change (the probe gained `--viewport`/`--phone` for this, PR #38). Desktop 1280×800: the full walk scene — arrival settled with 7/7 cells verified, 1525 features, 0 mismatched, 0 errors; four walk legs reached 10 ready / 2 sketch, 2049 features; demo generators; goto Lincoln Street (settle 22.1 s); postcard save (cut off by my own 560 s tool timeout mid-click, not a product error). Phone 390×844 touch profile (`r6-live-phone3`): arrival settled 10.6 s, 7/7 verified, 1525 features; full walk `scene-done`, 10 ready / 2 sketch, 2049 features, 0 console errors. Evidence: `round-06/desktop-settled.png`, `round-06/phone-settled.png`, `round-06/phone-after-walk.png`.

## Found

- **The paid place-vector call sat on the public endpoint** (review P0 #1, this round's centerpiece — details under Fixed).
- First `--phone` attempt rendered the canvas at 2560×1600 (my flag bug: `--phone` did not imply a phone viewport) and the walk scene died at its canvas click — the focus click was hardcoded at 640,400, outside a 390-wide canvas.
- The pixel-determinism e2e specs (`walk.spec.ts:42`, `postcard.spec.ts:26`) fail in this container on pristine `main` too — ground-plane diffs up to ~200/255, within-run compares; CI is green on the same code. Filed as #40 with suspects (un-frozen time in a display layer vs renderer build) and an acceptance check.
- At phone size, HUD `details` real clicks fall to the DOM fallback under SwiftShader (recorded by `clickHud`; the fallback is the designed path).

## Fixed

- **PR #39 — `edge: take the paid place-vector call off the public endpoint`.** The public `GET /api/towns/:town/vector` is now a pure read (404 when nothing stored); `POST /api/ops/towns/:town/vector` (OPS_TOKEN) is the only compute: refuses Towns with no Features, single-flights the in-flight promise per Town, clean 503 on an exhausted budget. Place vectors draw from their own `jev-place` budget key. `invalidateEssence()` no longer drops the stored vector — the state hash decides the re-ask — and the census is cached. ADR-0018 amended. 7 tests fail on `main`, pass on the branch.
- **PR #38 — `playtest: viewport and phone flags on the probe`.** The round protocol's phone-size play needed them; one probe, flags not forks.

## Measured

- Edge suite 47 → 51 tests; full `pnpm -r test` 306/306; lint, typecheck, e2e (CI) green on both PR heads; GitGuardian green.
- Single-flight: two concurrent computes charge exactly one call (fake per-call cost $0.0000294 at 700 input tokens × $0.042/M).
- Production after merge: `/api/health` ok; public read on the Zürich town → 404 `no place vector for that Town yet`; ops compute without token → 404 (hidden).
- Phone arrival settle 10.6 s vs desktop 24.1 s in the same scene on the same machine.

## Next

1. **P0 #2 — gift mode hides what the user and the licence need** (#41): the clipped status line (attribution, mismatch, errors) and hidden match buttons; e2e with `toBeVisible()`.
2. **P0 #3 — `World.reload` leaks a group when a Cell reloads while it loads** (#42): carry `stale` forward or retire it, per-Cell generation guard, re-index after retiring.
3. **P0 #4 — the status line is a screen-reader alarm** (#43): move the ticking clock/weather out of the live region; announce only meaningful changes.

Also open from this round: #40 (e2e determinism in the dev container). Needed from the owner: the production `OPS_TOKEN` value (or one run of `POST /api/ops/towns/<town>/vector` per town) to re-establish the two vectors retired with the old meta key — each re-ask costs ~$0.00003.
