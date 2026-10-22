# The forest is imagined per Cell from landcover, taxonomy, and the Town's Essence

_Amended 2026-10-22: the drawing moved. The data model below stands — species as a Fact, landcover as an input Fact, the mix as Essence — but the trees are drawn by the client's display forest, not grown inside `buildBundle`. See the amendment at the end._

Around Sitka the big stable trees are roughly **70 % western hemlock, 25 % Sitka spruce, 5 % yellow cedar**, with alder on disturbed ground and salmonberry in clearings and roadsides. A single generic tree prop cannot say any of that, and a hand-placed one cannot be true to a place we have never seen. So the forest is _derived_, like every other Bundle content:

- **Species is a Fact** (`species`: `hemlock` | `spruce` | `cedar` | `alder` | `salmonberry` | `broadleaf`). Where OSM tags a taxon (`taxon`, `species`, `genus`) we recognise, that wins with high confidence. A capture or an edit can name one later and outrank it (invariant 4).
- **Landcover is a Fact** (`landcover`: `forest` | `scrub` | `meadow`) from `landuse=forest`, `natural=wood`, `natural=scrub`, `landuse=meadow`. It is an _input_, never a drawing: no generator applies to it, and meadows stay open.
- **The mix is Essence** (ADR-0014). `Essence.forest` is the Town's observed species shares, quantized to 0.05, unsaid below 5 samples; `Essence.biome` is where the Town sits (`pacific-rainforest` around the Alexander Archipelago, `temperate` elsewhere — a coarse box until satellite inference lands). Generators see `@essence.forest.<species>` weights, so an unseen tree takes the Town's character, and the Town's character falls back to the biome's: the observed 70/25/5 mix.

**`imagineForest` grows the trees at build time**, inside `buildBundle`, never as stored Facts:

- A jittered 13 m grid over each forest/scrub zone (clipped to the Cell hexagon), seeded from the zone's Feature ID — never `Math.random()` (invariant 2). Crowded Cells are thinned uniformly (cap 220), not truncated.
- Placement is ecological but stylised: no tree within 7 m of a road centreline or a building wall, none crowding an observed tree (which knows exactly where it is), alder and salmonberry in the roadside strip and the disturbed band just inside a forest's edge, scrub zones staying alder/salmonberry.
- Each imagined tree is a derived Feature (`gen:<hash>`) carrying `position` and `species` at low confidence, `source: "imagined"`. `imagined` sits **below** every observed source rank and is not a valid Fact source, so the first real observation — an OSM tree, a capture — simply wins and the stand redraws around it.

**The species silhouettes are the generator's job** (`prop.tree` v0.2): hemlock is tall and narrow with a drooping leader and stacked, irregular, dark-green crown; spruce is broad-based with stiff horizontal tiers in blue-green; cedar is a narrow cone with a grey dead skirt and pendulous yellow-green tips; alder is a multi-stem grey thicket; salmonberry a broad arching shrub that even carries its berries. Heights and forms are imagined per tree from seeded draws; a `height` Fact (OSM or capture) overrides.

## Consequences

- A Cell with no forest Facts in a `wild` biome (≤ 4 buildings) is forest until Facts say otherwise — around Sitka, the island reads as the dark hemlock-spruce wall it is. In a temperate Town an empty Cell stays open ground.
- Landcover polygons anchor at their centroid (ADR-0003), so a wood spanning several Cells is grown only in its anchored Cell; its neighbours fall back to the wild fill. Clipping polygons per Cell is the later, honest fix.
- The interpreter version moved to 0.5.0 (imagined Features join the build) and the golden hashes with it.
- Later: species mixes sharpened from captures (a photo of a stand updates the Town's `Essence.forest`), satellite canopy cover as a `satellite_inference` Fact, and per-neighbourhood essence instead of per-Town.

## Amendment (2026-10-22): the display forest draws the imagined trees

The original design grew up to 220 imagined trees per Cell inside `buildBundle`. Measured on a wild hillside north of Sitka, that Cell's Bundle was **1.57 MB** (167 Features, 33,865 vertices) where the same Cell before the forest was under 1 KB — trees the client loads, hashes, parses and stores in R2 for every Cell anyone walks past, placed by a build that cannot know where the ground is (61 % of the imagined trees across Sitka's bay stood below the beach line, collapsed client-side after download). The display forest (`apps/client/src/forest.ts`) already drew a streamed, instanced forest on real terrain for a few hundred triangles a chunk. Two forests, two species models, meeting at the edge of the loaded Cells.

**The decision**: the imagined forest is drawn by the display forest, from the same data model this ADR established. Nothing else changes — species and landcover stay Facts (invariant 1 is untouched: nothing imagined is stored), the mix stays Essence, observations still win.

- **Bundles keep observed trees only** (`natural=tree` nodes, drawn by `prop.tree`). `imagineForest` is deleted; with it die its known defects: list-position thinning that moved every tree when one candidate arrived, `Math.hypot` in a hashed comparison, the two disagreeing biome defaults, one meadow suppressing a whole Cell's wild fill, and the hexagon edge band drawn in shrubs. A per-point landcover query in the client fixes the meadow bug by construction: a meadow clears only its own ring.
- **The landcover rings and the species mix ride in the GLB extras** (`extras.otherhere.forest`): zones as local-frame rings rounded to centimetres, the mix over the full species vocabulary, Essence-first with the biome character as fallback. Both derive from inputs the content address already covers (`features`, `essence`), so a changed ring or mix moves `inputsHash` by construction — no `FOREST_VERSION` is needed. The extras are data, not drawing: landcover still has no generator.
- **The display forest reads them**: `World.landcoverAt(x, z)` answers forest/scrub/meadow from the loaded Cell's rings; the density callback plants full forest inside `forest` rings, thinner scrub (0.35, conifers standing in for alder until their silhouette exists), nothing in meadows, and the biome's wild rules elsewhere. `World.forestSpruceP` gives the Town's spruce share of its conifers, so one mix shapes the whole forest — the "one forest, one look" the review asked for.
- **`INTERPRETER_VERSION` moved to 0.6.0** so every Cell rebuilds without its imagined trees. The wild Cell measures **1,836 bytes** (0 Features, 6 vertices: ground and extras) where it measured 1.57 MB.
- **The paper world (no terrain) is honestly treeless**: where there is no ground there is no display forest, so the flat e2e/demo world shows buildings and roads without trees. The terrain is the ground truth of where a tree can stand (ADR-0016); paper is a sketch of knowledge, not of trees.

Still open, deliberately: landcover polygons anchor at their centroid Cell, so a wood spanning Cells is planted only in its anchored Cell (unchanged from the original design); alder and salmonberry have no display silhouette yet, so scrub zones plant short conifers; per-Neighbourhood Essence and satellite canopy cover remain future work as before.
