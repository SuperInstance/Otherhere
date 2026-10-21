import {
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import {
  capsuleBundleInputs,
  cellAt,
  cellCenter,
  cellRing,
  DEMO_CELL,
  FOREST_BIOMES,
  forestBiome,
  generatorSet,
  generatorsMatch,
  localFrame,
  type Capsule,
  type MatchState,
  type ResolvedAttrs,
  type SessionInfo,
  type Team,
} from '@otherhere/core';
import { Arrival, establishingShot } from './arrival';
import { createAtmosphere } from './atmosphere';
import {
  clockHour,
  cloudCover,
  DAY_OF_YEAR,
  DAY_START_HOUR,
  moonDirection,
  postcardHour,
  skyPalette,
  skyStep,
  sunDirection,
  sunPosition,
} from './sky';
import { Forest } from './forest';
import { World } from './world';
import { windStrength } from './wind';
import { Terrain, type TerrainMode } from './terrain';
import { SessionClient } from './net';
import { describeEvent, MatchView, TEAM_NAMES } from './match';
import { describeFacts, photoToJpegBase64, questLine, questsDone } from './feature';
import { learnFromWalk } from './capture';
import { composeStatus, LoadAnnouncer, StatusLine } from './status';
import { WalkControls } from './walk';
import { PAPER } from './material';
import {
  DEFAULT_PLACE,
  formatPose,
  parseCoords,
  parsePose,
  parseStart,
  parseTime,
  type Pose,
} from './url';

const SKY = '#e7e2d8';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('view');
const statusLine = new StatusLine($('status-moment'), $('status'), $('status-cells'), (text) => {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
});
const announceEl = $('announce');
const announcer = new LoadAnnouncer((text) => {
  // Clear first, then say it on a later tick: a live region that repeats the
  // same words needs a real change between episodes for readers to re-say it.
  announceEl.replaceChildren();
  setTimeout(() => (announceEl.textContent = text), 60);
});
const form = $<HTMLFormElement>('goto');
const input = $<HTMLInputElement>('coords');
const errorEl = $('coords-error');

// --- Coordinates form ---------------------------------------------------------
// Phones: the panel starts compact (address and one status line); this opens the rest.
const hud = $('hud');
const hudMore = $<HTMLButtonElement>('hud-more');
hudMore.addEventListener('click', () => {
  const open = hud.classList.toggle('expanded');
  hudMore.setAttribute('aria-expanded', String(open));
  hudMore.textContent = open ? 'Fewer options' : 'More options';
});

const start = parseStart(location.search);
/** The address the place was found by, if it was typed rather than given as coordinates. */
const typed = new URLSearchParams(location.search).get('q')?.slice(0, 200) ?? '';
if (start && 'lat' in start) input.value = typed || `${start.lat}, ${start.lng}`;
input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  errorEl.hidden = true;
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fail = (message: string) => {
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.focus();
  };
  const c = parseCoords(input.value);
  if (c) return location.assign(`?at=${c.lat},${c.lng}`);
  const q = input.value.trim();
  if (!q) return fail('Type an address, a place name, or coordinates like 57.0531, -135.3351.');
  // Anything that is not coordinates is looked up as an address or place (OpenStreetMap).
  const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
  button.disabled = true;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const body = (await res.json()) as { lat?: number; lng?: number; error?: string };
    if (!res.ok || body.lat === undefined || body.lng === undefined)
      return fail(
        body.error ?? 'Could not find that place. Try adding the town, or use coordinates.',
      );
    // Keep what was typed in the link, so the box (and a shared link) shows the place by name.
    location.assign(
      `?at=${body.lat.toFixed(6)},${body.lng.toFixed(6)}&q=${encodeURIComponent(q.slice(0, 200))}`,
    );
  } catch {
    fail('Could not reach the server. Check your connection, or use coordinates.');
  } finally {
    button.disabled = false;
  }
});
$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    errorEl.textContent = 'This browser cannot share its location. Type coordinates instead.';
    errorEl.hidden = false;
    return;
  }
  statusLine.boot('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (p) => location.assign(`?at=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`),
    () => {
      statusLine.boot('');
      errorEl.textContent = 'Location was not shared. Type coordinates instead.';
      errorEl.hidden = false;
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});
$('demo').addEventListener('click', () => location.assign('?demo=generators'));

// --- Scene ---------------------------------------------------------------------
// A logarithmic depth buffer keeps roads on hillsides and mountains 20 km away both crisp.
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL2';

const scene = new Scene();
scene.background = new Color(SKY);
// Sky dome, valley mist and filmic tone mapping: a few ALU ops per pixel, no extra passes.
const atmosphere = createAtmosphere(scene, renderer);
const hemi = new HemisphereLight('#f6f2ea', '#b7ab92', 1.7);
scene.add(hemi);
const sun = new DirectionalLight('#fff4e2', 1.9);
sun.position.set(-0.45, 1, 0.3); // the mid-afternoon sun until the day clock speaks
scene.add(sun);
const ground = new Mesh(
  new CircleGeometry(5000, 48),
  new MeshStandardNodeMaterial({ color: PAPER, roughness: 1, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
scene.add(ground);

const camera = new PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 40_000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Session (optional) ------------------------------------------------------------
// A match pins the world origin to the session's origin, so every player shares one frame.
let sessionInfo: SessionInfo | null = null;
if (start && 'session' in start) {
  try {
    const res = await fetch(`/api/sessions/${start.session}`);
    if (res.ok) sessionInfo = ((await res.json()) as { info: SessionInfo }).info;
  } catch {
    // handled below
  }
  if (!sessionInfo) {
    errorEl.textContent = `No match with code ${start.session}. Check the code, or start a new match.`;
    errorEl.hidden = false;
  }
}

// --- Postcard (optional) -----------------------------------------------------------
let capsule: Capsule | null = null;
if (start && 'capsule' in start) {
  const q = start.key ? `?k=${encodeURIComponent(start.key)}` : '';
  try {
    const res = await fetch(`/api/capsules/${start.capsule}${q}`);
    if (res.ok) capsule = (await res.json()) as Capsule;
  } catch {
    // handled below
  }
  if (!capsule) {
    errorEl.textContent =
      'This postcard does not exist, or it is private. Check the link with whoever shared it.';
    errorEl.hidden = false;
  } else {
    // A postcard opens as a gift, not a dashboard (playtest r5, lane C: the
    // recipient's view shipped "a debugging console taped to the postcard").
    // The address box and the technical status lines wait behind More
    // options; the title, the moment, and the invitation to walk stay.
    hud.classList.add('gift');
  }
}

// --- World -----------------------------------------------------------------------
const isDemo = !!start && 'demo' in start;
const place =
  start && 'lat' in start
    ? start
    : (sessionInfo?.origin ?? capsule?.view?.center ?? (start ? null : DEFAULT_PLACE));
if (place && !isDemo)
  input.value = (start && 'lat' in start && typed) || `${place.lat}, ${place.lng}`;
const originCell = isDemo
  ? DEMO_CELL
  : capsule
    ? capsule.cells[0]!
    : place
      ? cellAt(place.lat, place.lng)
      : null;

// --- The day turns ---------------------------------------------------------------
// A living sky, deterministic by construction: the clock counts elapsed render
// time (never the wall clock — the same class of time-dependence as the waves
// and drifting cloud shadows), so the same elapsed second is the same sky on
// every device and again after a reload. Every visit opens at mid-morning; a
// full day passes in 24 minutes. Hold T to run the clock faster; `?t=21.5`
// pins the start hour. Weather drifts on the same clock, with the biome's
// prior (ADR-0017's box): Sitka sits under heavier skies than Zürich.
const skyStart = parseTime(location.search) ?? DAY_START_HOUR;
const skyAt = place ?? DEFAULT_PLACE;
const skyBiome = forestBiome(skyAt.lat, skyAt.lng);
// A pinned `?t=21.5` freezes the clock at that hour (a director's cut: the
// same sky for a screenshot, a test, or a postcard link, forever), and a
// capsule is a remembered moment (CONTEXT.md: a Memory, kept at full
// fidelity), so its sky never turns either — whoever opens a postcard sees
// the hour it was saved, pinned in the link. Everything else keeps living.
const skyFrozen = parseTime(location.search) !== null || !!capsule;
// The freeze is decided here, at boot, and never toggles: a pinned view is
// frozen from its first frame, so the scene clock (and with it every wave and
// drift) starts and stays at 0 — every opening of a pinned link shares the
// same phase. If the freeze ever becomes dynamic, that guarantee is gone.
let skyElapsed = 0;
let skyFast = false;
let skyNow = { hour: skyStart, elevation: 0, cloud: 0, wind: 0 };
addEventListener('keydown', (e) => {
  if (e.code === 'KeyT' && !(e.target instanceof HTMLInputElement)) skyFast = true;
});
addEventListener('keyup', (e) => {
  if (e.code === 'KeyT') skyFast = false;
});
// The sky keeps its own, looser step bound than the walk physics (skyStep),
// so a slow renderer still sees the day turn at true speed.
const updateSky = (rawDt: number) => {
  skyElapsed += skyStep(rawDt, skyFast, skyFrozen);
  // Everything that moves with time rides the sky's clock — the ocean's waves,
  // the cloud shadows, the mist banks, the star twinkle — so a pinned ?t= (or a
  // postcard's hour) holds the whole scene still, not just the sky's colours.
  atmosphere.setTime(skyElapsed);
  const hour = clockHour(skyStart, skyElapsed);
  const sunDir = sunDirection(skyAt.lat, DAY_OF_YEAR, hour);
  const moonDir = moonDirection(sunDir);
  const { elevation } = sunPosition(skyAt.lat, DAY_OF_YEAR, hour);
  // The weather belongs to the hour (cloudCover), so it travels with a pinned
  // ?t= and freezes inside a postcard along with the hour the link pins.
  const cloud = cloudCover(hour, skyBiome);
  const p = skyPalette(elevation, cloud);
  atmosphere.setSky({ sun: sunDir, moon: moonDir, palette: p });
  // The scene's light is the strongest body in the sky: sun by day, moon at night.
  const light = p.moon > p.sunGlow ? moonDir : sunDir;
  sun.position.set(light[0] * 100, light[1] * 100, light[2] * 100);
  sun.color.setRGB(...p.lightColor, SRGBColorSpace);
  sun.intensity = p.lightIntensity;
  hemi.color.setRGB(...p.hemiSky, SRGBColorSpace);
  hemi.groundColor.setRGB(...p.hemiGround, SRGBColorSpace);
  hemi.intensity = p.hemiIntensity;
  // The wind reads the same weather: still air under overcast, gusts when clear.
  skyNow = { hour, elevation, cloud, wind: windStrength(skyElapsed, cloud) };
};

if (!originCell) {
  statusLine.boot(`${backend} · Enter coordinates to walk a place.`);
  renderer.setAnimationLoop(() => {
    updateSky(1 / 60);
    renderer.render(scene, camera);
  });
  camera.position.set(0, 40, 80);
  camera.lookAt(0, 0, 0);
} else {
  // Real places stand on real ground; the generator demo stays on its flat test lot.
  const mapParam = new URLSearchParams(location.search).get('map');
  const terrain = isDemo
    ? null
    : new Terrain(scene, localFrame(cellCenter(originCell)), {
        mode: mapParam === 'satellite' ? 'satellite' : 'topo',
      });
  const world = new World(
    scene,
    originCell,
    isDemo ? 'demo' : capsule ? { capsule: capsuleBundleInputs(capsule) } : 'api',
    terrain ?? undefined,
  );
  // Spruce and hemlock on the hills: display-only, seeded per chunk, kept out of
  // buildings and roads, replanted as finer ground or new Bundles arrive.
  const forest = terrain
    ? new Forest(scene, terrain, {
        occupied: (x, z) => world.occupied(x, z),
        density: (x, z) => {
          // The coastal rainforest is forest until Facts say otherwise; elsewhere,
          // scattered woods. Either way, town centres thin out around their buildings.
          // Nothing grows where the town is not known yet: those chunks replant when
          // their Cell's Bundle arrives (world.onBuilt), instead of trees popping out.
          if (!world.settled(x, z)) return 0;
          const p = world.frame.unproject({ e: x, n: -z });
          const wild = FOREST_BIOMES[forestBiome(p.lat, p.lng)].wild;
          return (wild ? 1 : 0.05) / (1 + world.builtUp(x, z) / 3);
        },
        // Phones and tablets get a smaller, sparser forest: same seeds, fewer chunks.
        ...(matchMedia('(pointer: coarse)').matches ? { radius: 900, maxTrees: 9000 } : {}),
      })
    : null;
  if (terrain && forest) {
    const standCells = terrain.onGround;
    terrain.onGround = (...rect) => {
      standCells(...rect);
      forest.invalidate(...rect);
    };
    world.onBuilt = (...rect) => forest.invalidate(...rect);
  }
  const pose = capsule?.view?.pose;
  const saved =
    parsePose(location.hash) ??
    (pose ? { x: pose[0], y: pose[1], z: pose[2], yaw: pose[3], pitch: pose[4] } : null);
  let spawned = !!saved;
  // Start at the exact point typed (not the Cell centre), at eye height.
  const startAt = place ? world.frame.project(place) : { e: 0, n: 0 };
  const street: Pose = { x: startAt.e, y: 1.7, z: -startAt.n, yaw: 0, pitch: 0 };
  // A first visit to a real place opens on an establishing shot and glides down to the
  // street. Any input takes over; without terrain (tiles unreachable) it snaps to the street.
  // Not in a match: players start at their team's base, not on a sightseeing flight.
  const arriving = !saved && !isDemo && !capsule && !sessionInfo && !!terrain;
  // The demo opens on an overview of the test lot from the south-west.
  const initial: Pose =
    saved ??
    (isDemo
      ? { x: -42, y: 18, z: 52, yaw: -0.5, pitch: -0.3 }
      : arriving
        ? establishingShot(street)
        : street);
  spawned ||= isDemo;
  const walk = new WalkControls(camera, canvas, initial);
  // Land facing the way we flew in (toward town and the mountains), not at a fixed north.
  if (arriving) street.yaw = initial.yaw;
  let arrival: Arrival | null = arriving ? new Arrival(initial, street) : null;
  const takeOver = () => (arrival = null);
  for (const type of ['keydown', 'pointerdown', 'wheel'] as const)
    addEventListener(type, takeOver, { once: true, passive: true });
  if (terrain) {
    walk.groundAt = (x, z) => terrain.standAt(x, z);
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || e.target instanceof HTMLInputElement) return;
      terrain.mode = terrain.mode === 'topo' ? 'satellite' : ('topo' satisfies TerrainMode);
      showStatus();
    });
  }

  const showStatus = () => {
    const s = world.stats();
    announcer.update(s.loading, s.ready);
    statusLine.update(
      composeStatus({
        backend,
        stats: s,
        sky: skyNow,
        skyFrozen,
        terrain: terrain ?? null,
        capsule,
        generatorsCurrent,
        questsDone: questsDone.get(),
      }),
    );
    (window as unknown as { __otherhere: unknown }).__otherhere = {
      stats: s,
      quests: world.questTargets(),
      backend,
      pose: walk.pose,
      sky: skyNow,
      terrain: terrain && {
        ...terrain.stats(),
        active: terrain.active,
        ground: terrain.heightAt(walk.pose.x, walk.pose.z),
        stand: terrain.standAt(walk.pose.x, walk.pose.z),
        eye: camera.position.y,
      },
      forest: forest && { ...forest.stats(), settled: forest.settled(), wind: forest.wind() },
      session: session && {
        code: session.code,
        me: session.me,
        phase: matchView?.match?.phase,
        score: matchView?.match?.score,
        peers: [...session.peers.values()].map((p) => ({
          id: p.info.id,
          team: p.info.team,
          x: p.x,
          z: p.z,
          via: p.via,
          channel: p.dc?.readyState ?? null,
          visible: matchView!.visibleIds.has(p.info.id),
        })),
      },
    };
  };

  let generatorsCurrent = true;
  if (capsule)
    void generatorSet()
      .refs()
      .then((refs) => (generatorsCurrent = generatorsMatch(capsule!, refs)));

  // --- Postcards ------------------------------------------------------------------
  const pcForm = $<HTMLFormElement>('postcard');
  const pcResult = $('pc-result');
  pcForm.hidden = isDemo || !!sessionInfo || !!capsule;
  // The hour this postcard will pin is read when the player opens the form —
  // the moment they framed what they are saving. Typing a title must not walk
  // the saved hour away from that sky (a full day is 24 minutes).
  let pcOpenedHour: number | null = null;
  pcForm.querySelector('details')!.addEventListener('toggle', (e) => {
    if ((e.target as HTMLDetailsElement).open) pcOpenedHour = skyNow.hour;
  });
  pcForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = pcForm.querySelector('button')!;
    btn.disabled = true;
    pcResult.textContent = 'Saving…';
    const here = world.frame.unproject({ e: walk.pose.x, n: -walk.pose.z });
    const cell = world.cellAtWorld(walk.pose.x, walk.pose.z);
    const cells = cellRing(cell, 1);
    // The postcard's frame is centred on its first Cell (where we stand); re-express our pose in it.
    const q = localFrame(cellCenter(cells[0]!)).project(here);
    const pose = [q.e, walk.pose.y, -q.n, walk.pose.yaw, walk.pose.pitch].map((n) =>
      Number(n.toFixed(3)),
    );
    const res = await fetch('/api/capsules', {
      method: 'POST',
      body: JSON.stringify({
        title:
          $<HTMLInputElement>('pc-title').value.trim() ||
          `A walk at ${here.lat.toFixed(4)}, ${here.lng.toFixed(4)}`,
        scope: $<HTMLSelectElement>('pc-scope').value,
        cells,
        center: { lat: Number(here.lat.toFixed(6)), lng: Number(here.lng.toFixed(6)) },
        pose,
      }),
    });
    btn.disabled = false;
    if (!res.ok) {
      pcResult.textContent = 'Could not save the postcard. Try again in a moment.';
      return;
    }
    const { id, ownerKey, scope } = (await res.json()) as {
      id: string;
      ownerKey: string;
      scope: string;
    };
    const url = `${location.origin}/?c=${id}${scope === 'private' ? `&k=${ownerKey}` : ''}&t=${postcardHour(pcOpenedHour, skyNow.hour).toFixed(2)}`;
    pcResult.textContent = '';
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    pcResult.append(
      scope === 'private'
        ? 'Saved. Only this link opens it, so keep it safe: '
        : 'Saved. Share this link: ',
      a,
    );
    try {
      await navigator.clipboard.writeText(url);
      pcResult.append(' (copied)');
    } catch {
      // clipboard unavailable; the link is shown
    }
  });

  // --- Building details and photos --------------------------------------------------
  // Tap a building in the live World to see what is known about it and add a photo.
  if (!isDemo && !capsule) {
    const panel = $('feature');
    const title = $('feature-title');
    const factsEl = $('feature-facts');
    const result = $('feature-result');
    const questEl = $('feature-quest');
    const photo = $<HTMLInputElement>('photo');
    let selected: { cell: string; featureId: string } | null = null;
    const raycaster = new Raycaster();
    const showFacts = async () => {
      if (!selected) return;
      const { resolved } = (await (await fetch(`/api/cells/${selected.cell}/facts`)).json()) as {
        resolved: Record<string, ResolvedAttrs>;
      };
      const attrs = resolved[selected.featureId] ?? {};
      title.textContent =
        typeof attrs.name?.value === 'string' ? attrs.name.value : 'This building';
      factsEl.replaceChildren(
        ...describeFacts(attrs).map((t) =>
          Object.assign(document.createElement('li'), { textContent: t }),
        ),
      );
    };
    walk.onTap = (cx, cy) => {
      raycaster.setFromCamera(
        new Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1),
        camera,
      );
      const hit = world.pick(raycaster);
      if (!hit || !/^osm:w\d+$/.test(hit.featureId)) {
        panel.hidden = true;
        selected = null;
        return;
      }
      selected = hit;
      panel.hidden = false;
      result.textContent = '';
      const quest = world.questFor(hit.featureId);
      questEl.hidden = !quest;
      questEl.textContent = quest ? questLine(quest) : '';
      void showFacts();
    };
    photo.addEventListener('change', async () => {
      const file = photo.files?.[0];
      if (!file || !selected) return;
      const target = selected;
      result.textContent = 'Looking at your photo…';
      photo.disabled = true;
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(target.featureId)}/observe`, {
          method: 'POST',
          body: JSON.stringify({ cell: target.cell, image: await photoToJpegBase64(file) }),
          // A stalled observe must not leave the photo flow waiting forever.
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json()) as {
          error?: string;
          facts?: { attribute: string }[];
          observation?: string;
        };
        if (!res.ok) {
          result.textContent = body.error ?? 'Could not use that photo. Try another one.';
        } else if (!body.facts?.length) {
          result.textContent =
            'The photo did not show this building clearly enough to learn anything. Try one taken straight on.';
          // The building is now an unsure Quest: fetch the Cell's Quests again to show its beacon.
          world.reload(target.cell);
        } else {
          const learned = `Learned ${body.facts.length} thing${body.facts.length === 1 ? '' : 's'} from your photo. This building is now sharper.`;
          if (world.questFor(target.featureId)) {
            const n = questsDone.add();
            result.textContent = `Quest complete (${n} so far). ${learned}`;
            questEl.hidden = true;
          } else result.textContent = learned;
          world.reload(target.cell);
          await showFacts();
        }
      } catch {
        result.textContent = 'Could not reach the server. Check your connection and try again.';
      } finally {
        photo.disabled = false;
        photo.value = '';
      }
    });
  }

  // --- Import a filmed walk ------------------------------------------------------------
  if (!isDemo && !capsule && !sessionInfo) {
    const walkForm = $<HTMLFormElement>('walk-import');
    const walkResult = $('walk-result');
    walkForm.hidden = false;
    walkForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const video = $<HTMLInputElement>('walk-video').files?.[0];
      const gpxFile = $<HTMLInputElement>('walk-gpx').files?.[0];
      if (!video || !gpxFile) {
        walkResult.textContent = 'Choose both the video and its GPS track.';
        return;
      }
      const btn = walkForm.querySelector('button')!;
      btn.disabled = true;
      const sharpened = new Set<string>();
      try {
        const result = await learnFromWalk({
          video,
          gpx: await gpxFile.text(),
          world,
          pose: walk.pose,
          waitForCell: async (x, z) => {
            const cell = world.cellAtWorld(x, z);
            for (let i = 0; i < 300 && !world.isReady(cell); i++)
              await new Promise((r) => setTimeout(r, 100));
          },
          onSharpened: (cell) => sharpened.add(cell),
          onProgress: (p) => {
            walkResult.textContent = `Frame ${p.done} of ${p.total} · ${p.sharpened} building${p.sharpened === 1 ? '' : 's'} sharpened`;
          },
        });
        const notes = [];
        if (result.unreadable)
          notes.push(
            `${result.unreadable} frame${result.unreadable === 1 ? '' : 's'} could not be read`,
          );
        if (result.noBuilding)
          notes.push(
            `${result.noBuilding} frame${result.noBuilding === 1 ? '' : 's'} faced no building`,
          );
        if (result.outsideTrack) notes.push(`${result.outsideTrack} fell outside the GPS track`);
        if (result.failed)
          notes.push(
            `${result.failed} building${result.failed === 1 ? '' : 's'} could not be observed`,
          );
        walkResult.textContent = `Done: ${result.sharpened} building${result.sharpened === 1 ? '' : 's'} sharpened from ${result.total} frames${notes.length ? ` (${notes.join(', ')})` : ''}.`;
      } catch (err) {
        walkResult.textContent = `Could not use this walk: ${(err as Error).message}`;
      } finally {
        // What the walk sharpened must appear, even when the import stopped midway.
        for (const cell of sharpened) world.reload(cell);
        btn.disabled = false;
      }
    });
  }

  // --- Match ---------------------------------------------------------------------
  const hostBtn = $<HTMLButtonElement>('host');
  hostBtn.hidden = isDemo || !!sessionInfo;
  hostBtn.addEventListener('click', async () => {
    const here = world.frame.unproject({ e: walk.pose.x, n: -walk.pose.z });
    hostBtn.disabled = true;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ lat: Number(here.lat.toFixed(6)), lng: Number(here.lng.toFixed(6)) }),
    });
    if (!res.ok) {
      hostBtn.disabled = false;
      errorEl.textContent = 'Could not start a match. Try again in a moment.';
      errorEl.hidden = false;
      return;
    }
    location.assign(`?s=${((await res.json()) as { code: string }).code}`);
  });

  let session: SessionClient | null = null;
  let matchView: MatchView | null = null;
  if (sessionInfo) {
    const matchEl = $('match');
    const lineEl = $('match-line');
    const startBtn = $<HTMLButtonElement>('match-start');
    const logEl = $('match-log');
    matchEl.hidden = false;
    matchView = new MatchView(scene);
    const view = matchView;
    const names = (id: string) =>
      id === session?.me?.id ? 'You' : (session?.peers.get(id)?.info.name ?? 'Someone');
    const log = (text: string) => {
      const li = document.createElement('li');
      li.textContent = text;
      logEl.prepend(li);
      while (logEl.children.length > 4) logEl.lastChild!.remove();
    };
    const goHome = (team: Team, m: MatchState) => {
      const b = m.bases[team];
      arrival = null; // a glide must never carry a player off their base
      Object.assign(walk.pose, { x: b.x, z: b.z + 3, y: 1.7 });
    };
    const renderLine = () => {
      const m = view.match;
      const me = session?.me;
      if (!m || !me) return;
      const clock =
        m.phase === 'playing' && m.endsAt
          ? (() => {
              const left = Math.max(0, Math.round((m.endsAt - Date.now()) / 1000));
              return ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
            })()
          : '';
      const phase =
        m.phase === 'lobby' ? ' · waiting to start' : m.phase === 'ended' ? ' · finished' : '';
      lineEl.innerHTML = '';
      const you = document.createElement('span');
      you.className = `team-${me.team}`;
      you.textContent = `You are ${TEAM_NAMES[me.team]}`;
      lineEl.append(
        `Match ${session!.code} · `,
        you,
        ` · Red ${m.score[0]} – ${m.score[1]} Blue${clock}${phase}`,
      );
      startBtn.hidden = m.phase !== 'lobby';
    };
    startBtn.addEventListener('click', () => session?.start());
    $('match-invite').addEventListener('click', async () => {
      const url = `${location.origin}/?s=${sessionInfo!.code}`;
      try {
        await navigator.clipboard.writeText(url);
        log('Invite link copied');
      } catch {
        log(`Invite: ${url}`);
      }
    });
    const name = new URLSearchParams(location.search).get('name') ?? defaultName();
    session = new SessionClient(sessionInfo.code, name, {
      onWelcome(me, _info, m) {
        view.setMatch(m);
        if (!saved) goHome(me.team, m);
        spawned = true;
        log(`Joined as ${me.name} on ${TEAM_NAMES[me.team]}`);
        renderLine();
      },
      onMatch(m, events) {
        view.setMatch(m);
        for (const e of events) {
          log(describeEvent(e, names));
          if (e.kind === 'tag' && e.player === session?.me?.id) goHome(session.me.team, m);
        }
        renderLine();
      },
      onPeers: showStatus,
      onError: log,
    });
    void session.connect();
    setInterval(renderLine, 1000);
  }
  world.onChange = () => {
    // On first arrival (no saved pose), step onto the nearest road so we don't start inside a wall.
    if (!spawned && world.isReady(world.cellAtWorld(walk.pose.x, walk.pose.z))) {
      spawned = true;
      const here = arrival ? street : walk.pose;
      const road = world.nearestRoad(here.x, here.z);
      if (road && Math.hypot(road.x - here.x, road.z - here.z) < 120) {
        if (arrival) {
          Object.assign(street, { x: road.x, z: road.z });
          arrival.retarget(street);
        } else {
          walk.pose.x = road.x;
          walk.pose.z = road.z;
        }
      }
    }
    showStatus();
  };

  let last = performance.now();
  let lastHash = 0;
  let lastStatus = 0;
  renderer.setAnimationLoop((now) => {
    // Cap the walk step so a backgrounded tab does not jump, but keep slow devices
    // at true speed; the day clock takes its own, looser bound (skyStep).
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.25, rawDt);
    if (arrival && terrain?.unavailable) {
      // No terrain to show off: start at the street, as before.
      Object.assign(walk.pose, street);
      arrival = null;
    }
    if (arrival && !arrival.step(dt, walk.pose)) arrival = null;
    const moved = walk.update(dt);
    // While arriving, load where we will land, not around the camera in the sky.
    const focus = arrival ? street : walk.pose;
    world.update(focus.x, focus.z);
    terrain?.update(camera.position.x, camera.position.y, camera.position.z);
    forest?.update(camera.position.x, camera.position.z);
    if (terrain?.active && ground.visible) {
      ground.visible = false; // the terrain and the sea replace the paper disc
      showStatus();
    }
    if (session?.me && matchView) {
      session.sendPose(walk.pose.x, walk.pose.z, walk.pose.yaw, now);
      matchView.update(
        { id: session.me.id, team: session.me.team, ...walk.pose },
        session.peers,
        dt,
      );
    }
    // The clock and the weather move the status line; refresh it at a human pace.
    if (now - lastStatus > 500) {
      showStatus();
      lastStatus = now;
    }
    // Higher up, see further; with terrain there are mountains to see, so the haze
    // reaches much further and mist pools in the valleys.
    updateSky(rawDt);
    // The forest's wind follows the same clock — a pinned ?t= freezes the crowns too.
    // The biome band decides the floor: under the rainforest's grey ceiling the
    // stand keeps a breath (felt, below the status line's word); temperate
    // overcast stays exactly still.
    if (forest) {
      const p = world.frame.unproject({ e: walk.pose.x, n: -walk.pose.z });
      forest.setWind(skyElapsed, skyNow.cloud, FOREST_BIOMES[forestBiome(p.lat, p.lng)].windFloor);
    }
    atmosphere.setTerrain(!!terrain?.active);
    atmosphere.update(camera.position);
    if (moved && now - lastHash > 400) {
      history.replaceState(null, '', formatPose(walk.pose));
      lastHash = now;
    }
    renderer.render(scene, camera);
  });
  showStatus();
}

function defaultName(): string {
  try {
    const saved = localStorage.getItem('otherhere.name');
    if (saved) return saved;
  } catch {
    // storage unavailable
  }
  const animals = ['Fox', 'Heron', 'Otter', 'Lynx', 'Wren', 'Badger', 'Hare', 'Kestrel'];
  const name = `${animals[Math.floor(Math.random() * animals.length)]} ${Math.floor(Math.random() * 90 + 10)}`;
  try {
    localStorage.setItem('otherhere.name', name);
  } catch {
    // storage unavailable
  }
  return name;
}
