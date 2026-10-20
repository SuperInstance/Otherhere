# Functionality play-test, round 3 — F1 laid to rest, the world wakes up, and the corpus learns patience

Round 3 ran three lanes against main `267dbc0` (which already carried Claude Code's two
debugging PRs — the biome-aware forest density and the typed-address retention, both
examined and kept). The round's registered plate came from the r2 close: F1 first, the
wake-up moment, the wind band decision, the place-vector corpus.

## F1: the live postcard click, closed by measurement

The r2 finding was "the Save button resolves but the click never lands (30 s)". The r3
instrument (`playtest/f1-postcard.mjs`) sampled the button every 200 ms from inside the
page while the click was in flight, capturing its bounding box, the hit target at the
click point, computed styles, the details state, and the page's frame rate.

**The verdict: an instrument artifact, not a product bug.**

| measurement | at rest (8 s) | during click (19.6 s) |
| --- | --- | --- |
| unique bounding boxes | **1** | **1** — the button never moved |
| hit target at centre | button, 9/9 | button, 8/8 — nothing intercepts |
| style / enabled / open / focus | all normal | all normal |
| page frame rate | **1.05 fps** | **1.19 fps** |

Under SwiftShader the render loop saturates the main thread at ~1 fps, and Playwright's
actionability checks ride `requestAnimationFrame` — each check step queues behind
~1-second frames. The click landed at **19.6 s** (45 s budget). Round 2's 30 s budget was
~10 s too short. The full loop then worked end to end on live: link saved, opened in a
second context, hour pinned **exactly** (9.60 in the link = 9.60 in the sky), capsule
line shown, world rebuilt.

The probe inherits the law: `clickHud()` gives HUD clicks a 60 s budget with a DOM-click
fallback (which path landed is always logged), and `--scenes` runs several scenes with
record-and-continue — F3's "a scene that dies must not take the session with it".

**The validation run** (live, full postcard scene, hardened probe): dusk travel, save
click on the **real** path at **25.6 s**, link `pc_c74y2xjj9y&t=21.73` opened and settled
in 11.9 s, `hourMatches: true`, `frozenAtPinnedHour: true`, 7 cells / 1,525 features
verified 7/7. The saver-vs-friend pixel compare (876,712 px) is the honest sky of two
different hours (the saver had walked to 23.95, the postcard holds 21.73) — the
determinism proof remains r2's same-hour pair.

## Lane B: the world wakes up (enjoyability r1 item 3, the thesis made felt)

When a genuinely replaced Bundle stands in — a capture landing, OpenStreetMap arriving
for a sketch Cell — the world now **breathes from paper to its true state over 1.6 s**.
The material's own paper vocabulary does the work: a per-cell wake uniform sweeps the
same mix the confidence attribute already uses, from full paper (the sketch look) to the
settled formula, ease-out cubic so the sharpening reads as one gesture.

Three laws keep it honest:

- **The stale manifest rides along** — a same-hash reload (a sketch retry that changed
  nothing) stays still; a pulsing paper town would be noise. Unit-tested: a no-op retry
  wakes 0, a changed lot wakes 1 and breathes out at `WAKE_MS`.
- **A first-ever load does not wake** — the arrival glide already covers first
  impressions; the wake marks *new knowledge replacing old*, nothing else.
- **The status line names it**: "Something here just sharpened: the new knowledge is
  settling in." — a player who looks away and back finds the HUD accounting for what
  they felt.

Display layer only: same geometry, same Bundle bytes, no generator or golden-hash
change (the ADR-0016 doctrine, extended the way the wind extended it).

## Lane B: the biome-band wind decision (census-informed)

The r2 day census measured Sitka's crowns still **96.6% of the day** under
calm-under-overcast — the wind lives in temperate towns. But an ocean stand never truly
rests: the pacific rainforest biome now carries `windFloor: 0.12`, a breath under grey
sky that sits **below** the status line's 'a breeze' word (0.3) — felt, not named.
Temperate overcast stays exactly still (the r2 still-air contract, unchanged, tested).
The floor rides under the weather key, so clear-sky gales blow exactly as hard as
before. The walker's own position decides the band, per frame, one unproject and one
box test.

## Lane C: the corpus learns patience (the invisible lane's scale finding)

The place-vector corpus pass visited eight diverse towns (Sitka, Zurich, Reykjavik,
Honolulu, Manaus, Tromsø, San Francisco, Vienna) through the public routes. Two laws
landed:

- **The empty-state attractor**: a vector asked while the block is still loading reads
  the empty profile — all claims at the floor, `known_in_detail: 0.00` — and six towns
  landed there, mutually near-identical (cosine 0.99+). The r2 decoy-floor finding, now
  at corpus scale: **an empty town is its own place**, and every town in it looks the
  same. Vectors must be read *after* the block settles (pass 2's settle-then-ask flow).
- **The Overpass pacing law**: eight city-scale visits in rapid succession trip the
  public endpoint's rate limits — two towns failed outright, the rest stuck loading for
  half an hour, and retries keep failing while the limit holds. The corpus at scale
  needs serial visits with spacing (or a mirror endpoint). The two settled towns carry
  real, distinct vectors — Sitka `rainy_coast 0.66 / mostly_conifers 0.21`, Zurich
  `warm_earthy_walls 0.71 / height_scale 4.94`, cosine 0.903 — the retrieval substrate
  exists once the pacing law is obeyed.

The flip watch rode every vector read and both canaries: **jev-1.13.0 still served** at
every call this round (canary answer 0.92, within the sealed band). The moment
`model_served` reports 1.14.0, the drift monitor's once-in-a-version reading fires.

## Round 4 plate (priority order)

1. **The wake probe** — a sketch-cell scene that screenshots the breath itself
   (t0 + 0.3 s / 0.8 s / 1.6 s after the mid-session seed lands), so the wake-up moment
   carries picture evidence like the wind does.
2. **The corpus at pace** — serial town visits with spacing, settle-then-ask, the
   retrieval matrix over rich vectors only; the "level assist as journeys through
   questions" substrate.
3. **The flip reading** — the moment the canary reports 1.14.0 (the Oct-21 window is
   open; every call is receipted).
4. **The forest-architecture advice** (r2 item 5, still open) — imagined trees out of
   Bundles into the display layer, ending the sway boundary and the bundle bloat at
   once; Claude Code's density fix makes the transition safer than it was.
5. Probe hardening II: the wake scene joins `--scenes`, and the day scene's settle
   timeout gets the record-and-continue treatment everywhere.
