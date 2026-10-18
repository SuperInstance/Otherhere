Write apps/client/src/terrain.ts: a streaming terrain layer for the walk view (three.js 0.186, `three/webgpu` + `three/tsl`, as in material.ts). Only this one file.

Data (same-origin proxies, already exist):

- Elevation: `/api/tiles/elev/{z}/{x}/{y}.png`, Terrarium encoding, 256×256, z 0..15 (XYZ/slippy scheme). Height in metres h = R*256 + G + B/256 - 32768. Decode with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })` and an OffscreenCanvas 2D getImageData, into a Float32Array(256*256).
- Satellite: `/api/tiles/sat/{z}/{x}/{y}.jpg` (Sentinel-2 cloudless 2016), z 0..15, same XYZ scheme.

World frame: the constructor receives `frame: LocalFrame` from '@otherhere/core' with `project({lat,lng}) => {e,n}` and `unproject({e,n}) => {lat,lng}`. World coordinates are x = e, z = -n, y = metres above sea level. Use exact per-vertex lat/lng → project (do not assume a flat scale).

API:

```ts
export type TerrainMode = 'topo' | 'satellite';
export const TERRAIN_ATTRIBUTION: Record<TerrainMode, string>; // satellite: 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0 · Elevation: Mapzen Terrain Tiles (USGS 3DEP, SRTM and others)'; topo: just the elevation part
export class Terrain {
  constructor(
    scene: Scene,
    frame: LocalFrame,
    opts?: { mode?: TerrainMode; maxTiles?: number /* default 160 */ },
  );
  readonly root: Group; // all tile meshes + the ocean
  mode: TerrainMode; // setter switches material; satellite textures load lazily
  /** True once any elevation tile has decoded; false forever after the first tile fails (flat fallback). */
  get active(): boolean;
  /** Ground height (m) at world x,z from the finest loaded heightmap (bilinear on pixels); 0 if none. */
  heightAt(x: number, z: number): number;
  /** Resolves when the z15 heightmaps covering the world-space rectangle are loaded (or failed / 4 s timeout). Never rejects. */
  ready(minX: number, minZ: number, maxX: number, maxZ: number): Promise<void>;
  /** Call every frame with the camera position. Selects tiles, starts loads, evicts. */
  update(x: number, y: number, z: number): void;
  stats(): { tiles: number; heightmaps: number; loading: number; textures: number };
  dispose(): void;
}
```

Tile selection: chunked quadtree. Roots are the z10 tiles intersecting a square of ±16 km around the camera. Split a node while z < 15 and distance (3D, camera to nearest point of the node's bounds, use height y) < node width × 1.6. Hysteresis: merge only when distance > width × 1.9. A node is drawn when it is a leaf of the selection; if a leaf's mesh is not loaded yet, draw its nearest loaded ancestor instead (and not the children), so there are never holes. Draw nothing for a region with no loaded ancestor.

Meshes: one BufferGeometry per tile, grid 64×64 segments at z ≥ 14, 32 otherwise, plus a skirt (an extra ring of vertices dropped 60 m × (16 - z) below the edge) to hide LOD cracks. Vertex heights bilinear-sampled from the tile's own heightmap. Compute normals. Add a `uv` attribute (0..1 across the tile, v = 0 at the north edge, matching an image with flipY=false). Geometry built in chunks so one frame never builds more than 4 tiles.

Materials (TSL, MeshStandardNodeMaterial, roughness 1, metalness 0):

- topo (one shared instance): colour from height and slope (slope = 1 - normalWorld.y). Palette for a coastal temperate rainforest (Sitka, Alaska): 0–3 m wet sand/rock '#8a8270'; low forest '#3f5a3a'; higher forest '#4c6b45' blending to subalpine '#7d8a5c' around 600 m; rock '#7a7468' where slope > 0.45 or above 900 m; snow '#f2f2ee' above 1150 m (snow line wobbled ±40 m by a cheap sin-based function of world x/z). Contour lines: thin every 20 m, medium every 100 m, using fract(h / interval) and fwidth(h) for anti-aliased pixel-width lines, darkening the colour (10% thin, 25% medium). Fade the contours out with distance from the camera (gone by 3 km). Use `positionWorld`, `normalWorld`, `cameraPosition`, `fwidth`, `fract`, `smoothstep`, `mix` from 'three/tsl'.
- satellite: a MeshStandardNodeMaterial per tile with `map` = the tile's texture (colorSpace SRGBColorSpace, flipY false, anisotropy 4). Until its texture arrives, the tile uses the shared topo material. Satellite textures are only requested in satellite mode, for drawn tiles.

Ocean: one large PlaneGeometry (60 km, rotated flat) at y = 0, following the camera in x/z (snapped to 100 m), MeshStandardNodeMaterial colour '#2d5563', roughness 0.35, metalness 0, with a TSL colour that blends toward '#5f8ea0' with fresnel (1 - dot(normalize(cameraPosition - positionWorld), up))^3. Render order so it draws after terrain. Hidden until `active`.

Memory (this is important; the reference we studied leaked):

- Loading: at most 6 concurrent fetches; each with an AbortController; abort loads for tiles no longer selected or needed as a fallback.
- An LRU over tile records keyed `z/x/y`. Each frame mark tiles used (drawn, ancestors used as fallback, and the z15 tiles pinned by pending `ready()` calls). When record count > maxTiles, evict least-recently-used unused records: remove from root, geometry.dispose(), per-tile material.dispose(), texture.dispose(), drop heightmap, close ImageBitmaps immediately after decoding.
- Heightmaps for z15 also live in a separate LRU of 64 so heightAt near the walker stays fine-grained after a mesh is evicted.
- `dispose()` releases everything.

Failure: if an elevation fetch fails (non-2xx or network), mark that tile failed (do not retry in a loop). If the very first elevation request fails and nothing has loaded, set the layer permanently inactive: no further requests, `heightAt` returns 0, `ready()` resolves immediately. This keeps tests deterministic when the tile proxy is unreachable.

Style: match world.ts and material.ts (short doc comments explaining why, no `any`, named exports, strict TS). No dependencies beyond three and @otherhere/core. Tile math helpers (lng/lat ↔ tile x/y) as small exported functions `tileOf(lat,lng,z)` and `tileBounds(z,x,y) => {north,south,west,east}` so they can be unit-tested.
