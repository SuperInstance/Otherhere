# Play-test round 1: enjoyability (Lane OH-B1)

_What a walk through the current world feels like, what would make it more fun, and the
one increment this round ships. Tested against the live site and a local dev Worker on
2026-10-19, WebGL2 backend, 1280×800 screenshots. Lane A owns defect-hunting; this note
is about FEEL._

## What exists: the generation/render pipeline in one page

```
OSM (Overpass) ─▶ Facts (source: osm) ─▶ resolve by rank/confidence ─▶ Essence per Town
                                                                            (quantized, ADR-0014)
Facts + Essence ─▶ buildBundle per Cell:                                  │
  building.basic / road.basic / prop.tree v0.2 / bench / streetlight      │
  (JSON generators → trusted interpreter → GLB, ADR-0005/0007)            │
  + imagineForest (ADR-0017): species from Facts → Essence → biome mix    │
  ─▶ content-addressed GLB in R2 ── hash pinned by golden.json ──┐        │
                                                                  ▼        │
client: World (cells ring-1, GLB, verified, stood on Terrain)   Terrain (display layer,
        confidenceMaterial ("soft until sure")                  Terrarium heightmaps,
        Forest (display-layer conifers, chunk-seeded)           topo/satellite, ADR-0016)
        Atmosphere (ONE fixed sun + fixed overcast sky)         Ocean (waves, foam,
        Arrival (establishing shot on first visit)              glint, cloud shadow, mist)
```

"Gets better as info is digested", today: capture → vision → Jev → Facts with
`source: capture` → Resolved value changes → bundle hash changes → the building
redraws crisper (Quests point the camera there). Essence sharpens the _imagined_
majority from the same digestion. All of that is real and works — but it is felt only
at building scale, only when you photograph something, and only if you were looking.

## The play-test

**Sitka (57.0531, -135.33), street level.** The establishing shot lands you from the
sky — genuinely nice — and the low-poly conifer wall with species tints reads as a
rainforest. Then you walk, and nothing about the world's _light_ ever changes. One
grey overcast moment, forever: no sun position, no time passing, no weather. The VLM
read of the screenshot: "soft and diffuse… lack of dynamic shadows or a visible sun
position makes the scene feel slightly static and 'flat'." Same verdict from 150 m up:
"a flat, uniform pale blue that feels like a 'default' background color rather than an
atmosphere… no sense of time of day." That is the single biggest source of deadness:
the most visible thing in every frame — the sky — is a constant.

**Zürich (47.3769, 8.5417).** The same wet-Sitka sky. A drier inland town at the same
grey moment as the Alexander Archipelago: place-character is in the Essence (buildings,
trees) but not in the _air_. The vision says the world is "a wet Sitka day"; the world
answers "everywhere is".

**What is alive today** (keep): waves with deep-water dispersion and sun glint;
breathing surf foam; drifting cloud shadows and mist banks on the terrain; trees that
sharpen as you walk into them; beacons that mark what the world still doesn't know;
the arrival glide. All of it is display-layer craft with no Bundle cost — the right
pattern to extend.

**Where exploration breaks down:** nothing marks the passage of time, so a 20-minute
walk has no arc. The horizon is a hard, permanent overcast line. Night does not exist;
golden hour does not exist. Screenshots of different hours of the day are identical.

## Ranked increments (impact × effort, demoable in one sitting)

1. **A living sky: the day turns.** A latitude-correct sun arc with dawn / golden hour
   / dusk / night (stars, moon), scene lights that follow, and a slow deterministic
   weather drift (clear ↔ broken ↔ overcast) with a biome prior — rainforest towns sit
   under heavier skies than temperate ones. Impact: **highest** (every frame, every
   place, instantly screenshot-able); effort: medium-low, display layer only — no
   generator, interpreter or Bundle bytes change (extends the ADR-0016 doctrine to the
   sky; reads the ADR-0014 biome the same way ADR-0017 does). **Chosen — see below.**
2. **Wind in the crowns.** A TSL vertex sway on both forests (display conifers and
   imagined trees) keyed to the same weather state: calm under overcast, travelling
   waves when clear. Impact: high wherever trees are; effort: low-medium, display layer
   only. Natural round 2 — it reuses this round's weather signal.
3. **The world wakes up.** A visible "sharpening" moment when a capture lands: the
   building breathes from paper to colour as its new Bundle stands in. Impact: makes
   the core loop _felt_; effort: medium-high (material sweep + world.ts reload hook,
   and a demo needs model keys in the dev Worker). Defer with regret.
4. **Understory: salmonberry clearings.** Berries and shrubs in forest gaps. Must go
   through the generator to honour ADR-0017 ("salmonberry a broad arching shrub that
   even carries its berries" is already specced), so it costs an interpreter/generator
   version bump and golden regeneration — or it duplicates ADR-0017 display-side and
   drifts. Design first, defer.
5. **Essence-driven atmosphere per Town, beyond the biome prior.** Sky and weather
   shaped by the Town's actual Essence (palette, wetness) once Essence rides in the
   bundle manifest. Needs an edge/manifest change; the biome prior in this round is
   its honest down payment.
6. **Background refinement made visible.** Visited Cells re-render richer as Essence
   sharpens — the "regenerated based on feedback" loop, seen. Needs edge policy work
   (which Cells rebuild, when); defer.

## Shipped in this round: the day turns

`apps/client/src/sky.ts` (pure, unit-tested) + rewiring of `atmosphere.ts`,
`ocean.ts`, `terrain.ts`, `main.ts`:

- **Solar geometry.** Sun direction from latitude, day of year, and hour (declination
  - hour angle), in the local east-up-south frame. Deterministic pure function.
- **A day clock** driven by _elapsed render time_, not the wall clock: every visit
  starts at 09:30 local and a full day passes in 24 minutes (1 game hour / minute).
  This is the same determinism class as the waves, foam and cloud drift that already
  pass the pixel-identical reload e2e: same elapsed time → same sky, on every device.
  Hold **T** to fast-forward the clock; `?t=21.5` pins **and freezes** the hour (a
  director's cut for screenshots and tests).
- **A postcard freezes the moment.** Saving one pins the current hour into its link
  (`…&t=14.37`), and opening any capsule freezes the day clock for that view — a
  capsule is a Memory in CONTEXT.md's vocabulary, kept at full fidelity forever, so
  whoever opens it a year later sees the sky it was saved under, not whatever hour
  they arrived at. Everything outside a capsule keeps living.
- **Palette by sun elevation** through keyframes (night → dawn → golden → day), with
  the legacy wet-Sitka look preserved as the _overcast midday_ case so the world's
  character survives. Scene lights (directional sun → moon at night, hemisphere)
  follow on the CPU; ocean glint, fog warmth and cloud shadows read the same shared
  sun/weather uniforms.
- **Weather drift.** Smooth value noise over time picks cloud cover between 0.15 and
  0.95 with a biome prior (`forestBiome` from core — the same box ADR-0017 uses):
  Sitka lingers overcast and misty; Zürich gets broken sun. Overcast flattens the
  cloud-shadow contrast, thickens the haze, pools the mist and swallows the sun disc;
  clear skies bring it back with a hard glint on the channel.
- **Night exists**: a hashed star field and a moon disc fade in below the sun line,
  moonlight takes over the directional light, the status line reads the time of day
  ("14:37 · overcast thinning").

No generator, interpreter, Bundle or golden changes: `pnpm lint`, `typecheck`, `test`
green. One honest caveat on the pixel-identical e2e: a living sky means the two
screenshots of a reload (or a postcard's save and open) are taken at slightly
different clock readings, so byte-identity now also depends on the two moments
landing in the same palette/light state — and CI confirmed it: the two
pixel-identity specs failed there on the first push (everything else green). The
chosen fix: **a pinned `?t=21.5` freezes the clock** (a director's cut — the same
sky for a screenshot, a test, or a postcard link), and both pixel-identity specs
now pin their hour. Result, measured on CI: the reload pair is **bit-exact
(zero pixels differ)**, and the postcard pair — two independent browser
contexts — differs in **172 of 1,024,000 pixels, every one exactly 1/255**,
scattered through the fog band: two GPU contexts rounding the fog gradient's
transcendentals one ulp apart, a place main's fog never surfaced because the
weather-driven haze rescale moved the gradient into view. So the walk spec keeps
`Buffer.equals` (same context, bit-exact — the doctrine holds where it is
achievable) and the postcard's cross-context compare allows at most 1/255 per
channel (`e2e/identical.ts`, the measurement in the comment; validated on the CI
evidence itself — a different scene fails at max 197). The reload e2e was also
re-run on clean main in the same container and fails there too, by at most
2/255 per channel — that container's software-GL signature, not the sky (see
`docs/playtests/functionality-r1.md` F2). CI is green on the final push.

## Next round

Wind in the crowns (item 2) — it consumes the weather state shipped here, costs no
Bundle bytes, and moves the single largest surface (the forest) that today stands
perfectly still. After that, item 3 (the visible sharpening moment) is the one that
makes the project's thesis _felt_ rather than told.
