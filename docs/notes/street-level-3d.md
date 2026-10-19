# Street-level 3D: the satellite and the street, co-rendered

The operator's standing vision, in one line: _satellite and street imagery work together to build a 3D street view procedurally, the Workers store the growing assets, and feedback regenerates them sharper._ This note is the honest design for that — what we already have that points at it, what the shape of the thing is, and what a PoC that is _fun and visually working_ does next. It seeds the next several rounds; nothing here is decided unilaterally where an ADR is owed.

Where we stand today, concretely: the client walks real terrain (Terrarium elevation, ADR-0016) with optional Sentinel-2 satellite skin, OSM buildings and roads stand on it, and two forest layers grow around the walker — a display forest on the hills (`apps/client/src/forest.ts`, PR #20) and an imagined species-aware forest in the Facts (`ADR-0017`, PR #21, the 70/25/5 hemlock/spruce/cedar mix as Essence). What does not exist yet at street level: facades, storefronts, eye-level texture — anything the _street itself_ has seen. That is the gap this note is about.

## Two witnesses, one world

The satellite and the street are two witnesses of the same ground, and they disagree in informative ways:

- **Satellite is top-down truth**: footprints, canopy shape and density, terrain, landcover. It says _where_ things are and how much of the ground is forest, but a roof hides the building's sides, and canopy hides everything under it.
- **Street-level is lateral truth**: what a person standing there actually sees — facade palettes, storey counts, awnings, the species of the street trees, where the forest wall starts. It says _what things look like_, but a single frame is a poor surveyor: it sees one side of one thing from one spot.

The disagreement is the signal. Canopy hides a footprint from above → the street wins the facade; a facade hides the yard behind it → the satellite keeps the yard. Parallax between street frames resolves heights that neither witness measures directly. Co-rendering is not stitching two pictures; it is resolving both witnesses into **Facts with provenance**, which is the one thing this codebase already knows how to do (ADR-0004).

**Mapillary is the license-clean street source** (invariant 8: never Google Street View). Its imagery is CC BY-SA 4.0 with per-frame GPS and compass pose, sequenced along streets, and OSM features already carry `mapillary` tags pointing at frames that show them. `street_imagery` is already a Fact source, already ranked above `satellite_inference` (`SOURCES` in `packages/core/src/schema/fact.ts`) — the schema has been waiting for this data since M0. What we have not verified yet: how much sequence coverage Sitka itself has. That is round R32's first check, because it decides whether street-level starts from Mapillary bulk or from user captures filling Mapillary's holes — the walk-capture pipeline (`learnFromWalk`) is the same ingestion either way.

The inversion worth naming: photogrammetry reconstructs one expensive model from many images. We are doing the opposite — **cheap per-observation Facts that accumulate**. A frame that passes a shop contributes "this facade is #4a3f2f, 2 storeys, confidence 0.8, source street_imagery" and nothing more. No point cloud, no mesh, no alignment project. The Bundle rebuilds from Facts (invariant 1) and the building sharpens. This is slower per frame and infinitely cheaper per place, and every observation is auditable, cacheable, and replayable — the properties ADR-0013 bought us with question packs.

## Algorithms designed by LLMs, executed by machines

"Trees inferred on their species… algorithms designed by LLMs but then executed in webgpu or wasm or workstation runtime or cloudflare" — this is already the house pattern, generalised:

- **The question pack** (ADR-0013) is an LLM-designed algorithm whose output is constrained data: typed questions, answers with probabilities and confidence. The model never emits code; the interpreter (Ladder, router) runs everything; the pack is versioned and evaluated against a fixed judge.
- **The delegate loop** (`docs/notes/delegation.md`) is the same shape for code-shaped work: we write the spec, a cheaper model drafts, Jev triages against a literal checklist, a human adopts. `packages/models/tuning/specs/forest.task.md` is the spec that produced the current forest.
- **Street-level 3D needs new algorithms**: turn a posed frame plus its satellite tile into generator parameters (facade palette, storey count, canopy gap fraction, species mix for this block). The honest architecture is: an LLM _designs_ the measurement as a question pack over an image-plus-context state, and possibly drafts the extraction kernel against a spec we wrote; the **output is always constrained data** — species mix, facade params, palette, per-Cell Essence deltas — consumed by the trusted interpreter and the existing generators (`prop.tree` v0.2 already draws five species silhouettes from exactly such data). Invariant 3 is not a constraint on this vision; it _is_ the vision. The model is the surveyor's brain, never the surveyor's hands.

**Where each runs** (ADR-0015's plugin model, one ladder of compute):

| Tier         | Where                | What it does                                                                                              | Latency budget       |
| ------------ | -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| Per-frame    | browser, WebGPU/WASM | cheap kernels on the frame the player is looking at: colour histograms, horizon line, canopy gap counting | 5–10 ms, on the walk |
| Per-sequence | edge Worker          | Mapillary sequence digestion: one street, many frames, writes Facts with `source: street_imagery`         | seconds, background  |
| Per-town     | workstation Plugin   | batch backfills, distilled rungs, blur passes (M2's plan exactly)                                         | minutes, leased jobs |

The per-frame tier is the interesting new one: it is the same discipline as the terrain's LRU-and-budget streaming (ADR-0016), applied to _understanding_ instead of geometry — the walk digests what it sees as it goes, the way the player does. OpenSkyFlight is the speed reference for this discipline, not a feature list: it streams live terrain as fast as it can under a measured capability budget (LOD threshold, max tiles, per-tier FPS receipts from automated 5-minute flights). We want that receipts-first streaming culture pointed at digestion: every kernel gets a budget and a number.

## Growing assets, with feedback

Bundles are already content-addressed and stored in R2 keyed by their inputs hash (ADR-0007), so "the Workers store the growing assets for later" is largely built. What is new is the _ladder of sharpness_ — the same asset exists at several rungs, and each rung is a better witness:

1. **Imagined** — biome and Essence carry it (today: a wild Cell in the rainforest biome is forest until Facts say otherwise).
2. **Satellite-inferred** — canopy fraction and landcover from Sentinel-2 as `satellite_inference` Facts.
3. **Street-imagined** — Mapillary observations as `street_imagery` Facts.
4. **Captured** — the player's own photos and filmed walks, `capture` Facts, highest rank below manual edit.

"Sketch until sure" is the visual half of this ladder, and it is already the client's look: confidence drives soft-vs-crisp. Feedback to regenerate is exactly ADR-0004's rule — a later observation from a higher-ranked source replaces; we keep the latest reading per source, never the best of several, so regeneration is monotone in provenance and lazy per Cell (ADR-0014: a Town's Cells rebuild on their next request). The R2 asset for a Cell at rung 2 is not deleted when rung 3 lands; it is the cache entry a postcard without street data still builds from. Storage grows monotonically with attention, which is the operator's "growing assets" exactly.

## The learning loop runs both ways

The operator's framing: _the learning is happening by the user as they go to places, but then the system is learning what the users know._ The repo already has the vocabulary for the second half — it is the Fog-of-war memory model (`packages/core/src/schema/world.ts`), which is currently an eviction policy stub. The design move: **the Fog is not just what to keep, it is what the player knows**, and it should be derived from the same observations that sharpen the world.

Sketch of the data model, in repo vocabulary:

- A player's knowledge of a Cell is a function of their interactions with it: dwell time, captures made there, quests completed, edits, postcards saved from it. Every one of those is already an event or a Fact-source (`Salience` counts exactly these: `dwellS`, `captures`, `edits`, plus `friendActivity` and `landmark`).
- **Sharp-for-the-player** overlays sharp-in-the-world: a Cell can be fully observed by OSM+Mapillary and still be _unknown to you_; a Cell can be imagined and _known to you_ because you walked it for an hour. The first is world state, the second is player state — `(cell, ring, knownFraction)`, pinned by a `Memory` when salience crosses `MEMORY_THRESHOLD`.
- `ringFor` then stops being a stub about distance and becomes about knowledge: focus ring = the Cells you are in, recent = the Cells you have sharpened yourself, remembered = the Cells your Memories pin. "The system learns what the users know" is literally the Fog rings filling in from session events.
- Postcards are the sharing format for this (ADR-0012): a capsule that snapshots Facts _and_ the walk's pose — extend it to snapshot the sender's knowledge overlay, and a postcard says "here is what this place looked like _to me_". That is a shared memory, not a map.

This is not for many users yet (the operator's own line, and ADR-0009's single-owner reality). It is one player, one town, and the PoC question is only: _does the world visibly learn you back?_

## Exploration and social adventuring

Knowing-a-place as currency means the game verbs must all be about knowledge:

- **Quests are invitations to sharpen.** They already are: a quest is "photograph a building whose look is still imagined" (`questsFor` derives them purely from unknown attributes). Extend the same derivation to _any_ imagined attribute — a quest on a Cell whose forest is still biome-default is "go find out what actually grows on this hill", answered by one photo of the treeline. The amber beacon becomes the Fog made actionable.
- **Postcards are shared memories** — the explorable kind. A postcard from a sharp Cell teaches its recipients' worlds nothing (they have their own), but it _invites_ them: walking someone else's memory of a place you have never been is the exploration loop's social half.
- **Matches are reasons to revisit.** Capture-the-flag on a Cell both teams thought they knew, fog asymmetric with knowledge: your team's recon walk is real advantage. The match system (Sessions, P2P motion, team fog) is live; what it needs for this is per-team knowledge as the fog input, which is the same `(cell, ring, knownFraction)` overlay above.

The loop, stated plainly: explore → the place sharpens (world learning) → you get better at being there (player learning) → the system can see what you know (Fog filling) → it offers you sharper invitations (quests, postcards, matches). Fun, for a PoC, is that loop closing once.

## Where the receipts say we actually are

The street-level 3D above is rounds away. Lane A's and Lane B's R31 play-tests of the _current_ forest say the priority order for the next ones, because none of the vision reads at street level if the ground truth is broken:

- **The imagination does not know the land is water.** The two wild Cells across the bay from spawn (`891d2428b33ffff`, `891d2428b37ffff`) each imagined 167 trees; sampled against Terrarium elevation, **61.7 % and 64.1 % stand below the 2.5 m beach line** (medians 0.1 m and 0.5 m — sea level). This is structural: `imagineForest` has no elevation input, because Bundles are flat and terrain is a display layer (ADR-0016). The fix that fits the architecture is display-side: the client, which owns the terrain, applies the display forest's own beach/timber lines to imagined trees when it stands them on the ground — same rule, one coast. That ships this round.
- **The forest ended at the budget, hard.** The 26 000-instance cap planted ~34 chunks and stopped with a visible edge on the hills (Lane A's receipt). This round ships detail bands — every tree near, every 2nd to 950 m, every 4th to the horizon, with hysteresis so boundaries never flicker — the display-forest version of the terrain's coarse-tiles-stand-in trick.
- **Density reads uniform from above.** From 85 m the stands read "regular, high-frequency" (both lanes' receipts). Species tints and per-tree shade exist; what is missing is _structure_ — clearings are 12 % value-noise holes, edges are abrupt. The facts-forest edge/roadside succession mixes (ADR-0017) are the right idea at the wrong scale for the display layer; the next forest round should port them (alder on disturbed edges, salmonberry roadside strips) so the display layer agrees with what the Facts layer says succession does.
- **Snow is absent on peaks** in Lane A's receipts although PR #19 shipped mist and snow; Lane A's lane, but it belongs on the list — street-level credibility on Baranof Island starts with white ridgelines.

## PoC-now vs later

**PoC-now (the next two or three rounds, in order):**

1. This round: beach/timber-line gate for imagined trees + forest detail bands (both above), so the coast and the horizon stop lying.
2. Verify Mapillary coverage around Sitka (token, sequence counts, recency); wire `/api/tiles`-style proxied sequence fetches through the edge with attribution in the UI, the way `TERRAIN_ATTRIBUTION` does it.
3. A `street_imagery` ingestion path: one Mapillary sequence → per-frame question packs → facade/species Facts on the Cell's features → Bundle rebuild. This is the walk-capture pipeline with a different camera; `observeBuilding` is the template.
4. The knowledge overlay: `(cell, ring, knownFraction)` from session events, shown as the fog's own UI for the first time — even a simple "you have seen 12 % of this town" line makes the loop visible.
5. Quests over imagined _forest_ attributes, not just buildings.

**Later, honestly:** WebGPU per-frame extraction kernels (needs the WebGPU path proven on more devices first); Plugin batch digestion of whole towns; facade geometry from street+satellite co-observation (a generator that consumes rung-3 Facts); per-neighbourhood Essence; social knowledge merging under real scopes; anything resembling a public community.

**Never:** photorealism, planet-wide pre-generation, Google anything, or a model writing code that runs.

The whole design keeps the one property worth keeping: every step is a place that got sharper because someone looked at it. That is the product; the 3D is just how it is displayed.
