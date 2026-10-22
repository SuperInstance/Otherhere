# Round 13 — the crown readback, and Southeast Alaska imagines its own buildings

Two build PRs, one for each arc the round opened with: **#66** closed — the wind shader is now pinned to its spec by a render-level law, Arc 1's first probe instrument. And the roadmap's first ask landed: imagined buildings take their region's character, so Sitka's unknown `yes` footprints stop coming out as flat white boxes. (Round 12 was the R&D round — the retrieval matrix and the fresh-eyes corpus — recorded in `research-instruments.md`, not a playtest note; this note picks the numbering back up.)

## Played

Production before any change: the walk scene at desktop (partial: arrival, four walk legs, demo lot, Lincoln St, a postcard saved — 0 page errors, 0 console errors, 0 failed requests) and the full phone walk (`r13-phone*`, 0 errors; the known #52 starvation reproduced again: HUD clicks fall to the DOM fallback at 30 s, the postcard title fill times out under software GL). Health `{"ok":true,"interpreter":"0.6.0"}`. After the round's merges: the crown law verified against deployed bytes (`r13-crown-deployed*`, evidence in `round-13/`), and Sitka's arrival re-shot.

## Found

- A render-level crown check could not exist in a real scene: cloud shadows, mist and sky ride the same freezable clock as the crowns (round 09 measured 65–70 % of pixels moving at 2.5 s), and in e2e the closed tile ports mean no forest plants at all.
- The height Fact is the building's *total* — ridge included — so a mesh's `maxY` cannot tell a flat roof from a pitched one; the top level's vertex count and the roof-base level can. (Found while writing the region tests; the detector is documented there.)
- #52 stands (phone HUD input starvation); nothing new beyond it.

## Fixed

- **#76 `client: the crown-motion readback pins the wind shader to its spec (#66)`** — `?demo=forest`, a client-only test stand: the real `Forest` plants the real lattice, `Forest.nearest` picks a witness, an isolation replant leaves it alone in a flat void. Per frame a 256×256 target aimed at the witness apex is read back inside the same animation frame the wind uniforms were written for; `crown-readback.ts` tracks the apex; the law (e2e `crown.spec.ts` + the probe's `--scene crown`) grades measured displacement against `swayOffset`'s prediction over 0.5 s baselines, within `1.0 + 0.2·pred` px. Row order calibrated, background sampled, shimmer excluded by the mask threshold. `?t=` pins the stand — the negative control reads still.
- **#77 `core: Southeast Alaska imagines its own buildings (regional prior)`** — `building.basic` 0.3.0: a small `yes` footprint (under 250 m²) draws gable 5 / hip 3 / shed 1 / flat 1. A regional prior in Essence (`essence/region.ts`, the building half of what biome is to the forest): steep pitches, metal roofs, painted wood siding, from a coarse Southeast Alaska box, only where no Fact and no Town sample speaks. The roof chain is now Fact → Town samples → region → generic; unregioned towns render exactly as before (same draws, same bytes apart from the generator version). Golden re-pinned.

## Measured

- Red before → green after, both PRs: dropping `windTimeU` from the flutter term fails the crown law on 71 of 89 pairs; stalling `setWind` freezes the clock at 0 and yields 0 qualifying pairs; restored, 85–93 pairs with max error 1.19–1.26 px. The small-yes rule: 9 of 40 pitched on main → 35 of 40 after.
- The crown law on production: 25 pairs, 0 outside the band, max error 0.52 px.
- Tests: core 123 → **133**, client 113 → **127** (360 total). E2e 17 → **20** specs (spruce law, hemlock law, pinned stand). Wild Cell bundles unchanged; the golden's vertexCount 3701.
- First view (probe walk, settle to 7 Cells, software GL): desktop 12.7 s, phone 12.1 s. Model spend: **$0**.

## Next

1. **#53** — a postcard as a match arena (`?c=`/`?s=` mutual exclusion): the BRIEF's "every postcard should be playable as an arena" needs a small ADR plus the URL change.
2. **#52** — the phone HUD input starvation: give the probe/e2e phone flows explicit budgets or a DOM fallback for typed input, the way `clickHud` has one for clicks.
3. **#51** — the frozen-clock instrument for the pinned-hour postcard, plus the flip reading (the drift watch stays armed for `model_served` 1.14.0).
