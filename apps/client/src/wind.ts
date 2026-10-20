/**
 * The wind in the crowns, as pure functions: how hard it blows under the weather
 * the sky reports, and where its travelling gusts sit over the ground. No
 * three.js here — forest.ts mirrors this in TSL on the instanced conifers, so
 * the wind is a display layer like everything else it touches: no Bundle byte,
 * generator, or golden hash changes (the ADR-0016 doctrine, extended to motion).
 *
 * Determinism: the same class as the day clock — keyed to *elapsed render
 * time*, never the wall clock and never `Math.random`. The same elapsed second
 * is the same wind on every device, and when `?t=` (or a postcard link) freezes
 * the clock, the wind freezes with it: a pinned forest stands mid-sway, exactly
 * as it stood when the moment was saved.
 *
 * Weather keying (reading the cloud cover the sky exposes): solid overcast is
 * still air — the grey ceiling sits on the forest and nothing moves; clear sky
 * carries travelling waves — gusts that run through the chunk-seeded stands so
 * a crest visibly crosses the forest wall; broken sky is in between. The
 * thresholds line up with `describeWeather`'s bands, so the status line's word
 * and the crowns agree.
 */

/** One full turn, for the travelling-wave phases. */
const TAU = Math.PI * 2;

/**
 * The prevailing wind, as the direction gusts travel *toward* — from the
 * south-east, the quarter Sitka's weather arrives from. Unit vector in the walk
 * frame (x east, z south), fixed so every frame of every device agrees.
 */
export const WIND_TOWARD: readonly [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2];

/** The long swell of the gust field: metres between crests, metres per second downwind. */
export const GUST_LONG = { lambda: 130, speed: 9 } as const;
/** A shorter, slower component so the field never reads as one clean sine. */
export const GUST_SHORT = { lambda: 55, speed: 6 } as const;
/** How fast a crown swings about its lean (rad/s ≈ 0.64 Hz — a real conifer's period). */
export const FLUTTER_RATE = 4.0;
/** A faster, smaller crosswise shiver, so crowns do not swing like pendulums. */
export const SHIVER_RATE = 6.3;
/** The lean direction wanders this many radians, this fast (rad/s): gusts never march dead straight. */
export const WOBBLE_RAD = 0.25;
export const WOBBLE_RATE = 0.19;
/** Crown-tip travel at full wind on the whippiest tip, metres. */
export const SWAY_MAX_M = 1.1;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash1(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 1-D value noise: one slow gust cycle every ~16 s of elapsed time. */
function breathNoise(t: number): number {
  const x = t / 16;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const at = (k: number) => hash1(k * 0x45d9f3b);
  return at(i) * (1 - s) + at(i + 1) * s;
}

/**
 * How hard the wind blows, 0..1, from elapsed time and the cloud cover the sky
 * reports. Overcast is *exactly* still (the key clamps to 0); clear sky blows
 * full strength; broken sky fades between. The wind also breathes — it comes
 * and goes over ~16 s — so even under a clear sky the crowns rest between gusts.
 *
 * `floor` is the biome band (enjoyability r3): in the pacific rainforest a
 * grey ceiling no longer sits dead on the forest — the ocean stand keeps a
 * breath. The floor rides UNDER the weather key, so a clear sky still blows
 * exactly as hard as before; only the overcast silence is lifted, and only
 * where the biome says so. Below the status line's word (0.3): felt, not named.
 */
export function windStrength(elapsed: number, cloud: number, floor = 0): number {
  const key = smoothstep(0.75, 0.4, cloud);
  return Math.max(floor, key * (0.55 + 0.45 * breathNoise(elapsed)));
}

/**
 * The travelling gust envelope, 0.35..1, at a ground position: two
 * incommensurate waves running downwind (a 130 m swell at 9 m/s and a 55 m
 * chop at 6 m/s), never quite in step, so crests cross the stands at a
 * readable pace without ever tiling.
 */
export function gustAt(elapsed: number, x: number, z: number): number {
  const d = x * WIND_TOWARD[0]! + z * WIND_TOWARD[1]!;
  const a = Math.sin(TAU * (d / GUST_LONG.lambda - (elapsed * GUST_LONG.speed) / GUST_LONG.lambda));
  const b = Math.sin(
    TAU * (d / GUST_SHORT.lambda - (elapsed * GUST_SHORT.speed) / GUST_SHORT.lambda) + 2.1,
  );
  return 0.35 + 0.65 * (0.5 + 0.3 * a + 0.2 * b);
}

/**
 * The crown flutter's phase over the ground: two long, rotated sines
 * (wavelengths ~150–270 m), so trees a few stands apart swing out of phase
 * while one crown — a few metres across — moves as a single thing.
 */
function flutterPhase(x: number, z: number): number {
  return 1.6 * Math.sin(0.041 * x + 0.029 * z) + 1.2 * Math.sin(0.023 * x - 0.047 * z + 1.3);
}

/**
 * The world-space sway offset (metres, x east / z south) of one point of one
 * tree — the whole spec of the wind's motion, which forest.ts mirrors in TSL.
 *
 * `flex` is the point's willingness to move, 0 at the root to ~1 at the
 * whippiest tip (baked per species: hemlock leaders give, spruce tiers are
 * stiff). The offset swings around a downwind lean with the flutter, gains
 * reach inside gusts, shivers a little across the wind, and the lean direction
 * itself wanders — a field with weather, not a metronome.
 */
export function swayOffset(
  elapsed: number,
  cloud: number,
  x: number,
  z: number,
  flex: number,
): [number, number] {
  const d = x * WIND_TOWARD[0]! + z * WIND_TOWARD[1]!;
  const env = gustAt(elapsed, x, z);
  const psi = flutterPhase(x, z);
  const flutter = Math.sin(FLUTTER_RATE * elapsed + psi);
  const shiver = Math.sin(SHIVER_RATE * elapsed + 1.7 * psi);
  const wobble = WOBBLE_RAD * Math.sin(WOBBLE_RATE * elapsed + 0.006 * d);

  const amp = SWAY_MAX_M * windStrength(elapsed, cloud) * env * flex;
  const lean = amp * (0.42 + 0.58 * flutter);
  const cross = amp * 0.18 * shiver;

  const cw = Math.cos(wobble);
  const sw = Math.sin(wobble);
  const dirX = WIND_TOWARD[0]! * cw - WIND_TOWARD[1]! * sw;
  const dirZ = WIND_TOWARD[1]! * cw + WIND_TOWARD[0]! * sw;
  return [dirX * lean - dirZ * cross, dirZ * lean + dirX * cross];
}

/** One honest phrase for the status line, in the house voice. */
export function describeWind(strength: number): string {
  if (strength >= 0.6) return 'wind in the crowns';
  if (strength >= 0.3) return 'a breeze in the crowns';
  return '';
}
