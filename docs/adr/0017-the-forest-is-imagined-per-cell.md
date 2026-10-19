# The forest is imagined per Cell from landcover, taxonomy, and the Town's Essence

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
