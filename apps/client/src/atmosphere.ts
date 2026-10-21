import {
  ACESFilmicToneMapping,
  BackSide,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  cameraPosition,
  color,
  distance,
  dot,
  exp,
  float,
  fog,
  floor,
  fract,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import type { SkyPalette } from './sky';

/** The one fixed sun of the old world: mid-afternoon, west and south (kept as the
 *  initial value of the living sun, so a consumer that never turns the day still
 *  sees today's light). */
export const SUN_DIRECTION = new Vector3(-0.45, 1, 0.3).normalize();

/* ------------------------------------------------------ shared sky uniforms */

/**
 * Direction to the brightest body in the sky — the sun by day, the moon at
 * night. The ocean's glint and the fog's warmth read this, so they follow the
 * day without knowing about it.
 */
export const lightDirUniform = uniform(new Vector3().copy(SUN_DIRECTION));
/** Display-layer weather, 0 clear .. 1 solid overcast; cloud shadows read this. */
export const cloudUniform = uniform(0.75);
/** Multiplier for the terrain's mist banks (weather-driven). */
export const mistUniform = uniform(1);
/**
 * The scene's freezable clock, in seconds: everything that visibly moves with
 * time — the ocean's waves, surf streaks, foam drift, the star twinkle — reads
 * this instead of the renderer's own `time`, because `?t=` (and a postcard's
 * pinned hour) can only freeze the sky's elapsed clock. Feed it the same value
 * the sky accumulates and the whole scene holds still together; a live day
 * advances it at true speed, so nothing changes for a player.
 */
export const sceneTimeU = uniform(0);

/** Horizon haze: the grey-green of the channel on a wet day, and the fog colour. */
const HORIZON = '#d9dcd6';
/** Overhead: the pale blue that shows through a thin overcast. */
const ZENITH = '#8fb3c9';
/** The sun, warm enough to read through the haze. */
const SUN_WARM = '#fff1d6';
/** Very distant terrain blues out toward the far islands. */
const FOG_FAR = '#b9c7cf';

/** ACES is roughly neutral at 1.0: paper stays paper, only the sun clips. */
const EXPOSURE = 1.0;

/** Far beyond the 30 km haze, but inside the camera's 40 km far plane. */
const SKY_RADIUS = 35_000;

/** What the sky module may set from the outside, once per frame. */
export type SkyView = {
  /** Unit vector to the sun (world frame). */
  sun: readonly [number, number, number];
  /** Unit vector to the moon (world frame). */
  moon: readonly [number, number, number];
  palette: SkyPalette;
};

export type Atmosphere = {
  /** Call once per frame with the camera position (world, metres; y is height above sea level). */
  update(camera: { x: number; y: number; z: number }): void;
  /** Turn the far haze up for big terrain (true) or keep the old close fog (false). */
  setTerrain(on: boolean): void;
  /** Feed the living sky: sun, moon and palette become uniforms. */
  setSky(view: SkyView): void;
  /** Feed the freezable scene clock (seconds); the ocean and the stars read it. */
  setTime(elapsed: number): void;
  dispose(): void;
};

export function createAtmosphere(scene: Scene, renderer: WebGPURenderer): Atmosphere {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  // The day turns through these; until something calls setSky they hold the old
  // fixed wet-Sitka moment, so the world never starts unlit.
  const horizonU = uniform(new Color(HORIZON));
  const zenithU = uniform(new Color(ZENITH));
  const glowU = uniform(new Color(SUN_WARM));
  const fogFarU = uniform(new Color(FOG_FAR));
  const sunDiscU = uniform(new Vector3().copy(SUN_DIRECTION));
  const moonDiscU = uniform(new Vector3(-SUN_DIRECTION.x, 0.4, -SUN_DIRECTION.z).normalize());
  /** Sun disc/glint strength, moonlight strength, star visibility (0..1 each). */
  const sunGlowU = uniform(1);
  const moonU = uniform(0);
  const starsU = uniform(0);
  /** Fog distances divide by this (weather: hazier under overcast). */
  const hazeU = uniform(1);

  // --- Sky dome ---------------------------------------------------------------
  // One inverted sphere, drawn first and never writing depth: a whole sky for one
  // untextured draw call and a handful of ALU ops per pixel, no background cubemap.
  const skyGeometry = new SphereGeometry(SKY_RADIUS, 32, 16);
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  skyMaterial.name = 'atmosphere-sky';

  // The dome rides with the camera, so position minus camera *is* the view direction.
  const skyDir = normalize(positionWorld.sub(cameraPosition));
  // Below the horizon smoothstep pins us to the haze colour, so any gap under far
  // terrain shows the same tint as the sky directly above it: no seam. Overcast
  // flattens the gradient toward a single grey.
  const grad = smoothstep(0, 0.45, skyDir.y).mul(
    mix(float(0.45), float(1), float(1).sub(cloudUniform)),
  );
  const sky = mix(horizonU, zenithU, grad);

  // The sun: a broad glow (wet air scatters the sun wide) plus a tight disc. The
  // disc pushes the mix factor past 1, which is what makes the core hot. Overcast
  // swallows both.
  const facingSun = max(dot(skyDir, sunDiscU), 0);
  const sunGlowNode = pow(facingSun, 8).mul(0.35).add(pow(facingSun, 600).mul(1.5)).mul(sunGlowU);

  // The moon: a smaller, cooler disc opposite the day.
  const facingMoon = max(dot(skyDir, moonDiscU), 0);
  const moonDisc = pow(facingMoon, 64).mul(0.1).add(pow(facingMoon, 1200).mul(0.9)).mul(moonU);

  // Stars: hash a 3-D grid of the view direction and keep the points near each
  // cell's centre, twinkling slowly. Gated above the horizon and faded by cloud.
  const cells = skyDir.mul(200);
  const rnd = fract(sin(dot(floor(cells), vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  const inCell = fract(cells).sub(0.5);
  const star = float(1)
    .sub(smoothstep(0, 0.09, dot(inCell, inCell)))
    .mul(step(0.82, rnd))
    .mul(
      sin(sceneTimeU.mul(2).add(rnd.mul(40)))
        .mul(0.25)
        .add(0.75),
    )
    .mul(smoothstep(0.02, 0.15, skyDir.y))
    .mul(starsU);

  skyMaterial.colorNode = mix(sky, glowU, sunGlowNode)
    .add(vec3(moonDisc).mul(color('#e8edf6')))
    .add(vec3(star));

  const dome = new Mesh(skyGeometry, skyMaterial);
  dome.name = 'atmosphere-sky';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  scene.add(dome);
  scene.background = null; // the dome replaces it

  // --- Fog --------------------------------------------------------------------
  // Range fog and valley mist share one Fog node, so there is still only one fog
  // mix per fragment. The distances live in uniforms: retuning them costs nothing.
  const nearU = uniform(80);
  const farU = uniform(520);
  const mistOn = uniform(0);

  const viewDistance = distance(cameraPosition, positionWorld);
  const viewDir = normalize(positionWorld.sub(cameraPosition));

  const rangeFog = smoothstep(nearU.div(hazeU), farU.div(hazeU), viewDistance);
  // Height fog: optical depth scales with exp(-y/180), so the town pools in mist
  // while the 1,000 m tops stay clear. One exp, no textures, no CPU work.
  const mist = float(1)
    .sub(exp(viewDistance.mul(-0.00012).mul(exp(max(positionWorld.y, 0).mul(-1 / 180)))))
    .mul(0.85)
    .mul(mistOn)
    .mul(mistUniform);
  const fogFactor = max(rangeFog, mist);

  // Haze colour: warmed looking into the light, blued out at long range.
  const towardLight = pow(max(dot(viewDir, lightDirUniform), 0), 4).mul(0.5);
  const haze = mix(horizonU, glowU, towardLight);
  const fogColor = mix(haze, fogFarU, smoothstep(2000, 15000, viewDistance).mul(0.5));

  const fogNode = fog(fogColor, fogFactor);
  // three 0.186 reads `scene.fogNode` before `scene.fog`; the field is not in the
  // public Scene type yet, so we write it through a narrow structural view.
  const fogScene = scene as unknown as { fogNode: unknown };
  fogScene.fogNode = fogNode;
  scene.fog = null; // keeping both would fog everything twice

  // --- State ------------------------------------------------------------------
  let terrain = false;
  let eye = 0;

  // Two fog curves: the original close fog for the paper world, a much longer one
  // once real terrain (and mountains 20 km out) is on screen.
  const apply = () => {
    if (terrain) {
      nearU.value = 400 + 4 * eye;
      farU.value = Math.min(30_000, 9000 + 20 * eye);
    } else {
      nearU.value = 80 + 2 * eye;
      farU.value = 520 + 6 * eye;
    }
    mistOn.value = terrain ? 1 : 0;
  };

  return {
    update(camera) {
      dome.position.set(camera.x, camera.y, camera.z);
      // Fog heights are measured from sea level; below it, nothing changes.
      eye = Math.max(0, camera.y);
      apply();
    },
    setTime(elapsed) {
      sceneTimeU.value = elapsed;
    },
    setTerrain(on) {
      terrain = on;
      apply();
    },
    setSky({ sun, moon, palette }) {
      sunDiscU.value.set(sun[0], sun[1], sun[2]);
      moonDiscU.value.set(moon[0], moon[1], moon[2]);
      // By day the strongest light is the sun; by night, the moon.
      lightDirUniform.value.set(...(palette.moon > palette.sunGlow ? moon : sun));
      // Palette colours are sRGB triples; the uniforms live in three's working
      // (linear) space, exactly like the old baked `color('#…')` constants.
      horizonU.value.setRGB(...palette.horizon, SRGBColorSpace);
      zenithU.value.setRGB(...palette.zenith, SRGBColorSpace);
      glowU.value.setRGB(...palette.glow, SRGBColorSpace);
      fogFarU.value.setRGB(...palette.fogFar, SRGBColorSpace);
      sunGlowU.value = palette.sunGlow;
      moonU.value = palette.moon;
      starsU.value = palette.stars;
      hazeU.value = palette.hazeScale;
      cloudUniform.value = cloudOf(palette);
      mistUniform.value = palette.mist;
    },
    dispose() {
      scene.remove(dome);
      skyGeometry.dispose();
      skyMaterial.dispose();
      fogScene.fogNode = null;
    },
  };
}

/** Cloud cover back out of a palette: how far hazeScale sits from its clear end. */
function cloudOf(p: SkyPalette): number {
  return Math.max(0, Math.min(1, (p.hazeScale - 0.75) / 0.6));
}
