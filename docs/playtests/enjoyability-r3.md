# Play-test round 3: enjoyability — THE FUN ROUND (Lanes OH5-A/B/C)

_Three lanes played the live site for fun on 2026-10-20/21: fresh eyes (a first-time
tourist), variety (does place live in the air now?), and social adventure (postcards as
gifts + a real two-player match). Lane A owns defects; this note is about FEEL. All
artifacts in `otherhere-lab/playtest-artifacts/` (`funA-*`, `funB-*`, `funC-*`) and
`otherhere-lab/fun-lanes/`; vision reads via the VLM seat are quoted verbatim._

## The scores (evidence-grounded)

| Question                   | Score           | The evidence                                                                                                                                                                                                                             |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrival wow (Sitka)        | **7/10**        | VLM: "real-world geographic data translated into a clean, almost toy-like 3D space… a working simulation rather than just a game level"                                                                                                  |
| Beauty (intended low-poly) | **8/10**        | VLM: "think _Proteus_, _Untitled Goose Game_, _Firewatch_'s UI — this hits hard… a digital maquette come to life"                                                                                                                        |
| Exploration pull           | **strong**      | The walk grew the world 1,525 → 2,049 features / 7 → 10 cells; the amber beacon is "instant narrative tension — a place with a mystery" and the 21 quests point the camera at it                                                         |
| Place variety (air)        | **genuine**     | "A lonely, misty outpost clinging to the edge of a vast, dark wilderness" vs "a pristine, orderly alpine village basking in the golden hour sun" — "genuinely different places… clearly built in the same engine"                        |
| Postcard as a gift         | **6/10 hybrid** | The intent lands ("a preserved moment in time and space, inviting you to step into the sender's shoes") but the receive view ships the debug HUD: "like the sender sent a screenshot of their debugging console along with the postcard" |
| Match co-presence          | **2/10**        | The loop works end-to-end (code, teams, 19:30 clock, zero console errors) but the friend is invisible and unannounced: "the world feels empty"                                                                                           |

## Lane A — fresh eyes (the tourist)

Sitka and Zürich, live, walk + full-day scenes. The arrival → settle → walk arc takes
~21 s to 7 cells / 1,525 features on a cached town; the first walk beat loads three more
cells and ~500 features — **the world visibly grows as you explore it**, which reads as
reward, not loading. The full-day scene delivers night/dawn/golden/noon/dusk stills; the
dusk pin is the beauty peak (luma 119.9 grey-midday vs 149.5 clear-afternoon is the
mood axis the day rides).

The demo generator, by contrast, drops to a 26-feature world — the "Show generator
demo" button is now the weakest beat on the page: after the real town it feels like
leaving the game to visit a spec sheet. The walk-failed retries (a1/a2, recorded)
were the lane's own instrument learning SwiftShader actionability, not product bugs —
the F1 law holds.

The single illusion-breaker at arrival, unprompted: **"the flat, untextured gray plane
representing water — a perfectly uniform, matte gray void with no ripples, reflections,
or shore-line interaction."** (The ocean system has waves/foam; at this street camera
the mid-distance plane reads flat. The shoreline is where the illusion leaks.)

## Lane B — variety (does place live in the air now?)

r1's complaint: "Zürich at the same grey moment as the Alexander Archipelago — the
vision says the world is a wet Sitka day; the world answers everywhere is." The
census re-run (wind/cloud pure functions imported live from `wind.ts`/`sky.ts`,
every render-second of a day, BEFORE vs AFTER the shipped `windFloor`):

| Town            | biome              | wind exactly-still | wind < 0.05 | mean wind                  | max wind |
| --------------- | ------------------ | ------------------ | ----------- | -------------------------- | -------- |
| Sitka pre-floor | pacific-rainforest | 7.4% of day        | 17.1%       | 0.265                      | 0.698    |
| **Sitka now**   | pacific-rainforest | **0.0%**           | **0.0%**    | 0.287                      | 0.698    |
| Zürich pre      | temperate          | 0%                 | 0%          | 0.764                      | 0.997    |
| **Zürich now**  | temperate          | 0%                 | 0%          | **0.764 (byte-identical)** | 0.997    |

**The rainforest never goes dead-still any more, and the floor stays under the naming
word** (0.12 → "", 0.29 → "", 0.31 → "a breeze in the crowns"). The temperate contract
is intact to the fourth decimal. Live pixel pairs confirm the felt effect: Zürich
clear-windy moves **44.7%** of the frame — all of it in the land band (rows 331–799),
sky untouched — while Sitka midday-grey moves **29.2%** at weather-key wind 0.09–0.18
(r2's calm day was 0 pixels; the breath is real). Density does the rest of the place
character: **Sitka 24,056 trees vs Zürich 1,107 — a 22× wall-of-forest vs
open-pasture contrast** that the VLM read as "untamed and organic" vs "curated,
manicured, pastoral."

The r2 seams still behave as documented (imagined-bundle trees still don't sway at
loaded-Cell edges — the forest-architecture advice remains the open fix; pinned `?t=`
still freezes forest and sky together while the ocean keeps moving). The dawn pair
confound (63% moved across a 0.5-hour sunrise) is recorded as an instrument note:
grey-day pairs must be shot at flat-light hours.

## Lane C — social adventure (the gift and the match)

**The postcard as a gift** (Sitka dusk, `pc_8ywjb3gzyc`): the saver's loop is real —
title in, scope chosen, save on the real-click path (17.4 s + 21.4 s SwiftShader
actionability, the F1 law), link out. The recipient's loop is **fast and warm**: link
opens, the title reads in the status line — "Postcard: Dusk on Lincoln St — wish you
were walking beside me · saved 2026-10-20 · built in your browser" — the frozen hour
holds while walking (`frozenHeldWhileWalking: true`, sky byte-stable across the walk),
and the world settles in **12 s** from a cold context (cached cells). The address box
shows raw coordinates (`57.053087, -135.335063`) where a place name belongs. The VLM
verdict: a hybrid — "a preserved moment in time and space, inviting you to step into
the sender's shoes," undermined by the developer HUD around it.

**The match** (two players, one browser, code `PETG4W`): the whole loop works —
host (real click, 17 s), auto-named "Heron 11" on Red; invite link joins "Maya" on
Blue (own settle 45 s); `#match-start` starts a 19:30 countdown that ticks on both
screens; both walk; **zero console errors or page errors on either side**. Three
honest findings:

1. **Peer joins are structurally silent.** `describeEvent` handles pickup/capture/
   tag/return/end — there is no join/leave event kind, and `onWelcome` logs only your
   own join. A's log never learns Maya exists.
2. **The friend is invisible by fog, and there is no wayfinding.** Pawns render only
   when `visibleTo(me.team, …, CTF_V0.ruleset.fog)` says so; Maya spawned at the Blue
   base across the map. Two friends joining to walk together are split onto opposite
   teams by auto-balance, fog-hidden from each other, and given no compass. VLM on A's
   view: "The world feels empty… making it appear as a solitary environment."
3. **Each player carries their own sky clock.** At the same match moment A stood at
   1:57 PM and B at ~12:38 PM — same place, different moments. Defensible solo; a
   seam in a shared match.

## The round's registered fun plate (priority order)

1. **Postcard receive mode** — the smallest change with the biggest whoa: when a
   capsule link opens, hide the debug HUD (coords form, stats block, "Start a match
   here") and show the title as a card; keep the status line's first sentence. The
   gift should not ship with a debugging console taped to it.
2. **Roster awareness in matches** — join/leave events from the SessionDO through a
   new `MatchEvent` kind + `describeEvent` cases ("Maya joined Blue"), and the match
   line learns a player count. Fog stays; knowledge doesn't have to.
3. **A friend-join affordance** — first-two-joiners-on-one-team (or a non-CTF "walk
   together" mode) + a teammate beacon/compass exempt from fog. Co-presence is the
   product; the fog should hide enemies, not friends.
4. **The shoreline** — the #1 unprompted illusion-breaker at arrival: shore-line
   interaction (foam edge/ripple band) where the water plane meets the land.
5. **The place name on receive** — reverse-geocode or carry `?q=` so the box says
   "Lincoln St, Sitka, AK", not `57.053087, -135.335063`.

Riding: the flip watch (every vector read and both canaries this round served
**jev-1.13.0**; the 1.14.0 window stays open), the corpus (Sitka's vector re-read
**byte-identical** twice — the substrate is re-readable; Manaus confirms the Overpass
limit still holds >24 h — the mirror-endpoint decision is now pressing), and the
forest-architecture advice (r2 item 5, still the one-forest-one-motion fix).
