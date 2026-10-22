import { describeWind } from './wind';

/**
 * The living sky, as pure functions: where the sun is, what time the day clock
 * reads, what the weather is doing, and what the world should look like because
 * of it. No three.js here — every consumer (atmosphere, ocean, terrain, main)
 * reads these and feeds uniforms or lights, so the whole thing stays a display
 * layer: no Bundle byte, generator, or golden hash changes (the ADR-0016
 * doctrine, extended to the sky).
 *
 * Determinism: the day's hour is a pure function of the accumulated sky step,
 * and a pinned `?t=` view freezes that accumulation — so a pinned scene shows
 * the same sky on every device and every reload (what the pixel-identical
 * reload e2e exercises). The step itself runs at true wall speed, clamped and
 * never backwards (see `skyStep`): a slow renderer slows the frame rate, not
 * the day. What is never read is the calendar — `DAY_OF_YEAR` is fixed on
 * purpose.
 */

/* ------------------------------------------------------------------ the day */

/** Every visit opens in mid-morning light; the day turns from there. */
export const DAY_START_HOUR = 9.5;
/** One game hour per real minute: a full day passes while you walk (24 min). */
export const HOURS_PER_SECOND = 1 / 60;
/** Holding T runs the clock this much faster, to reach dusk without waiting. */
export const FAST_FORWARD = 12;
/**
 * The eternal solstice: a fixed day of year keeps the sun's declination (and so
 * every screenshot) deterministic. Tying it to the real calendar is a later,
 * deliberate choice — it must not sneak in through a Date call.
 */
export const DAY_OF_YEAR = 172;

/** The day-clock hour (0..24) after `elapsed` seconds at `hoursPerSecond`. */
export function clockHour(
  startHour: number,
  elapsed: number,
  hoursPerSecond = HOURS_PER_SECOND,
): number {
  return (((startHour + elapsed * hoursPerSecond) % 24) + 24) % 24;
}

/**
 * The sky's own time step. The walk loop clamps its step tightly (0.25 s, so a
 * slow frame cannot tunnel a walker through a wall), and the day used to share
 * that clamp — which quietly slowed the DAY itself on a slow renderer: below
 * 4 fps the 24-minute day stretched out of shape, and "hold T to pass time"
 * barely moved it. So the sky advances at true wall speed up to a generous
 * bound (a backgrounded tab still never jumps the clock), never backwards,
 * and not at all in a frozen view.
 */
export function skyStep(rawDt: number, fast: boolean, frozen: boolean): number {
  if (frozen) return 0;
  return Math.min(2, Math.max(0, rawDt)) * (fast ? FAST_FORWARD : 1);
}

/* ------------------------------------------------------------------ the sun */

export type SunPos = {
  /** Degrees above the horizon; negative at night. */
  elevation: number;
  /** Degrees clockwise from north (through east), the direction *to* the sun. */
  azimuth: number;
};

/** Solar declination in degrees for a day of the year (the axial tilt term). */
export function declination(dayOfYear: number): number {
  return 23.44 * Math.sin((2 * Math.PI * (dayOfYear - 81)) / 365);
}

/**
 * Where the sun is, from latitude, day of year, and local solar time — the
 * standard declination/hour-angle construction, accurate to a fraction of a
 * degree, which is all a stylized sky needs.
 */
export function sunPosition(latDeg: number, dayOfYear: number, hour: number): SunPos {
  const phi = (latDeg * Math.PI) / 180;
  const delta = (declination(dayOfYear) * Math.PI) / 180;
  const H = ((hour - 12) * 15 * Math.PI) / 180;
  const sinEl = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H);
  const elevation = (Math.asin(Math.max(-1, Math.min(1, sinEl))) * 180) / Math.PI;
  // Azimuth from north, clockwise; the sign of the hour angle picks morning/evening.
  const cosAz =
    (Math.sin(delta) - Math.sin(phi) * sinEl) /
    Math.max(1e-6, Math.cos(phi) * Math.cos(elevation * (Math.PI / 180)));
  let azimuth = (Math.acos(Math.max(-1, Math.min(1, cosAz))) * 180) / Math.PI;
  if (H > 0) azimuth = 360 - azimuth; // past solar noon: the sun is in the west
  return { elevation, azimuth };
}

/**
 * Unit vector *to* the sun in the world frame: x east, y up, z south (the walk
 * frame's z is south, so azimuth 180° — the noon sun — points to +z).
 */
export function sunDirection(
  latDeg: number,
  dayOfYear: number,
  hour: number,
): [number, number, number] {
  const { elevation, azimuth } = sunPosition(latDeg, dayOfYear, hour);
  const el = (elevation * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/**
 * Where the moon hangs, stylized: opposite the sun's azimuth, rising as the sun
 * sets, never below 7° so nights keep a light. A real lunar phase is a later
 * pleasure; this one is honest about being a stage light.
 */
export function moonDirection(sun: readonly [number, number, number]): [number, number, number] {
  const [x, , z] = sun;
  const az = Math.atan2(-x, z); // opposite azimuth
  const el = Math.max((7 * Math.PI) / 180, Math.asin(Math.max(-1, Math.min(1, -sun[1]))));
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/* --------------------------------------------------------------- the weather */

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash1(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth value noise over the day clock, periodic over 24 h: one weather
 * system every 1.5 h of the day (16 to a day) with a fine octave every 24 min
 * (60 to a day). Both periods divide the day exactly and the segment indices
 * wrap, so the noise has no seam at midnight — and, being a pure function of
 * the hour, the weather belongs to the hour the way the sun's place does.
 */
function weatherNoise(hour: number): number {
  return periodicNoise(hour / 1.5, 16, 0) * 0.7 + periodicNoise(hour / 0.4, 60, 7919) * 0.3;
}

/** One octave of value noise whose segments wrap after `period` steps. */
function periodicNoise(x: number, period: number, salt: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const at = (k: number) => hash1((((k % period) + period) % period) * 0x27d4eb2d + salt);
  return at(i) * (1 - s) + at(i + 1) * s;
}

/**
 * Cloud cover 0..1 from the day-clock hour and biome. The weather is a
 * property of the hour, not of how long you have been watching: a postcard's
 * `t=` pins the weather along with the hour it pins, and two players who meet
 * at the same hour stand under the same sky. A rainforest town (the ADR-0017
 * box) sits under heavier, mistier skies than a temperate one: the same clock
 * reads two different weathers in Sitka and Zürich.
 */
export function cloudCover(hour: number, biome: 'temperate' | 'pacific-rainforest'): number {
  const [lo, hi] = biome === 'pacific-rainforest' ? [0.45, 0.95] : [0.12, 0.62];
  return lo + (hi - lo) * weatherNoise(hour);
}

/* ---------------------------------------------------------------- the palette */

export type RGB = readonly [number, number, number];

export type SkyPalette = {
  /** Sky gradient ends. */
  horizon: RGB;
  zenith: RGB;
  /** The glow colour of the brightest body: warm sun, cool moon. */
  glow: RGB;
  /** What very distant terrain fades toward. */
  fogFar: RGB;
  /** The directional light: sun by day, moon at night. */
  lightColor: RGB;
  lightIntensity: number;
  /** Ambient light from the sky and the ground. */
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  /** 0..1: the sun disc and its glint on the water. */
  sunGlow: number;
  /** 0..1: the moon disc and moonlight strength. */
  moon: number;
  /** 0..1: star visibility. */
  stars: number;
  /** Fog distances divide by this: >1 hazier (overcast pulls the haze in), <1 clearer. */
  hazeScale: number;
  /** Multiplier for the terrain's mist banks. */
  mist: number;
};

/** Hex to linear-ish RGB triple (we interpolate in sRGB; this is stylization, not physics). */
function rgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

type Keyframe = {
  el: number;
  horizon: string;
  zenith: string;
  glow: string;
  fogFar: string;
  light: string;
  lightI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  stars: number;
  moon: number;
};

/**
 * The day in five moments. Elevation drives everything, so golden hour is a
 * place the sun passes through, not a time of day. The `35°` row *is* the old
 * fixed wet-Sitka look: the classic Otherhere day survives as "clear midday".
 */
const KEYS: readonly Keyframe[] = [
  {
    el: -18,
    horizon: '#101a2e',
    zenith: '#050a16',
    glow: '#c9d6ec',
    fogFar: '#0b1322',
    light: '#a9bdd9',
    lightI: 0.22,
    hemiSky: '#1a2946',
    hemiGround: '#12151b',
    hemiI: 0.5,
    stars: 1,
    moon: 0.9,
  },
  {
    el: -8,
    horizon: '#3c4266',
    zenith: '#0f1b34',
    glow: '#b7a3c4',
    fogFar: '#252c47',
    light: '#8fa0c9',
    lightI: 0.32,
    hemiSky: '#2c3a58',
    hemiGround: '#1d2026',
    hemiI: 0.8,
    stars: 0.5,
    moon: 0.6,
  },
  {
    el: 2,
    horizon: '#dfa072',
    zenith: '#46648e',
    glow: '#ffcf9e',
    fogFar: '#a99a96',
    light: '#ffb37a',
    lightI: 1.35,
    hemiSky: '#b8c1d4',
    hemiGround: '#6e5f52',
    hemiI: 1.35,
    stars: 0,
    moon: 0,
  },
  {
    el: 12,
    horizon: '#d8d3c4',
    zenith: '#7ea6c4',
    glow: '#ffe7c4',
    fogFar: '#b3c1ca',
    light: '#ffedd2',
    lightI: 1.7,
    hemiSky: '#eae4dc',
    hemiGround: '#a99c86',
    hemiI: 1.6,
    stars: 0,
    moon: 0,
  },
  {
    el: 35,
    horizon: '#d9dcd6',
    zenith: '#8fb3c9',
    glow: '#fff1d6',
    fogFar: '#b9c7cf',
    light: '#fff4e2',
    lightI: 1.9,
    hemiSky: '#f6f2ea',
    hemiGround: '#b7ab92',
    hemiI: 1.7,
    stars: 0,
    moon: 0,
  },
];

/**
 * The whole sky's state from the sun's elevation (degrees) and cloud cover
 * (0..1). Overcast pulls every colour toward a flat grey (darker at night),
 * swallows the discs, thickens the haze and pools the mist.
 */
export function skyPalette(elevationDeg: number, cloud: number): SkyPalette {
  const el = Math.max(KEYS[0]!.el, Math.min(KEYS[KEYS.length - 1]!.el, elevationDeg));
  let lo = KEYS[0]!;
  let hi = KEYS[KEYS.length - 1]!;
  let t = 0;
  for (let i = 0; i + 1 < KEYS.length; i++) {
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    if (el >= a.el && el <= b.el) {
      [lo, hi] = [a, b];
      t = (el - a.el) / (b.el - a.el);
      break;
    }
  }

  // How much daylight there is, for scaling the overcast greys.
  const dayVis = smoothstep(-8, 4, elevationDeg);
  const greyH = mixRGB(rgb('#141a26'), rgb('#c6c9c5'), dayVis);
  const greyZ = mixRGB(rgb('#0d141f'), rgb('#96a5b0'), dayVis);

  const cloudFade = 1 - smoothstep(0.5, 0.85, cloud); // discs survive light overcast
  const horizon = mixRGB(mixRGB(rgb(lo.horizon), rgb(hi.horizon), t), greyH, cloud * 0.75);
  const zenith = mixRGB(mixRGB(rgb(lo.zenith), rgb(hi.zenith), t), greyZ, cloud * 0.7);
  const fogFar = mixRGB(mixRGB(rgb(lo.fogFar), rgb(hi.fogFar), t), greyH, cloud * 0.5);
  const glow = mixRGB(mixRGB(rgb(lo.glow), rgb(hi.glow), t), horizon, cloud * 0.85);

  const sunGlow = smoothstep(-6, 0, elevationDeg) * cloudFade;
  const moon = smoothstep(2, 10, -elevationDeg) * cloudFade * mixNum(lo.moon, hi.moon, t);
  const stars = mixNum(lo.stars, hi.stars, t) * cloudFade;

  let lightI = mixNum(lo.lightI, hi.lightI, t) * (1 - 0.55 * cloud);
  if (elevationDeg < -6) lightI *= 0.15 + 0.85 * moon; // an overcast night has no moon

  return {
    horizon,
    zenith,
    glow,
    fogFar,
    lightColor: mixRGB(mixRGB(rgb(lo.light), rgb(hi.light), t), rgb('#eef0f2'), cloud * 0.6),
    lightIntensity: lightI,
    hemiSky: mixRGB(mixRGB(rgb(lo.hemiSky), rgb(hi.hemiSky), t), greyZ, cloud * 0.5),
    hemiGround: mixRGB(rgb(lo.hemiGround), rgb(hi.hemiGround), t),
    hemiIntensity: mixNum(lo.hemiI, hi.hemiI, t) * (1 - 0.15 * cloud),
    sunGlow,
    moon,
    stars,
    hazeScale: 0.75 + 0.6 * cloud,
    mist: 0.2 + 1.2 * cloud,
  };
}

function mixNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* ------------------------------------------------------------------ readouts */

/** "9:24 AM" from a day-clock hour. */
export function formatHour(hour: number): string {
  const h = Math.floor(((hour % 24) + 24) % 24);
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const am = h < 12;
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
}

/** One honest phrase for the weather, for the status line. */
export function describeWeather(cloud: number): string {
  if (cloud < 0.3) return 'clear';
  if (cloud < 0.55) return 'light cloud';
  if (cloud < 0.78) return 'broken overcast';
  return 'overcast';
}

/**
 * The status line's opening phrase: the time and the weather (and the wind,
 * when there is any — the forest's crowns say it too), then the truth about
 * the clock. A living day invites the player to pass time; a pinned or
 * postcard view is frozen by design, and must not invite a key that does
 * nothing.
 */
export function timeLine(hour: number, cloud: number, frozen: boolean, wind = 0): string {
  const breeze = describeWind(wind);
  const when = `${formatHour(hour)} · ${describeWeather(cloud)}${breeze ? `, ${breeze}` : ''}`;
  return frozen ? `${when} · the hour is pinned here` : `${when} · hold T to pass time`;
}

/**
 * The hour a postcard pins: the moment its form was opened — the moment the
 * player framed what they are saving — not whenever the Save button lands
 * after the title is typed. A full day is 24 minutes, so a minute at the
 * keyboard walks the sky a whole game-hour; the saved hour must not follow.
 */
export function postcardHour(openedHour: number | null, nowHour: number): number {
  return openedHour ?? nowHour;
}
