import {
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Raycaster,
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
import { Forest } from './forest';
import { World } from './world';
import { Terrain, TERRAIN_ATTRIBUTION, type TerrainMode } from './terrain';
import { SessionClient } from './net';
import { describeEvent, MatchView, TEAM_NAMES } from './match';
import { describeFacts, photoToJpegBase64, questLine, questsDone } from './feature';
import { learnFromWalk } from './capture';
import { WalkControls } from './walk';
import { PAPER } from './material';
import { DEFAULT_PLACE, formatPose, parseCoords, parsePose, parseStart, type Pose } from './url';

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
    location.assign(`?at=${body.lat.toFixed(6)},${body.lng.toFixed(6)}`);
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
  }
}

// --- World -----------------------------------------------------------------------
const isDemo = !!start && 'demo' in start;
const place =
  start && 'lat' in start
    ? start
    : (sessionInfo?.origin ?? capsule?.view?.center ?? (start ? null : DEFAULT_PLACE));
if (place && !isDemo) input.value = `${place.lat}, ${place.lng}`;
const originCell = isDemo
  ? DEMO_CELL
  : capsule
    ? capsule.cells[0]!
    : place
      ? cellAt(place.lat, place.lng)
      : null;

if (!originCell) {
  statusEl.textContent = `${backend} · Enter coordinates to walk a place.`;
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
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
  const arriving = !saved && !isDemo && !capsule && !!terrain;
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
    const lines = [
      `${backend} · ${s.ready} cell${s.ready === 1 ? '' : 's'}${s.loading ? ` (+${s.loading} loading)` : ''} · ${s.features.toLocaleString()} features`,
      `${s.verified}/${s.ready} bundle hashes verified${s.mismatched ? ` · ${s.mismatched} MISMATCHED` : ''}`,
    ];
    if (terrain?.active)
      lines.push(
        `${terrain.mode === 'topo' ? 'Topographic' : 'Satellite'} (M to switch) · ${TERRAIN_ATTRIBUTION[terrain.mode]}`,
      );
    if (s.sketch) {
      const are = s.sketch === 1 ? '1 cell is' : `${s.sketch} cells are`;
      lines.push(`${are} still a sketch: waiting for OpenStreetMap, trying again shortly.`);
    }
    if (s.errors)
      lines.push(`${s.errors} cell${s.errors === 1 ? '' : 's'} failed to load. Reload to retry.`);
    if (s.quests) {
      const done = questsDone.get();
      lines.push(
        `${s.quests} quest${s.quests === 1 ? '' : 's'} nearby: photograph a building under an amber beacon${done ? ` · ${done} done` : ''}`,
      );
    }
    if (capsule) {
      lines.unshift(
        `Postcard: ${capsule.title} · saved ${capsule.createdAt.slice(0, 10)} · built in your browser`,
      );
      if (!generatorsCurrent)
        lines.push('Drawn with newer generators than it was saved with, so details may differ.');
    }
    statusEl.textContent = lines.join('\n');
    (window as unknown as { __otherhere: unknown }).__otherhere = {
      stats: s,
      quests: world.questTargets(),
      backend,
      pose: walk.pose,
      terrain: terrain && {
        ...terrain.stats(),
        active: terrain.active,
        ground: terrain.heightAt(walk.pose.x, walk.pose.z),
        stand: terrain.standAt(walk.pose.x, walk.pose.z),
        eye: camera.position.y,
      },
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
    const url = `${location.origin}/?c=${id}${scope === 'private' ? `&k=${ownerKey}` : ''}`;
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
        for (const cell of sharpened) world.reload(cell);
        const notes = [];
        if (result.noBuilding)
          notes.push(
            `${result.noBuilding} frame${result.noBuilding === 1 ? '' : 's'} faced no building`,
          );
        if (result.outsideTrack) notes.push(`${result.outsideTrack} fell outside the GPS track`);
        walkResult.textContent = `Done: ${result.sharpened} building${result.sharpened === 1 ? '' : 's'} sharpened from ${result.total} frames${notes.length ? ` (${notes.join(', ')})` : ''}.`;
      } catch (err) {
        walkResult.textContent = `Could not use this walk: ${(err as Error).message}`;
      } finally {
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
    // Cap the step so a backgrounded tab does not jump, but keep slow devices at true speed.
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
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
      if (now - lastStatus > 500) {
        showStatus();
        lastStatus = now;
      }
    }
    // Higher up, see further; with terrain there are mountains to see, so the haze
    // reaches much further and mist pools in the valleys.
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
