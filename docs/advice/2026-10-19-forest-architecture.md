# Advice: where the forest should live

_Review of #21 (ADR-0017) and #23, both merged. Written for whoever works on the forest next._

## Summary

Keep #21's **data model** and move its **drawing**. Species and landcover as Facts, and the forest mix in the Town's Essence, are the right design and fit ADR-0014. Baking hundreds of imagined trees into every Bundle is the wrong layer:

- it makes Bundles ~1,000× bigger;
- it places trees without knowing where the ground is;
- it rebuilds whole Cells for tiny changes;
- it gives the client two forests to keep consistent.

The client's display forest (`apps/client/src/forest.ts`) already draws trees cheaply and on real ground. Let it draw the imagined trees too, reading #21's Facts and Essence. Bundles keep only **observed** trees.

Three blocking review items from #21 were not fixed before it merged. One is a live bug in moderation. They are listed under "Fix now".

## Evidence

Measured on `main` (`buildBundle` for a res-9 Cell with no Facts):

| Cell                         | Features | Vertices | Bundle size |
| ---------------------------- | -------- | -------- | ----------- |
| Wild hillside north of Sitka | 167      | 33,865   | 1.57 MB     |
| Before #21 (same Cell)       | 0        | ~7       | < 1 KB      |

- The client loads 7–19 Cells around the walker. In a wild area that is roughly 10–30 MB of GLB for trees alone, downloaded, hashed and parsed on every visit, and stored in R2 for every Cell anyone walks past.
- Each tree is ~200 vertices merged into the Cell's one mesh, with no instancing and no level of detail.
- #23 found that the build, which has no elevation, put **61% of the imagined trees in two Cells across the bay below the beach line**. The fix collapses them in the client after download. They are still built, stored, sent and hashed.
- The display forest draws ~50 triangles per tree, instanced: one draw call per species per 250 m chunk, nothing downloaded, and placed against real terrain height and slope from the start.

## Why the display layer is the right home for imagined trees

1. **Elevation lives in the client** (ADR-0016). Where a tree can grow depends on height, slope and shoreline. The server can't know any of these without fetching elevation, and that would put non-Fact public data into Bundle inputs.
2. **Imagined trees carry no information.** They are a deterministic function of (Cell, landcover, Essence). That function can run on the client as well as the server, and it costs nothing to send.
3. **Invariant 1 is untouched either way.** Nothing imagined is stored as a Fact. The difference is only whether the imagined result is cached as bytes (Bundle) or recomputed (display).
4. **Churn.** In a Bundle, every input change (one new OSM tree, a moved road, an Essence step) rebuilds the Cell. `imagineForest`'s list-position thinning (`stride`) makes this worse: one new candidate shifts every tree in the Cell. In the display layer a replant is local and free.
5. **One forest, one look.** Today the two systems have separate species models, densities and constants, and they meet visibly at the edge of the loaded Cells. #23 shares only the beach and timber lines.

## Recommended design

- **Bundles**: observed trees only (`natural=tree` nodes with their `species` and `height` Facts), drawn by `prop.tree` as now. Landcover polygons stay Facts and are not drawn.
- **Data for the display forest**: a small, cacheable endpoint, e.g. `GET /api/cells/:cell/vegetation`, returning:
  - the Town's `Essence.forest` mix and `biome`;
  - the Cell's landcover rings (forest, scrub, meadow) in the Cell's local frame;
  - the positions of observed trees.

  Kilobytes, not megabytes.

- **Display forest** (`forest.ts`):
  - **species** per tree from the Essence mix, falling back to the biome mix;
  - **density** from landcover: full in forest, alder and salmonberry in scrub, none in meadow, and the wild fill elsewhere in a wild biome;
  - **clearance** around observed trees and around buildings and roads (`World.occupied` already does the last two);
  - **placement** against real terrain, as now;
  - **silhouettes**: the species shapes #21 built (hemlock leader, spruce tiers, cedar skirt, alder clumps, salmonberry) become instanced low-poly geometries.
- **Determinism**: the display forest is seeded per chunk, so every device draws the same forest from the same Facts. It doesn't need byte-identical output, because nothing hashes it.
- **ADR**: amend ADR-0017 to say imagined trees are drawn by the display forest, from Facts and Essence, and never baked into Bundles. Bump `INTERPRETER_VERSION` when `imagineForest` leaves the build, so every Cell rebuilds without its imagined trees.

## Fix now (from the #21 review; still on `main`)

1. **Moderation leaves a stale Essence (live bug).** `TownDO.removeFacts` deletes `key = 'essence'` (`apps/edge/src/town.ts:178`), but the Essence is stored as `'essence:2'`. Use `key LIKE 'essence%'`, as `write()` does at `:99`, and add a test that removes a Fact and checks that the Essence changes.
2. **List-position thinning** (`forest/imagine.ts:159`): one new candidate moves every imagined tree. Thin by identity, i.e. a hash of the zone key and grid indices. This becomes moot if imagined trees move to the client.
3. **Inconsistent defaults without Essence**: `imagineForest` falls back to `forestBiome(cell)` (rainforest around Sitka) while `essenceParams(undefined)` has no biome (temperate). Compute one default and use it in both places.
4. **`Math.hypot(...) < TREE_CLEARANCE_M`** (`:151`) feeds Bundle bytes. Compare squared distances.
5. **One meadow suppresses the whole wild fill** (`hasLandcover`, `:88`), and the wild zone's edge band draws the Cell hexagon in shrubs (`mixFor`, `:190`). Both disappear with the recommended design. If the trees stay in Bundles, gate the fill on forest or scrub zones only, and skip the edge band for `wild:` zones.
6. **Forest constants are outside the content address.** Changing `FILL_SPACING_M`, the species mixes or the biome box changes output without changing `inputsHash`. Fold a `FOREST_VERSION` into `bundleInputsHash`, or move the trees out as above.

## What #21 and #23 did well

- **Species and landcover as Facts.** Observations always win, and a capture can name a species later.
- **The quantized forest mix in Essence**, with a biome fallback, fits ADR-0014 exactly.
- **The silhouettes**: real ecological knowledge (hemlock's drooping leader, cedar's skirt) that the display forest should adopt.
- **#23**: extracting `standFeatures` as a pure, tested function, and never gating observed trees on the site model.
