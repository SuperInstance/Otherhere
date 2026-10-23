# Round 16 — Arc 0 closes: the crown law grows a direction, the live region speaks once, five comments learn honesty

Three PRs, one per review P1, each red first and merged only on green at its head. Arc 0's P0s and P1s are now all closed; the queue moves to the P3 tooling PR (#88), then Arc 1.

## Played

Production at round open, desktop and phone (r16-open-desktop / -phone): 7/7 verified, 0 mismatched, 0 page errors, arrival 12.2 s desktop / settled phone walk 10/10. After each merge: `/api/health` ok, interpreter 0.6.1; post-round phone probe 7/7 verified, arrival 11.3 s. Evidence in `round-16/` (open-desktop-settled, crown-spruce, status-mismatch-e2e). The #91 watch reproduced on **both** probes this time — the browser closes itself mid-scene under software GL after several minutes (fifth and sixth sightings); desktop and phone.

## Found

- The #91 browser-close now strikes phone sessions too; the walk and every shot before the close stay clean.
- `cloudOf` hid a cross-file coupling (the haze inversion's constants belong to sky.ts) — fixed with a round-trip test, not just a comment.
- The sketch-count live line ("2 cells are still a sketch…") re-announces on every count change — the same class #86 fixed for mismatches; the review never flagged it. Issue opened.

## Fixed

- **#98 `client: the crown law grades signed displacement along the wind axis (review P1 #7)`** — the law extracted into `src/crown-law.ts` and strengthened: signed per-pair band on screen-u (the probe camera puts along-wind sway there, sign and all; screen-v is predicted exactly 0 by geometry and gets a flat 3.0 px mask-health bound), plus an aggregate scale (measured on predicted, 0.7..1.3). Three red unit tests first — a sign-flipped crown, a frozen crown inside the old band, a half-amplitude crown — all passed by the old magnitude-only law.
- **#99 `client: the live region says a failed hash check once, not as a counter (review P1 #8)`** — the verified/MISMATCHED counts line stays in the quiet tier; the live region carries a stable notice naming only the mismatch count. The e2e stages the real failure (one byte flipped in a served GLB), then walks to land healthy Cells.
- **#100 `docs,core,client: five wrong comments say what the code does (review P1 #9)`** — "never the wall clock" (three files), the `cloudOf` haze-inversion contract, #77's "exactly as before" (corrected in the round-13 note, PR #77's body, and a test title), the Cell-vs-Town centre derivation, the box's true reach (Stewart, Atlin, Carcross, Teslin — now pinned by a test).

## Measured

- Crown law, real shader: scale **0.984** (spruce, 49 pairs) / **0.990** (hemlock, 56); max signed u error **0.23 / 0.32 px** against a 1.2 + 0.25·pred band; v quantization max 2.33 px. The corruptions sit at −1 / 0 / 0.5 — far outside 0.7..1.3. Crown e2e ×3 green.
- Live region: red showed `"0/1 bundle hashes verified · 1 MISMATCHED"` re-announced per landing; green = one stable line through a walk that landed ≥ 2 healthy Cells (`ready` grew, `mismatched` stayed 1).
- Tests: 368 → **381** (core 135 → 136, client 133 → 145); e2e 20 → **21**, all green across the round's chunked runs.
- Adversarial self-review (rounds 14–16, two passes: broad + focused on the five riskiest hunks): DeepSeek-V3 found **no real bugs**; Jev had nothing to triage. Spend: **$0.0032**.

## Next

1. **#88** — the P3 tooling PR: fold the 12 playtest scripts into `probe.mjs --scene` flags, purge `/home/z` and workers.dev paths, write under `test-results/`, CI guard for both, and the stale-wrangler guard round 15 learned.
2. **#89** — Arc 1 opens: `probe --perf` (first view, frame p50/p95, draw calls, triangles, GPU memory, network bytes at 1280 and 390 px), `docs/metrics.md` every round, CI smoke gate; then attack the 77 s address jump and the 12–14 s first view.
3. **#90** — Arc 2: Sitka's buildings must read as Sitka from the street (check colours and contrast in screenshots), and the phone HUD must let the world come first.
