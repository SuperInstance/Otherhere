Write apps/client/src/forest.ts: a streaming, display-only forest of low-poly conifers for a walk/fly view of Sitka, Alaska (coastal temperate rainforest: Sitka spruce and western hemlock, 15–45 m tall, dense on low slopes, thinning with altitude, none above ~700 m). three.js 0.186.1, `three/webgpu` + `three/tsl` only, strict TypeScript, no `any`. TSL values are typed `Node<'float'>`, `Node<'vec3'>` (generic; `import type { Node } from 'three/webgpu'`). Only this one file.

World frame: x east, z south, y metres above sea level.

```ts
export type ForestGround = {
  readonly active: boolean; // false until terrain heights exist; plant nothing until then
  heightAt(x: number, z: number): number; // finest ground height known (m); 0 at or below sea level
};

export class Forest {
  constructor(
    scene: Scene,
    ground: ForestGround,
    opts?: {
      occupied?: (x: number, z: number) => boolean; // true where buildings/roads stand: never plant there
      radius?: number; // planted around the camera, metres (default 1400)
      maxTrees?: number; // hard cap on live instances (default 26000)
    },
  );
  readonly root: Group;
  /** Heights or buildings changed in this world rectangle: replant the chunks it touches (if planted). */
  invalidate(minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Once per frame with the camera position. Plants at most 2 chunks per call, nearest first; drops chunks beyond radius × 1.25. */
  update(x: number, z: number): void;
  stats(): { chunks: number; trees: number };
  dispose(): void;
}
```

Chunks: a fixed world grid of 250 m squares, keyed by integer (ix, iz). Determinism: everything about a chunk's trees comes from a small integer hash of (ix, iz) driving a seeded PRNG (mulberry32 or similar). Never Math.random, never time. Same chunk → same trees on every device and every replant (unless the ground or occupancy changed).

Planting a chunk: candidates on a jittered grid of 7.5 m spacing (jitter ±3 m). For each candidate:

- h = heightAt(x, z). Reject if h < 2.5 (beach, water) or h > 720.
- slope from heightAt at ±4 m in x and z: s = hypot(dhx, dhz) / 8; reject if s > 0.9 (cliffs); keep probability falls from 1 at s = 0.35 to 0 at s = 0.9.
- altitude: keep probability 0.85 below 300 m, falling linearly to 0 at 720 m.
- occupied(x, z) → reject.
- Species: hemlock 40%, spruce 60%. Height: spruce 18–42 m, hemlock 15–32 m; trees above 450 m are shorter (scale height by mix(1, 0.45, (h - 450) / 270) clamped).
- A few tiny clearings: reject candidates where a cheap seeded value-noise at 60 m scale is in its lowest 12%.
  Base of each tree sits 0.6 m below heightAt (no floating on slopes).

Rendering: per chunk, one InstancedMesh per species (2 geometries shared by all chunks, 1 shared material). Instance matrix: translate, random yaw, scale (width = height × 0.32 for spruce, × 0.36 for hemlock). Instance colour (setColorAt): small seeded variation around '#2c4a32' (spruce, bluish) and '#36503a' (hemlock, warmer), ±8% in lightness.
Geometry (built once, BufferGeometry, unit height 1, base at y = 0, centred on x/z): spruce = trunk (6-sided, radius 0.03, to y 0.12) + 3 stacked 7-sided cones (tiers overlapping, radii 0.5/0.38/0.24, the top one pointed); hemlock = trunk + 2 softer cones with a slightly drooping tip (offset the apex 0.03 in x). Non-indexed or indexed both fine; computeVertexNormals. Keep each under 90 triangles.
Material: MeshStandardNodeMaterial, roughness 1, metalness 0. Colour = instance colour darkened toward the base of the tree (mix(0.55, 1, smoothstep(0, 0.45, positionLocal.y))) so forests have depth, and a faint lighter rim on the upper third (mix toward instance colour × 1.25 by smoothstep(0.65, 1, positionLocal.y) × 0.4). Use `instanceColor`-aware TSL if needed (in 0.186 InstancedMesh colours reach node materials automatically through the `color` attribute path when `vertexColors`-like instancing is used — if unsure, read them with `instanceColor` from 'three/tsl' or fall back to the material colour; say which in NOTES).

Budget and memory: never exceed maxTrees live instances (if a chunk would exceed it, plant only what fits and mark it partial so it can be completed later). Dropping a chunk removes its meshes from root and disposes only the InstancedMesh objects (not the shared geometries or material: dispose those only in dispose()). invalidate() marks touched chunks for replant (replant = drop + plant, still at most 2 per update).

Style: short doc comments saying why, as in the context files. In NOTES list assumptions and any TSL names you were unsure of.
