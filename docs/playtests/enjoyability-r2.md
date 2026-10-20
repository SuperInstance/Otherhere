# Play-test round 2: enjoyability — wind in the crowns

_Lane OH-B2. What shipped, what it looks like, and what the instruments honestly
measured. Tested on the dev Worker (Sitka street level, Zürich street level),
WebGL2 software rendering, 1280×800. Lane A owns defects; this note is about
FEEL. Round 1 (`enjoyability-r1.md`) ranked this increment #2 behind the living
sky, which has since merged: "it consumes the weather state shipped here, costs
no Bundle bytes, and moves the single largest surface (the forest) that today
stands perfectly still."_

## What shipped

`apps/client/src/wind.ts` (pure, unit-tested) + the wind in `forest.ts`'s shared
conifer material + the clock wiring in `main.ts`:

- **A two-tier motion model.** A travelling gust _envelope_ (a 130 m swell at
  9 m/s and a 55 m chop at 6 m/s, incommensurate so the field never tiles) rides
  under a crown _flutter_ at 4.0 rad/s — a real conifer's period — with a faster
  crosswise shiver and a lean direction that itself wanders ±0.25 rad. Crowns
  swing about a downwind lean inside passing gusts; they do not nod in unison
  (the flutter's phase is two long rotated sines over the ground, so stands a
  few trees apart are out of phase while one crown moves as a single thing).
- **Species flex, baked per vertex.** Spruce tiers are stiff (flex ∝ t^1.8 ×
  0.72); the hemlock's crown bends more and its leader whips (extra term above
  75% height). One shared material sways both silhouettes.
- **Weather-keyed, the way the sky drifted.** Still air under overcast — a grey
  ceiling sits on the forest and nothing moves; wind under clear sky; broken sky
  between. The wind also _breathes_ (a 16 s value-noise cycle), so even a clear
  sky rests the crowns between gusts. The strength thresholds line up with
  `describeWeather`'s bands, and the status line says so in the house voice:
  _"9:34 AM · clear, a breeze in the crowns · hold T to pass time."_
- **The shimmer.** Crowns catch light as they swing: a ±7% brightness ripple in
  the flutter's phase, computed per vertex, carried to fragments. Up close the
  bend carries the read; at distance, where the bend is sub-pixel, cohorts of
  crowns brightening as a gust crosses them are what makes the wave visible
  running through a hillside. The bend fades with range (`SWAY_FADE_M`); the
  shimmer does not.
- **Determinism, the day-clock class.** The wind reads the same freezable clock
  as the day: `Forest.setWind(skyElapsed, cloud)` each frame, never the wall
  clock, never `Math.random`. A pinned `?t=` (or a postcard link) freezes the
  forest mid-sway, exactly as it stood when the moment was saved. Overcast
  collapses the whole thing to `positionLocal + 0` — the forest we had before,
  vertex for vertex. Display layer only: no Bundle byte, generator, interpreter
  or golden change (ADR-0016's doctrine, extended to motion).

## A shading fix that rode along

`coniferMaterial`'s depth gradient ("darker toward the base so a stand has depth
instead of reading as a flat wall") keyed on `positionLocal.y` with unit-tree
thresholds — but `positionLocal` reaches the fragment stage already
instance-transformed into world metres, so the gradient had silently flattened
to a constant on every real hillside. It now keys on `positionGeometry.y`, the
pre-transform unit-tree height (the documented read for exactly this case), and
the base-darkening is back. Two of us found this independently in the same
round; the fix restores what the comment always claimed.

## What the instruments measured

Software GL cannot show motion at 60 fps, so the evidence is pairs of stills
from a pinned camera, a full-day census of the pure functions, and extracted
video frames. All artifacts in `otherhere-lab/playtest-artifacts/`
(`sitka-street-*`, `zurich-street-*`, `zurich-video-*`, `sway-t*.png`;
`playtest/wind-shots.mjs`, `wind-shoot.mjs`, `wind-diff.mjs`).

| Pair (same camera, same weather) | wind  | pixels moved       | max Δ   |
| -------------------------------- | ----- | ------------------ | ------- |
| Sitka street, calm overcast      | 0.000 | **0** of 1,024,000 | 1/255   |
| Sitka street, broken sky         | 0.455 | 109                | 114/255 |
| Zürich street, clear             | 0.912 | 5,944              | 167/255 |
| Zürich street, 12 s apart        | ~0.58 | 29,336–537,286     | 230/255 |

The calm contract holds _exactly_ (zero pixels differ — still air is still).
The wind pair diffs live in the forest band (rows 373–516 at street level). A
vision model reading consecutive video frames (`sway-t11`/`sway-t13`) confirms
the read: "tops of these trees have swayed slightly… changing the jagged edge
where they meet the sky… gaps between the central trees appear different."

**The census finding** (wind + cloud pure functions sampled every game-second
of a day): _the wind lives in the temperate towns._ Zürich's clear-weighted
band reaches strength 1.00 with 70% of daytime above 0.6; Sitka's
rainforest-weighted band tops out at **0.557** with 3.4% of the day above 0.5 —
the same overcast that makes the rainforest town moody holds its forest nearly
still. That is the design as specified (calm under overcast), now measured; if
Sitka's fantasy wants wind off the Pacific on grey days, that is a biome-band
decision, not a bug.

## Honest caveats

- **The boundary with the imagined forest.** Bundles still bake imagined trees
  in wild Cells (ADR-0017 as merged; the forest-architecture advice to move
  them into the display layer is unshipped). Those trees do not sway — the
  display forest does — so the wind stops at the edge of the loaded Cells. One
  forest, one motion, remains the argument for taking that advice.
- **Frozen wind under a pinned hour.** A pinned `?t=` freezes the forest with
  the sky (a Memory keeps its moment). The ocean's waves — driven by three's
  render time — keep moving under the same pin. Each system is individually
  defensible; together they are one seam away from inconsistent.
- **Still-frame subtlety.** At moderate breeze the pair diff is 0.01% of the
  frame; a vision model reading the pair as "identical" is not wrong at that
  strength. The wind is built for continuous motion at real frame rates; the
  video frames (not still pairs) are where it becomes unambiguous at breeze
  strength.
- Software GL renders 0.5–3 fps, so the 25 fps video is stop-motion: phases are
  sampled, not continuous. On real GPUs the flutter is smooth by construction.

## Next round

Round 1's item 3 remains the one that makes the project's thesis _felt_ rather
than told: **the world wakes up** — a visible sharpening moment when a capture
lands, the building breathing from paper to colour as its new Bundle stands in.
The census finding suggests its sibling: a biome-band pass on the wind (does
the rainforest fantasy want grey-day wind?) is one constant away from being
testable in play.
