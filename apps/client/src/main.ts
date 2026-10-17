import {
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { cellAt, DEMO_CELL } from '@otherhere/core';
import { World } from './world';
import { WalkControls } from './walk';
import { PAPER } from './material';
import { formatPose, parseCoords, parsePose, parseStart, type Pose } from './url';

const SKY = '#e7e2d8';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('view');
const statusEl = $('status');
const form = $<HTMLFormElement>('goto');
const input = $<HTMLInputElement>('coords');
const errorEl = $('coords-error');

// --- Coordinates form ---------------------------------------------------------
const start = parseStart(location.search);
if (start && 'lat' in start) input.value = `${start.lat}, ${start.lng}`;
input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  errorEl.hidden = true;
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = parseCoords(input.value);
  if (!c) {
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = 'Enter latitude and longitude, like 47.3769, 8.5417.';
    errorEl.hidden = false;
    input.focus();
    return;
  }
  location.assign(`?at=${c.lat},${c.lng}`);
});
$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    errorEl.textContent = 'This browser cannot share its location. Type coordinates instead.';
    errorEl.hidden = false;
    return;
  }
  statusEl.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (p) => location.assign(`?at=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`),
    () => {
      statusEl.textContent = '';
      errorEl.textContent = 'Location was not shared. Type coordinates instead.';
      errorEl.hidden = false;
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});
$('demo').addEventListener('click', () => location.assign('?demo=generators'));

// --- Scene ---------------------------------------------------------------------
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL2';

const scene = new Scene();
scene.background = new Color(SKY);
scene.fog = new Fog(SKY, 80, 520);
scene.add(new HemisphereLight('#f6f2ea', '#b7ab92', 1.7));
const sun = new DirectionalLight('#fff4e2', 1.9);
sun.position.set(-0.45, 1, 0.3); // fixed: the same light on every device
scene.add(sun);
const ground = new Mesh(
  new CircleGeometry(5000, 48),
  new MeshStandardNodeMaterial({ color: PAPER, roughness: 1, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
scene.add(ground);

const camera = new PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 3000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- World -----------------------------------------------------------------------
const isDemo = !!start && 'demo' in start;
const originCell = isDemo
  ? DEMO_CELL
  : start && 'lat' in start
    ? cellAt(start.lat, start.lng)
    : null;

if (!originCell) {
  statusEl.textContent = `${backend} · Enter coordinates to walk a place.`;
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  camera.position.set(0, 40, 80);
  camera.lookAt(0, 0, 0);
} else {
  const world = new World(scene, originCell, isDemo ? 'demo' : 'api');
  const saved = parsePose(location.hash);
  let spawned = !!saved;
  // Start at the exact point typed (not the Cell centre), at eye height.
  const startAt = start && 'lat' in start ? world.frame.project(start) : { e: 0, n: 0 };
  // The demo opens on an overview of the test lot from the south-west.
  const initial: Pose =
    saved ??
    (isDemo
      ? { x: -42, y: 18, z: 52, yaw: -0.5, pitch: -0.3 }
      : { x: startAt.e, y: 1.7, z: -startAt.n, yaw: 0, pitch: 0 });
  spawned ||= isDemo;
  const walk = new WalkControls(camera, canvas, initial);

  const showStatus = () => {
    const s = world.stats();
    const lines = [
      `${backend} · ${s.ready} cell${s.ready === 1 ? '' : 's'}${s.loading ? ` (+${s.loading} loading)` : ''} · ${s.features.toLocaleString()} features`,
      `${s.verified}/${s.ready} bundle hashes verified${s.mismatched ? ` · ${s.mismatched} MISMATCHED` : ''}`,
    ];
    if (s.sketch) {
      const are = s.sketch === 1 ? '1 cell is' : `${s.sketch} cells are`;
      lines.push(`${are} still a sketch: OpenStreetMap was unreachable. Reload to retry.`);
    }
    if (s.errors)
      lines.push(`${s.errors} cell${s.errors === 1 ? '' : 's'} failed to load. Reload to retry.`);
    statusEl.textContent = lines.join('\n');
    (window as unknown as { __otherhere: unknown }).__otherhere = {
      stats: s,
      backend,
      pose: walk.pose,
    };
  };
  world.onChange = () => {
    // On first arrival (no saved pose), step onto the nearest road so we don't start inside a wall.
    if (!spawned && world.isReady(world.cellAtWorld(walk.pose.x, walk.pose.z))) {
      spawned = true;
      const road = world.nearestRoad(walk.pose.x, walk.pose.z);
      if (road && Math.hypot(road.x - walk.pose.x, road.z - walk.pose.z) < 120) {
        walk.pose.x = road.x;
        walk.pose.z = road.z;
      }
    }
    showStatus();
  };

  let last = performance.now();
  let lastHash = 0;
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const moved = walk.update(dt);
    world.update(walk.pose.x, walk.pose.z);
    // Higher up, see further: the fog recedes as you rise.
    const fog = scene.fog as Fog;
    fog.near = 80 + walk.pose.y * 2;
    fog.far = 520 + walk.pose.y * 6;
    if (moved && now - lastHash > 400) {
      history.replaceState(null, '', formatPose(walk.pose));
      lastHash = now;
    }
    renderer.render(scene, camera);
  });
  showStatus();
}
