import { MeshStandardNodeMaterial, Vector3, type Node } from 'three/webgpu';
import {
  cameraPosition,
  color,
  cos,
  distance,
  dot,
  float,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  vec3,
} from 'three/tsl';

/* ------------------------------------------------------------------ waves */

/**
 * Four directional sine waves, fixed wavelengths and angles so the pattern is
 * deterministic. Amplitudes shrink with wavelength and phase speeds follow the
 * deep-water relation c = √(g/k), so what you see is what real swell looks like
 * at this scale rather than a single uniform ripple.
 */
type Wave = { readonly lambda: number; readonly angle: number; readonly amplitude: number };

const WAVES: readonly Wave[] = [
  { lambda: 7, angle: 0.4, amplitude: 0.05 },
  { lambda: 13, angle: 1.1, amplitude: 0.04 },
  { lambda: 29, angle: -0.3, amplitude: 0.025 },
  { lambda: 61, angle: 2.4, amplitude: 0.015 },
];

/** Analytic gradient of one wave component, so the normal can be built from it. */
function waveSlope(w: Wave): { dhx: Node<'float'>; dhz: Node<'float'> } {
  const k = (2 * Math.PI) / w.lambda;
  const omega = Math.sqrt(9.81 * k);
  const cx = Math.cos(w.angle);
  const cz = Math.sin(w.angle);
  const phase = positionWorld.x
    .mul(k * cx)
    .add(positionWorld.z.mul(k * cz))
    .sub(time.mul(omega));
  return {
    dhx: float(w.amplitude * k * cx).mul(cos(phase)),
    dhz: float(w.amplitude * k * cz).mul(cos(phase)),
  };
}

/* ------------------------------------------------------------------ ocean */

/**
 * The ocean's material: flat plane at y = 0, any size, following the camera.
 * The ripple normal is the analytic gradient of the four-wave height field,
 * transformed to view space because that is what the lighting stage expects.
 * Sun glint is emissive rather than specular: no env map, but the highlight
 * still reads. Far water fades to flat so the horizon does not shimmer.
 */
export function oceanMaterial(sun: Vector3): MeshStandardNodeMaterial {
  let dhx: Node<'float'> = float(0);
  let dhz: Node<'float'> = float(0);
  for (const w of WAVES) {
    const s = waveSlope(w);
    dhx = dhx.add(s.dhx);
    dhz = dhz.add(s.dhz);
  }
  // Scale the ripple (not the y-component) so far water becomes a true flat plane
  // rather than a horizontal vector with an undefined direction after normalize.
  const reach = float(1).sub(smoothstep(800, 2000, distance(cameraPosition, positionWorld)));

  const worldNormal = normalize(vec3(dhx.mul(reach).negate(), float(1), dhz.mul(reach).negate()));
  const viewNormal = normalize(transformNormalToView(worldNormal));

  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const fresnel = pow(float(1).sub(max(dot(viewDir, worldNormal), float(0))), 4);

  const sunDir = vec3(sun.x, sun.y, sun.z);
  const reflectDir = reflect(viewDir.negate(), worldNormal);
  const glint = pow(max(dot(reflectDir, sunDir), float(0)), 180).mul(2.5);

  const m = new MeshStandardNodeMaterial({ roughness: 0.18, metalness: 0 });
  m.colorNode = mix(color('#1f4552'), color('#6f97a8'), fresnel);
  m.normalNode = viewNormal;
  m.emissiveNode = color('#fff4e0').mul(glint);
  m.name = 'ocean';
  return m;
}

/* ------------------------------------------------------------------ foam */

/**
 * 0..0.7 white foam on land just above the waterline (0–0.6 m), breathing with the waves.
 * `wave` rides the surf up and down the beach; drifting streaks break the
 * smooth band into patches so the shore reads as broken water rather than a stripe.
 */
export function shoreFoam(height: Node<'float'>, world: Node<'vec3'>): Node<'float'> {
  const wave = sin(time.mul(0.8).add(world.x.mul(0.05)).add(world.z.mul(0.035))).mul(0.25);
  // A narrow band: low-lying waterfront (a whole downtown can sit 0–2 m up) stays dry.
  const band = float(1).sub(smoothstep(0.05, 0.6, height.sub(wave)));
  const lower = smoothstep(-0.2, 0.1, height);
  // Streaks from three incommensurate, rotated, drifting waves: no visible tiling,
  // unlike a product of two axis-aligned sines (which reads as a checkerboard).
  const streaks = sin(world.x.mul(0.13).add(world.z.mul(0.07)).add(time.mul(0.5)))
    .add(sin(world.z.mul(0.21).sub(world.x.mul(0.05))).mul(0.7))
    .add(sin(world.x.add(world.z).mul(0.37).sub(time.mul(0.9))).mul(0.4));
  const patch = smoothstep(-0.8, 0.8, streaks);
  return band.mul(lower).mul(patch).mul(0.7);
}

/* ------------------------------------------------------------------ clouds */

/**
 * A multiplier 0.78..1 for diffuse colour: two octaves of product-of-sines drifting
 * south-west→north-east at ~6 m/s. Smoothstep keeps most land fully lit and ~30% in
 * soft shadow, so the variation is gentle enough not to fight the topo palette.
 */
export function cloudShadow(world: Node<'vec3'>): Node<'float'> {
  const drift = time.mul(6);
  const twoPi = 2 * Math.PI;
  const a = sin(world.x.sub(drift).mul(twoPi / 1800)).mul(
    sin(world.z.add(drift).mul(twoPi / 1800)),
  );
  const b = sin(world.x.sub(drift).mul(twoPi / 700)).mul(sin(world.z.add(drift).mul(twoPi / 700)));
  const lit = smoothstep(-0.3, 0.5, a.mul(0.6).add(b.mul(0.4)));
  return mix(float(0.78), float(1), lit);
}

/* ------------------------------------------------------------------ mist */

/**
 * 0..1 mist on mountainsides: soft banks that hang between 150 and 650 m, thickest around
 * 300–400 m, broken into drifting streamers. The caller mixes the ground colour toward the
 * haze colour by this amount.
 */
export function mistBanks(height: Node<'float'>, world: Node<'vec3'>): Node<'float'> {
  // Drift enters the phase with a positive sign, so peaks migrate toward smaller x (west)
  // and smaller z (which is -north in the local frame, i.e. north-west). With the
  // wavelengths below the magnitude is ≈ 3 m/s.
  const drift = time.mul(0.025);
  // Three rotated, drifting sines — summed, never multiplied, so the field reads as
  // streamers rather than axis-aligned bumps or a checkerboard.
  const a = sin(
    world.x
      .mul((2 * Math.PI) / 700)
      .add(world.z.mul((2 * Math.PI) / 1100))
      .add(drift),
  );
  const b = sin(
    world.z
      .mul((2 * Math.PI) / 600)
      .sub(world.x.mul((2 * Math.PI) / 1300))
      .add(drift.mul(0.7)),
  ).mul(0.65);
  const c = sin(
    world.x
      .add(world.z)
      .mul((2 * Math.PI) / 450)
      .sub(drift.mul(0.3)),
  ).mul(0.35);
  const streamers = a.add(b).add(c);
  // Hang between 150 and 650 m: nothing below the cloud base, full around 300–400 m,
  // cleared again before the summits.
  const envelope = smoothstep(150, 300, height).mul(float(1).sub(smoothstep(400, 650, height)));
  // A wide ramp: mist has no edges, only thinner and thicker parts.
  return envelope.mul(smoothstep(-1.8, 1.6, streamers));
}

/* ------------------------------------------------------------------ snow */

/**
 * 0..1 snow cover: above a snow line that wobbles between about 950 and 1100 m, less on steep
 * slopes (snow slides off rock: none above slope 0.75), and patchy near the line.
 * `slope` is 1 - normalWorld.y.
 */
export function snowCover(
  height: Node<'float'>,
  slope: Node<'float'>,
  world: Node<'vec3'>,
): Node<'float'> {
  // Wobbly snow line, 950..1100 m: two rotated, incommensurate sines sum to ±~75 m of
  // jitter around 1025, so the boundary does not look like a single contour.
  const wobble = sin(world.x.mul((2 * Math.PI) / 1300).add(world.z.mul((2 * Math.PI) / 1700)))
    .mul(45)
    .add(sin(world.z.sub(world.x).mul((2 * Math.PI) / 950)).mul(30));
  const snowLine = float(1025).add(wobble);
  // Snow slides off rock: full cover on flats, gone by slope 0.75.
  const onSlope = float(1).sub(smoothstep(0.45, 0.75, slope));
  // Patchiness near the line, solid higher up. Three rotated, incommensurate sines; no
  // `time` — snow does not drift, the pattern stays put.
  const streak = sin(world.x.mul((2 * Math.PI) / 900).add(world.z.mul((2 * Math.PI) / 1200)))
    .add(sin(world.z.mul((2 * Math.PI) / 700).sub(world.x.mul((2 * Math.PI) / 1400))).mul(0.7))
    .add(sin(world.x.add(world.z).mul((2 * Math.PI) / 500)).mul(0.4));
  // `coverage` ramps from 0 just below the line to 1 by +80 m; `gap` is 0 near the line
  // and 1 well above, so the patch mask only bites in the lower ~120 m.
  const coverage = smoothstep(snowLine.sub(20), snowLine.add(80), height);
  const gap = smoothstep(snowLine.add(60), snowLine.add(180), height);
  const patch = smoothstep(-0.5, 0.7, streak);
  return coverage.mul(onSlope).mul(gap.add(patch.mul(float(1).sub(gap))));
}
