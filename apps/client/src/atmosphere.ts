import {
  ACESFilmicToneMapping,
  BackSide,
  Mesh,
  MeshBasicNodeMaterial,
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
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';

/** The one fixed sun (the scene's DirectionalLight points from here), normalised. */
export const SUN_DIRECTION = new Vector3(-0.45, 1, 0.3).normalize();

/** Horizon haze: the grey-green of the channel on a wet day, and the fog colour. */
const HORIZON = '#d9dcd6';
/** Overhead: the pale blue that shows through a thin overcast. */
const ZENITH = '#8fb3c9';
/** The sun, warm enough to read through the haze. */
const SUN_WARM = '#fff1d6';
/** Haze looking toward the sun picks up this warmth (aerial perspective). */
const FOG_WARM = '#efe3cf';
/** Very distant terrain blues out toward the far islands. */
const FOG_FAR = '#b9c7cf';

/** ACES is roughly neutral at 1.0: paper stays paper, only the sun clips. */
const EXPOSURE = 1.0;

/** Far beyond the 30 km haze, but inside the camera's 40 km far plane. */
const SKY_RADIUS = 35_000;

export type Atmosphere = {
  /** Call once per frame with the camera position (world, metres; y is height above sea level). */
  update(camera: { x: number; y: number; z: number }): void;
  /** Turn the far haze up for big terrain (true) or keep the old close fog (false). */
  setTerrain(on: boolean): void;
  dispose(): void;
};

export function createAtmosphere(scene: Scene, renderer: WebGPURenderer): Atmosphere {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  // A constant, so bake it into the shaders rather than feeding a uniform.
  const sun = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);

  // --- Sky dome ---------------------------------------------------------------
  // One inverted sphere, drawn first and never writing depth: a whole sky for one
  // untextured draw call and a handful of ALU ops per pixel, no background cubemap.
  const skyGeometry = new SphereGeometry(SKY_RADIUS, 32, 16);
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  skyMaterial.name = 'atmosphere-sky';

  // The dome rides with the camera, so position minus camera *is* the view direction.
  const skyDir = normalize(positionWorld.sub(cameraPosition));
  // Below the horizon smoothstep pins us to the haze colour, so any gap under far
  // terrain shows the same tint as the sky directly above it: no seam.
  const sky = mix(color(HORIZON), color(ZENITH), smoothstep(0, 0.45, skyDir.y));
  const facingSun = max(dot(skyDir, sun), 0);
  // A broad glow (wet air scatters the sun wide) plus a tight disc for the sun
  // itself. The disc pushes the mix factor past 1, which is what makes the core hot.
  const glow = pow(facingSun, 8).mul(0.35).add(pow(facingSun, 600).mul(1.5));
  skyMaterial.colorNode = mix(sky, color(SUN_WARM), glow);

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

  const rangeFog = smoothstep(nearU, farU, viewDistance);
  // Height fog: optical depth scales with exp(-y/180), so the town pools in mist
  // while the 1,000 m tops stay clear. One exp, no textures, no CPU work.
  const mist = float(1)
    .sub(exp(viewDistance.mul(-0.00012).mul(exp(max(positionWorld.y, 0).mul(-1 / 180)))))
    .mul(0.85)
    .mul(mistOn);
  const fogFactor = max(rangeFog, mist);

  // Haze colour: warmed looking into the sun, blued out at long range.
  const towardSun = pow(max(dot(viewDir, sun), 0), 4).mul(0.5);
  const haze = mix(color(HORIZON), color(FOG_WARM), towardSun);
  const fogColor = mix(haze, color(FOG_FAR), smoothstep(2000, 15000, viewDistance).mul(0.5));

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
    setTerrain(on) {
      terrain = on;
      apply();
    },
    dispose() {
      scene.remove(dome);
      skyGeometry.dispose();
      skyMaterial.dispose();
      fogScene.fogNode = null;
    },
  };
}
