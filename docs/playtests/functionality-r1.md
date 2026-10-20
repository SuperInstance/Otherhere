# Play-test round 1 — functionality (outside-in)

Round OH-A1, 2026-10-19/20. The instrument: [`apps/client/playtest/probe.mjs`](../../apps/client/playtest/probe.mjs), an exploratory Playwright probe that plays like a player (arrive, walk, turn, demo, goto, postcard) and records everything — console, page errors, failed requests, world stats, screenshots. Sessions: local dev (seeded Zürich block) and the live deployment (default downtown Sitka, real tiles and Overpass). Artifacts live outside the repo in `otherhere-lab/playtest-artifacts/` (`local-zurich-*`, `live-default-*`: PNGs + a `*-session.json` per run).

## What worked (the outside view)

Both sessions were **clean**: zero `console.error`, zero page errors, zero failed requests, every loaded Cell hash-verified (`7/7`, then `10/10` after walking). The Zürich walk settled in 16.3 s (7 Cells, 3 600 Features, 12 Quests); the live Sitka default settled in 13.6 s (7 Cells, 1 525 Features, 21 Quests) and grew to 10 Cells / 2 049 Features while walking. The generator demo builds in under a second. Address goto ("Lincoln St, Sitka, AK") geocodes and loads on the live site in ~21 s. The HUD reads exactly as designed — quests, bundle verification, sketch-cell retry notes, view switch (M), time and weather ("9:41 AM · broken overcast · hold T to pass time").

## Findings

| #   | Severity                | Finding                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                    | Disposition                                                                                             |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| F1  | **major (robustness)**  | A filmed-walk import can hang forever: the frame loop's video seek waits on `onseeked` with no timeout, and the observe `fetch` has none either. Seen live in e2e: progress stopped at "Frame 5 of 6 · 1 building sharpened" and never resumed (120 s test timeout burned).                                                                                                                       | `test-results/walk-import-*/error-context.md` (pre-fix run) | **Fixed** in this round — see below                                                                     |
| F2  | minor (test strictness) | `walk.spec.ts` reload identity compares PNG bytes; in this container software-GL rasterization differs by up to **2/255 per channel** between two WebGL contexts, so byte equality fails while zero pixels differ perceptually (max channel delta 2, 0 pixels > 12/255). Bundle hashes verified on both loads — world determinism holds; the _screenshot_ assertion is stricter than the promise. | pixel-diff of `zurich-0-{a,b}.png`                          | Filed for discussion (issue #24): keep byte-identity on CI's renderer, or accept a perceptual tolerance |
| F3  | minor (environment)     | `postcard.spec.ts` and `match.spec.ts` e2e time out on this container: two full software-rendered cities inside one 120 s test; and WebRTC data channels never open between two headless contexts here (mDNS host candidates unresolvable in the container — `channel: null` while SessionDO signaling itself works). Both pass on CI runners.                                                    | `test-results/{postcard,match}-*/error-context.md`          | Not product bugs; noted for anyone playing in similar containers                                        |
| F4  | nit                     | During probes, "GPU stall due to ReadPixels" driver warnings appear under software GL — the canvas readback path (screenshots, `toDataURL`), not player-visible on real GPUs.                                                                                                                                                                                                                     | session JSONs                                               | No action                                                                                               |

## The F1 fix

`capture.ts` now bounds every wait in the walk pipeline, and the walk completes with honest notes instead of hanging:

- `seek(video, t, ms)` — a testable helper (`test/capture.test.ts`, 6 cases: settles, clamps, times out, errors, late-fire safety, handler hygiene). A seek that never settles skips its frame.
- `videoFrames(..., onSkip)` reports skipped frames; `WalkProgress.unreadable` counts them; the Done line says so: _"Done: 1 building sharpened from 6 frames (5 frames faced no building)."_
- Both observe paths (filmed-walk frames and single-photo) send `signal: AbortSignal.timeout(60_000)`.
- `e2e/walk-import.spec.ts` sets a 240 s budget for software-rendered runners (the walk is bounded now, but not fast on llvmpipe).

Post-fix, the spec that hung forever passes (2.2 m locally, all assertions including "Done: N>0").

## Probe-instrument notes (for the next round)

- The postcard flow needs the parent `<details>` open before `getByText('Save a postcard')` is clickable — the probe should open the HUD panel first (it currently records the timeout as `postcard-failed`; the product flow is fine, the e2e proves it).
- Two probes that would deepen the next round: hold **T** to pass time through a full day/night cycle while screenshotting (does the mood hold up at dusk?); and walk off the loaded ring to watch sketch-Cell retry behaviour under a flaky Overpass (simulate by dev-route seeding only some blocks).
- `window.__otherhere.sky` is exposed — the probe should capture it alongside stats to correlate atmosphere state with screenshots.
