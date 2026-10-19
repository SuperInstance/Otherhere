Write apps/client/src/arrival.ts: a short cinematic "arrival" camera move for a walk/fly game. Plain TypeScript (strict, no `any`), no dependencies at all (no three.js import). Only this one file.

The game's camera pose is `Pose = { x: number; y: number; z: number; yaw: number; pitch: number }` (from './url'): x/z metres in the world plane (+z is south), y is the eye height above the ground in metres, yaw in radians (0 looks toward -z, i.e. north; positive turns left), pitch in radians (negative looks down).

```ts
import type { Pose } from './url';

/** An establishing shot above and behind `target`, looking at it: where an arrival starts. */
export function establishingShot(target: Pose, opts?: { height?: number; distance?: number }): Pose;

/**
 * Glides a pose from `from` to `to` over `seconds`, then stops. Position eases with smootherstep;
 * height comes down on a slightly later curve than the horizontal move, so the camera swoops in
 * rather than sliding; yaw takes the shortest way round; pitch eases from `from.pitch` to `to.pitch`.
 */
export class Arrival {
  constructor(from: Pose, to: Pose, seconds?: number); /* default 7 */
  /** Advance by dt seconds and write the current pose into `out`. Returns false once finished (and leaves `out` exactly at `to`). */
  step(dt: number, out: Pose): boolean;
  /** Retarget mid-flight (e.g. the start moved onto the nearest road): the remaining glide ends at `to`, without a jump. */
  retarget(to: Pose): void;
  readonly done: boolean;
}
```

establishingShot: default height 260 m, horizontal distance 520 m, placed toward the south-south-west of the target (so a northern skyline is behind it), yaw chosen so the camera looks at the target, pitch = -atan2(height - target.y, distance) * 0.85 (slightly above the target, so the background mountains are in frame).

Details:

- smootherstep(t) = t*t*t*(t*(6t-15)+10).
- Height uses smootherstep(clamp((t - 0.15) / 0.85, 0, 1)).
- Yaw: interpolate along the shortest signed angle difference, wrapped to (-π, π].
- retarget: keep the current pose as the new `from`, keep the elapsed fraction's remaining time (at least 1.5 s), and start a new glide to the new target.
- step must not allocate (called every frame).
- Export the small helpers smootherstep and shortestAngle for tests.

Match the style of url.ts (short doc comments saying why). In NOTES, list assumptions.
