Write apps/client/src/atmosphere.ts (three.js 0.186.1, `three/webgpu` and `three/tsl` only, strict TypeScript, no `any`). Only this one file. Visual polish for a walk/fly view of Sitka, Alaska: a misty coastal temperate rainforest town between the sea and 1,000 m mountains. Everything must be cheap: no extra render passes, no post-processing, a handful of ALU ops per pixel, nothing per-frame on the CPU except setting a few uniforms.

```ts
/** The one fixed sun (the scene's DirectionalLight points from here), normalised. */
export const SUN_DIRECTION: Vector3; // normalise (-0.45, 1, 0.3)

export type Atmosphere = {
  /** Call once per frame with the camera position (world, metres; y is height above sea level). */
  update(camera: { x: number; y: number; z: number }): void;
  /** Turn the far haze up for big terrain (true) or keep the old close fog (false). */
  setTerrain(on: boolean): void;
  dispose(): void;
};

export function createAtmosphere(scene: Scene, renderer: WebGPURenderer): Atmosphere;
```

What it does:

1. Tone mapping: `renderer.toneMapping = ACESFilmicToneMapping`, `toneMappingExposure` about 1.0 (choose so the existing palette, paper '#ddd6c6' buildings and forest '#3f5a3a' ground, is not washed out).
2. Sky dome: a SphereGeometry (radius 50 km, 32×16) with side BackSide, depthWrite false, `fog = false`, renderOrder -1, frustumCulled false, kept centred on the camera in update(). MeshBasicNodeMaterial whose colorNode is a function of the view direction `dir = normalize(positionWorld - cameraPosition)`: horizon haze '#d9dcd6' blending to zenith '#8fb3c9' with smoothstep over dir.y in [0, 0.45]; below the horizon stay at the horizon colour (so the gap under far terrain never shows a seam); a soft sun glow around SUN_DIRECTION, mix in a warm '#fff1d6' by pow(max(dot(dir, sun), 0), 8) * 0.35 plus a tight disc pow(…, 600) * 1.5. Set `scene.background = null` (the dome replaces it).
3. Fog via `scene.fogNode` (a custom node; three 0.186 reads `scene.fogNode` before `scene.fog`, so also set `scene.fog = null`). Build it from `fog(colorNode, factorNode)` exported by 'three/tsl'. Factor = max(range fog, height fog):
   - range fog: smoothstep(nearU, farU, viewDistance) where viewDistance = distance(cameraPosition, positionWorld), nearU/farU are `uniform()`s updated in update(): without terrain near = 80 + 2·eye, far = 520 + 6·eye (the current behaviour); with terrain near = 400 + 4·eye, far = 9000 + 20·eye, capped at 30 km.
   - height fog (valley mist that pools low): density falls off with world height: f = (1 - exp(-viewDistance * 0.00012 * exp(-max(positionWorld.y, 0) / 180))) * 0.85, only when terrain is on (multiply by a 0/1 uniform).
   - Fog colour = aerial perspective: the same horizon haze colour, warmed toward '#efe3cf' when looking toward the sun: mix by pow(max(dot(normalize(positionWorld - cameraPosition), SUN_DIRECTION), 0), 4) * 0.5. A slight blue shift for far distance: mix toward '#b9c7cf' by smoothstep(2000, 15000, viewDistance) * 0.5.
4. update() also moves the dome, and updates the uniforms. setTerrain toggles the height fog uniform and switches the range-fog formula.
5. dispose() removes the dome, disposes its geometry and material, and resets scene.fogNode.

Match the style of the given context files (short doc comments saying why, named exports). Use `uniform`, `float`, `vec3`, `color`, `mix`, `smoothstep`, `pow`, `max`, `dot`, `normalize`, `exp`, `distance`, `positionWorld`, `cameraPosition`, `fog` from 'three/tsl'. If you are unsure whether a TSL function exists in 0.186 with that exact name, say so in NOTES and use the safest equivalent.
