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
  type SessionInfo,
  type Team,
} from '@otherhere/core';
import { World } from './world';
import { SessionClient } from './net';
import { describeEvent, MatchView, TEAM_NAMES } from './match';
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
  start && 'lat' in start ? start : (sessionInfo?.origin ?? capsule?.view?.center ?? null);
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
  const world = new World(
    scene,
    originCell,
    isDemo ? 'demo' : capsule ? { capsule: capsuleBundleInputs(capsule) } : 'api',
  );
  const pose = capsule?.view?.pose;
  const saved =
    parsePose(location.hash) ??
    (pose ? { x: pose[0], y: pose[1], z: pose[2], yaw: pose[3], pitch: pose[4] } : null);
  let spawned = !!saved;
  // Start at the exact point typed (not the Cell centre), at eye height.
  const startAt = place ? world.frame.project(place) : { e: 0, n: 0 };
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
      backend,
      pose: walk.pose,
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
  let lastStatus = 0;
  renderer.setAnimationLoop((now) => {
    // Cap the step so a backgrounded tab does not jump, but keep slow devices at true speed.
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const moved = walk.update(dt);
    world.update(walk.pose.x, walk.pose.z);
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
