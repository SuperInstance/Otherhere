Write apps/client/src/ocean.ts (three.js 0.186.1, `three/webgpu` and `three/tsl` only, strict TypeScript, no `any`). Only this one file. It is used by terrain.ts (in the context) for its ocean plane and its topographic material. Everything must be cheap: no extra passes, no textures, a handful of ALU ops per pixel. Animation uses `time` from 'three/tsl' (seconds); it is display-only.

```ts
/** The ocean's material: flat plane at y = 0, any size, following the camera. */
export function oceanMaterial(sun: Vector3): MeshStandardNodeMaterial;
/** 0..1 white foam on land just above the waterline (0–1.5 m), breathing with the waves. For terrain.ts's colour. */
export function shoreFoam(height: Node, world: Node /* positionWorld */): Node;
/** A multiplier 0.78..1 for diffuse colour: large soft cloud shadows drifting across the land. */
export function cloudShadow(world: Node /* positionWorld */): Node;
```
(`Node` = the TSL node type that the other functions in terrain.ts already pass around; use the type three exports, `ShaderNodeObject<Node>` or whatever 0.186 calls it, and say which in NOTES.)

oceanMaterial:
- Ripple normal from a sum of 4 directional sine waves in world x/z (wavelengths 7, 13, 29, 61 m, different directions, amplitudes decreasing, speeds by the deep-water relation c = sqrt(g·λ/2π)). Compute the analytic derivative to build the normal: n = normalize(vec3(-dh/dx, 1, -dh/dz)). Assign to `normalNode` (world-space normal; check that MeshStandardNodeMaterial in 0.186 accepts a normalNode in the space you give it, and transform to view space with `transformNormalToView` if it needs view space; say which in NOTES). Fade the ripple strength with distance from the camera (gone by 2 km) so far water does not shimmer.
- Colour: deep '#1f4552' to sky-tinted '#6f97a8' by fresnel (1 - max(dot(viewDir, n), 0))^4; roughness 0.18, metalness 0.
- Sun glint: add emissive warm white by pow(max(dot(reflect(-viewDir, n), sun), 0), 180) * 2.5 (cheap stand-in for a specular highlight, so it reads even without an environment map).
- opaque, renderOrder left to the caller.

shoreFoam(height, world): bands that move up and down the beach: let wave = sin(time*0.8 + world.x*0.05 + world.z*0.035)*0.35; foam = (1 - smoothstep(0.15, 1.2, height - wave*0.5)) * smoothstep(-0.2, 0.15, height); break it up with a cheap hash-free pattern sin(world.x*0.9)*sin(world.z*1.1) > -0.3 (smoothed); result 0..1.

cloudShadow(world): two octaves of product-of-sines noise at 1.8 km and 0.7 km scales drifting with time (wind ~6 m/s from the south-west), remapped with smoothstep so most land is fully lit and ~30% is in soft shadow; return mix(0.78, 1, lit).

Match the style of terrain.ts and material.ts (short doc comments saying why). In NOTES list every TSL function name you used and any you were not sure exists in 0.186.
