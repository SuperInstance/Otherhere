# Terrain is a client display layer; Bundles stay flat

Real places have hills (Sitka sits between the sea and 1,000 m mountains), so the walk view stands on real ground. The ground comes from public datasets, not Facts:

- **Elevation:** Mapzen Terrain Tiles (Terrarium PNG on AWS Open Data: USGS 3DEP, SRTM and others), z0–15.
- **Imagery (optional, `?map=satellite` or the M key):** Sentinel-2 cloudless **2016** by EOX, CC BY 4.0. Later years are CC BY-NC-SA, so they are not used. No Google imagery (invariant 8). The default is a procedural topographic look: colour from height and slope, plus contour lines.

Both are fetched through the edge (`/api/tiles/{elev|sat}/{z}/{x}/{y}`) so the CSP stays same-origin, and cached there for a month. The routes accept only valid tile addresses up to z15 and have their own generous rate limit.

**Bundles are unchanged** (invariant 1: Derived = f(Facts, generator versions)). They are still built on flat ground, and their hashes are checked against the manifest before anything moves. The client then stands each Feature on the terrain. A Feature with height (a building) moves as one rigid piece onto the lowest ground under it, sunk 0.3 m, so floors stay level. A flat Feature (a road) is draped per vertex. The Cell's flat ground hexagon is collapsed. The camera's `pose.y` is now the eye's height above the ground.

**Memory is bounded.** Tiles live in an LRU with a hard budget; eviction disposes geometry, textures and per-tile materials, and decoded bitmaps are closed at once. Fine heightmaps have their own small LRU, so ground height near the walker stays sharp after a mesh is evicted. Loads are capped in flight and aborted when no longer needed.

**Failure is flat.** If the first elevation tile fails, the layer turns itself off: no more requests, ground height 0, and the world looks as it did before terrain. The e2e tests point both tile sources at a closed port, so they run on flat ground and stay deterministic.

## Consequences

- Snapping happens after hash verification, so the same Bundle can sit at slightly different heights on two devices if they loaded different heightmap zooms when it arrived. Ground height is sampled from z15 heightmaps (`ready()` waits up to 4 s for them), which makes this rare and small. It never changes Bundle bytes.
- A future server-side ground model (for example, Facts about a building's base elevation) would replace the client's sampling. It would need its own generator version.
