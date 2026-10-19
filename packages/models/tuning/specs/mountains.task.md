Add to apps/client/src/ocean.ts (in the context; keep everything already there unchanged) two more cheap TSL functions used by terrain.ts's topographic material. Return the whole updated file. three.js 0.186.1; TSL values are typed `Node<'float'>`, `Node<'vec3'>` (generic; import `type Node` from 'three/webgpu'), as the existing functions in the file already do.

```ts
/**
 * 0..1 mist on mountainsides: soft banks that hang between 150 and 650 m, thickest around
 * 300–400 m, broken into drifting streamers. The caller mixes the ground colour toward the
 * haze colour by this amount.
 */
export function mistBanks(height: Node<'float'>, world: Node<'vec3'>): Node<'float'>;

/**
 * 0..1 snow cover: above a snow line that wobbles between about 950 and 1100 m, less on steep
 * slopes (snow slides off rock: none above slope 0.75), and patchy near the line.
 * `slope` is 1 - normalWorld.y.
 */
export function snowCover(
  height: Node<'float'>,
  slope: Node<'float'>,
  world: Node<'vec3'>,
): Node<'float'>;
```

Constraints: no textures, no hash functions or loops; use sums of a few rotated, incommensurate sines (never a product of two axis-aligned sines: that reads as a checkerboard), with `time` from 'three/tsl' for slow drift (mist moves at about 3 m/s along a north-westerly direction; snow does not move). A handful of ALU ops each. In NOTES list every TSL function used.
