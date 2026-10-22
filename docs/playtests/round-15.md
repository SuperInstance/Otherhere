# Round 15 — P1s 4–6: the region learns its place, the postcard goes byte-exact, the sines stay small

Three PRs, one per review P1, each merged only on green and verified in production after its deploy. Arc 0 continues: three P1s remain (#85 crown direction, #86 the live region, #87 the comments), then the P3 tooling PR.

## Played

Production after each merge (the round's queue came from the review and round 14's next list; no fresh pre-change walk — honest note, as last round). After #94 and #95: `/api/health` `{"ok":true,"interpreter":"0.6.1"}`, and the post-merge probe (`r15-post-p15`) settled 7/7 verified, 0 mismatched, 0 page errors. The #91 watch reproduced a third time: the browser closes itself mid-walk under software GL after several minutes — the walk and screenshots before it are clean. Evidence in the probe artifacts.

## Found

- **The stale-webServer trap**: `reuseExistingServer: true` let the e2e run against a wrangler still serving the _pre-fix_ client build — the first run of the postcard fix "didn't work" because it tested old code. Killed the stale server and the fix passed first try. A guard belongs in the P3 tooling PR (#88).
- The positive modulo `((x % P) + P) % P` can move an out-of-range feed by an ulp — caught by demanding exact (`toBe`) equality in the phase test rather than a tolerance.
- #91 reproduced (third time this session, desktop only so far).

## Fixed

- **#94 `core: the region's roof weights speak only where the generic rule imagines (review P1 #4)`** — the region branch of `building.basic`'s roof chain ran before the house/small-`yes` rule, so a 3,000 m² cannery in Southeast Alaska drew a gable 8 times in 9. The region's weights are now gated on the same footprint predicate the generic rule uses: a region changes the weights of imagining, never which buildings get imagined. `building.basic` 0.3.0 → 0.3.1, golden re-pinned (vertexCount 3701 unchanged).
- **#95 `client: the postcard's centre carries the saver's sky, so the pair is byte-exact (review P1 #5)`** — root cause found, not a re-measured tolerance: the differing pixels were all forest crown edges (the sky band was clean — the old comment blamed the fog); a bisect showed two fresh contexts of the same pinned URL render byte-exact; the real difference was the recipient's sky latitude — the capsule's centre (the walker's unprojected position, rounded to 1e-6°) vs the saver's typed place, a few 1e-4° apart, moving the sun enough to relight crown edges one quantization step. The centre now carries the saver's `skyAt` verbatim; the bound tightened from `1/255 in 496 pixels` to `0/0`.
- **#96 `client: per-term wrapped phases for every wind and scene sine (review P1 #6)`** — every sine reads its own phase uniform, wrapped mod TAU in float64 on the CPU (the forest's five wind terms; the scene's twinkle, four ocean waves, foam and two streaks — the omegas are irrational, so no common wrap period exists; per-term phases are the only exact answer). The crown instrument survived unchanged: all three crown laws green. A source-scan test keeps the raw-clock sines from coming back.

## Measured

- P1 #4: in-region large buildings pitched **0.875** on main → **≤ 0.4** after (40 buildings each side); small-building region character re-asserted ≥ 0.75 in the same test.
- P1 #5: **465** differing pixels (every one a crown edge, ±1/255, deterministic to the pixel) → **byte-exact, 101,437 bytes, three consecutive runs**; the pair's e2e is now a byte-exactness law like the walk spec's.
- P1 #6: five red tests on main (`Cannot read properties of undefined (reading 'swell')`) → green; crown e2e ×3 green (spruce, hemlock, pinned stand); walk e2e ×6 green including the strengthened #50 check (five phases in `[0, TAU)` while the day turns).
- Tests: 362 → **368** (core 134 → 135, client 128 → 133); e2e 20/20 green across the round's runs. Model spend: **$0**.

## Next

1. **#85** — the crown law compares signed displacement along the wind axis (red: a sign-flipped crown must fail), and then the instrument is finished: no more wind rounds (the review is explicit).
2. **#86** — the `aria-live` region announces a mismatch once, not on every Cell that lands.
3. **#87** — the five wrong comments (sky wall-clock, `cloudOf` haze inversion, the #77 claim, the derived-region centre, the Alaska–BC box).
