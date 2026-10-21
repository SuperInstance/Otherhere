# Round 09 — the scene's one clock, the seal made real, the wind that wraps

Three Arc 0 items closed: the settle race (#40, #48), the place-vector seal (#49), the wind clock (#50). The pixel-identity doctrine is byte-exact again, by measurement.

## Played

Production (`https://otherhere.superinstance.dev`), before and after each merge:

- the determinism probe at the pinned Zürich hour, two fresh contexts: **byte-equal** (`skyEqual`, `png.byteEqual`, both `true` — the r8 scoreboard's failing family, closed);
- the walk probe at desktop 1280×800 and phone 390×844 after the round's merges: 7/7 verified, 0 mismatched, settle 11.8 s / 10.1 s; health `{"ok":true,"interpreter":"0.5.0"}`, home 200.

## Found

The round-06 pixel failures had two causes, found by measurement, not suspicion:

1. **An un-freezable clock.** A same-load A/A2 compare (two shots of one settled load, 3 s apart, hour pinned) differed in 49.4% of pixels — something still moved under `?t=`. Jev read the amplified diff (water_surface 0.74, horizon band): the ocean's waves, surf streaks and foam drift, the terrain's cloud shadows and mist banks, and the star twinkle all rode TSL's renderer `time`, which `?t=` cannot freeze. The reload diff was the same animation at two phases.
2. **The true settle race.** After the clock fix the reload diff fell to 0.70% and the same-load diff to 2,506 pixels: elevation tiles still decoding re-stand distant buildings (`loading: 137` at the old settle point), and the forest plants two chunks a frame.

An environment surprise worth recording: the e2e dev server serves **real** elevation tiles from wrangler's on-disk Cache API state (`.wrangler/state/v3`, 46 MB from earlier sessions), even with the closed-port vars — so the container's e2e runs the terrain path while CI's cold cache runs the paper world. Both are now deterministic.

## Fixed

- **#63 `client: one freezable scene clock for everything that moves`** — `atmosphere.sceneTimeU`, fed from the sky's freezable elapsed inside `updateSky`; ocean, cloud shadows, mist and stars read it. `Forest.settled()` (nothing left to plant, or budget spent — both stable), exposed beside the terrain's in-flight count; spec settle gates wait for cells, wakes, tiles and forest. The walk spec asserts the law itself (same load, +3 s, byte-exact) and keeps `after.equals(before)`. The postcard bound is measured and pinned: **496 of 1,024,000 pixels, every one 1/255, alpha exact** on CI (466 twice in the container, 172 pre-fix on CI); `expectIdentical` takes a pixel cap, checks alpha, logs its measurement.
- **#64 `core,edge: seal the place battery into the vector cache key`** — `PLACE_BATTERY_SHA`, the sha of the pack's canonical JSON (sorted keys, no whitespace): formatting is free, any change to what the battery asks changes the seal. Stored vectors carry the seal; a mismatch re-asks; seal-less records fail the schema and recompute.
- **#65 `client: the wind's clock wraps on a whole-cycle period`** — `WIND_PERIOD = 11200 s`; every GPU-side rate is whole cycles per it (constants moved ≤0.13%), the breath lattice divides it, the whole field is exactly periodic, `setWind` wraps with positive modulo. `forest.wind()` reads the uniforms back; e2e asserts pinned = 0 and live = advancing.

Each PR: the failing spec or the missing law documented red before, green after; every check green on the head commit; main merged in between merges. Adversarial review before each merge (DeepSeek-V4.1-Flash on DeepInfra, ~$0.001 each): the real findings (negative modulo; CI's 496-pixel measurement) fixed, the false ones disproven against the code and noted in the PR bodies.

## Measured

- Client unit tests: **104 → 109** (forest settled, wind wrap ×4). Full suite: **335** (core 131, client 109, edge 52, models 36, agent 4, judge 4).
- E2e: **16 specs pass** (the walk determinism spec green for the first time since round 06; the new live-wind spec, 19 s). The pixel specs cost ~5.5–6.4 m each under software GL — the full display settle is ~150 s per load (documented in per-test timeouts).
- The pre-fix diffs, for the record: same-load 49.4% of pixels (max 202/255, rows 283–407); reload 0.70% after the clock fix, 0 after the settle gates. Post-fix: byte-exact, twice, and byte-equal across two fresh production contexts.
- Model spend this round: Jev layer-naming 2 calls (~$0.0002), canaries 2 (~$0.00003), DeepSeek reviews 3 ($0.0026). Total **under $0.003**.

## Next

1. **The forest move** (Arc 0's last big item) — imagined trees out of Bundles into the display forest, wild Cell bundles from 1.57 MB toward <50 KB. The density callback and `settled()` are already in place.
2. **#59** — observe provider errors → 502/503 in the ops route.
3. **#60** — a reload's second wake leaks its material; **#61** — probe `--viewport` fails loudly; **#52** and **#55** stand; **#66** (crown-motion readback) is registered for the Arc 1 probe.
