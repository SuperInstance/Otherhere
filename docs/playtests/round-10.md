# Round 10 — the instruments, and the forest moves out of the Bundles

Two PRs: the R&D instruments the operator's dispatch asked for (#68), and Arc 0's last big item, the forest move (#69). Wild Cells went from 1.57 MB to 1,832 bytes on production.

## Played

Production (`https://otherhere.superinstance.dev`), before and after each merge, at Sitka (57.0537, −135.33), desktop 1280×800 and phone 390×844: the sketch scene probe before (`r10-before-sitka*`) and after (`r10-after-sitka*`), screenshots in `round-10/`. Health after #69's deploy: `{"ok":true,"interpreter":"0.6.0"}`, home 200 in 0.39 s.

A Jev fresh-eyes reading of the after frame (`see.mjs`, ~$0.0001): the eye lands on text/UI (0.88), the world reads as a paper model (1.00), the frame reads as settled (0.90), the top confusion is the flat-vs-true boundary (0.82 — the wake-up moment's own story), mood 6.16/10 "quiet".

## Found

- The wild hillside Cells around Sitka served megabyte Bundles of imagined trees — placed by a build with no elevation, 61% of them below the beach line across the bay, collapsed client-side after download (the forest advice's evidence, still true on production this morning).
- The two forests disagreed: the display forest planted 60% spruce, the Bundle forest 70% hemlock — two species models meeting at the loaded-Cell edge.

## Fixed

- **#68 `edge,playtest: the drift canary and the fresh-eyes reading`** — the flip watch runs itself from the Worker's cron (hourly, `jev-canary` budget key, $0.05/day cap, owner-only readings in the OpsDO); `see.mjs` reads any frame with a designed pack for a fraction of a cent. The research-instruments note records the model ladder (Jev for calibrated triage and images, DeepSeek-on-DeepInfra for adversarial review, Groq for latency-bound cron work) and the Arc 3 ideation (journeys through questions).
- **#69 `core,client: the imagined forest moves to the display layer (ADR-0017 amended)`** — `imagineForest` deleted; landcover rings and the species mix ride in the GLB extras, covered by the inputs hash by construction; the client's density callback plants by landcover (forest 1, scrub 0.35, meadow 0, wild rules elsewhere); one mix shapes the whole stand (`forestSpruceP`); the `gen:` site gate is gone with the `gen:` ranges. INTERPRETER_VERSION 0.6.0.

## Measured

- **Wild Cell Bundle, production**: 1.57 MB (measured in the forest advice, pre-move) → **1,832 B** (0 Features, 6 vertices, `interpreterVersion 0.6.0`, verified by fetching the served GLB and parsing its JSON chunk: 0 `gen:` ranges, the rainforest mix in the extras). The partially-observed Cell across the bay serves its 191 real observations at 598,296 B with 0 imagined ranges.
- Client unit tests: 109 → **110** (zones, landcover, spruce share; two `gen:`-gate tests died with the gate). Core: 131 → **123** (eight imagineForest tests died with the layer). Edge 55, models 36, agent 4, judge 4 — **332 total**.
- E2e: **17 specs pass**, including both pixel-determinism specs byte-exact (the postcard bound measured 466 differing pixels at 1/255, alpha exact — unchanged from round 09).
- Model spend this round: DeepSeek adversarial review of the diff $0.005; Jev fresh-eyes readings ~$0.0004; the canary's standing budget untouched by product paths. Total **under $0.006**.

## Next

1. **#60** — a reload's second wake overwrites the first without disposing its material (also: superseded loads still fetch; no test for re-indexing clearings after `retire`).
2. **#59** — observe provider errors should map to 502/503 in the ops route; **#61** — a malformed `--viewport` must fail loudly.
3. **#66** — crown-motion readback to pin the wind shader to its spec (Arc 1's first probe law); **#52**, **#53**, **#51** stand behind them.
