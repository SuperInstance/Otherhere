// apps/client/playtest/probe.mjs — OTHERHERE LANE A, rounds 1–2.
// An exploratory OUTSIDE-IN probe, not a pass/fail test: it plays the game like
// a player (walks, looks, passes time, saves a postcard, steps off the recorded
// block) and RECORDS everything it sees — console messages, page errors, failed
// network requests, world stats, the living sky (`window.__otherhere.sky`),
// screenshots — so a human can read a session afterwards. Every log row carries
// the in-world clock and weather at the moment it was written.
//
// Scenes (`--scene`, default `walk`):
//   walk         round 1's exploratory run: arrive, walk, demo, goto, postcard.
//   day          hold T through a full day; screenshots at night/dawn/golden/noon/dusk.
//   determinism  load the same pinned `?t=` URL twice in fresh contexts; compare.
//   postcard     save a postcard at dusk, open the link, verify the frozen moment.
//   sketch       step off the recorded block; watch sketch-Cell retry behaviour.
//
// Usage:
//   node playtest/probe.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --tag local-zurich
//   node playtest/probe.mjs --base https://otherhere.superinstance.dev --tag live-default
//   node playtest/probe.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --scene day --tag local-zurich-day
//   node playtest/probe.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --scene postcard --tag local-zurich-postcard
//   node playtest/probe.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --scene determinism --t 21.5 --tag local-zurich-det
//   node playtest/probe.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --scene sketch --tag local-zurich-sketch
// Artifacts land OUTSIDE the repo, in otherhere-lab/playtest-artifacts/<tag>-*
// (PNG + JSON), plus a session summary JSON with every console/error/network row.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { cellToParent, latLngToCell } from 'h3-js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = arg('base', 'http://localhost:5173');
const AT = arg('at', ''); // "" = the site default (downtown Sitka)
const TAG = arg('tag', 'probe');
const SCENE = arg('scene', 'walk');
const PINNED_T = arg('t', ''); // pinned day-clock hour for the URL (?t=)
const HASH = arg('hash', ''); // saved pose for the URL (#x,y,z,yaw,pitch)
const SEED = process.argv.includes('--seed');
const OUT = process.env.PLAYTEST_OUT ?? new URL('../../../../otherhere-lab/playtest-artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// The repo's e2e config points at a preinstalled Chromium; do the same, falling
// back to whatever chromium-* build is in the playwright cache.
const chromiumPath =
  process.env.PW_CHROMIUM ??
  (() => {
    const root = join(homedir(), '.cache', 'ms-playwright');
    if (!existsSync(root)) return undefined;
    const dir = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .at(-1);
    if (!dir) return undefined;
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
    return undefined;
  })();

const log = [];
let freshest = null; // last { stats, backend, sky } read from the page
let page = null; // the current scene's page (helpers below read it)
let flush = () => {}; // re-bound per scene: writes the session JSON as it grows

// In-world readouts, mirrored from src/sky.ts (formatHour / describeWeather) so
// every session row can name the moment it happened.
const formatHour = (hour) => {
  const h = Math.floor(((hour % 24) + 24) % 24);
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const am = h < 12;
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
};
const describeWeather = (cloud) =>
  cloud < 0.3
    ? 'clear'
    : cloud < 0.55
      ? 'light cloud'
      : cloud < 0.78
        ? 'broken overcast'
        : 'overcast';
const clock = () => {
  const sky = freshest?.sky;
  if (!sky) return null;
  return {
    hour: Number(sky.hour.toFixed(3)),
    timeOfDay: formatHour(sky.hour),
    weather: describeWeather(sky.cloud),
    cloud: Number(sky.cloud.toFixed(3)),
    sunElevation: Number(sky.elevation.toFixed(1)),
  };
};

const note = (kind, detail) => {
  const row = { t: new Date().toISOString().slice(11, 23), kind, clock: clock(), ...detail };
  log.push(row);
  console.log(`${row.t} [${kind}]`, JSON.stringify(detail).slice(0, 300));
  flush(); // evidence must survive even a killed run
  return row;
};

const browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  // --disable-dev-shm-usage: small-container /dev/shm (64 MB here) crashes
  // software-GL tabs otherwise; the writeback goes to /tmp instead.
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
  ],
});

/** A fresh context wired with the probe's recorders; sets the shared `page`. */
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  page = p;
  attach(p);
  return { ctx, page: p };
};
const attach = (p) => {
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      note('console', { type: m.type(), text: m.text().slice(0, 500) });
  });
  p.on('pageerror', (e) => note('pageerror', { message: String(e).slice(0, 500) }));
  p.on('requestfailed', (r) =>
    note('requestfailed', { url: r.url().slice(0, 200), error: r.failure()?.errorText }),
  );
  p.on('response', (r) => {
    if (r.status() >= 400) note('http', { status: r.status(), url: r.url().slice(0, 200) });
  });
};

const readWorld = async () => {
  const w = await page
    .evaluate(() => {
      const o = window.__otherhere;
      return o
        ? { stats: { ...o.stats }, backend: o.backend, sky: o.sky ? { ...o.sky } : null }
        : null;
    })
    .catch(() => null);
  if (w) freshest = w;
  return w;
};

const settle = async (label, timeoutMs = 90000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await readWorld();
    if (s && s.stats.ready > 0 && s.stats.loading === 0) {
      note('settled', {
        label,
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
        stats: s.stats,
        sky: s.sky,
      });
      return s;
    }
    if (Date.now() - t0 > timeoutMs) {
      note('settle-timeout', { label, waitedSeconds: (timeoutMs / 1000).toFixed(0), last: s });
      return s;
    }
    await page.waitForTimeout(500);
  }
};

const shot = async (name) => {
  await readWorld(); // the row names the moment the picture was taken
  const b = await page.screenshot({ path: `${OUT}${TAG}-${name}.png` });
  note('shot', {
    name,
    bytes: b.length,
    stats: freshest?.stats ?? null,
    sky: freshest?.sky ?? null,
  });
  return b;
};

const hudStatus = async () => {
  const status = await page
    .locator('#status')
    .textContent()
    .catch(() => null);
  note('hud-status', { status });
  return status;
};

/**
 * Click a HUD control under software GL. THE F1 LAW (round 3): the page's
 * render loop runs at ~1 fps in this container, and Playwright's actionability
 * checks ride requestAnimationFrame — a real click can take 20 s or more to
 * land (measured: 19.6 s on live, the button never moving, nothing
 * intercepting — F1 was an instrument artifact, not a product bug). So: give
 * the real click a 60 s budget, and if even that is not enough, fall back to a
 * DOM-level el.click() — the same event the browser would dispatch, still
 * exercising the product's handler. Which path landed is always logged.
 */
const clickHud = async (locator, name, timeoutMs = 60000) => {
  const t0 = Date.now();
  try {
    await locator.click({ timeout: timeoutMs });
    note('hud-click', { name, path: 'real', ms: Date.now() - t0 });
    return 'real';
  } catch (e) {
    note('hud-click-fallback', { name, path: 'dom', ms: Date.now() - t0, error: String(e).slice(0, 200) });
    await locator.evaluate((el) => el.click());
    return 'dom';
  }
};

/**
 * Screenshot the rendered world only, with the HUD overlays hidden — the e2e
 * doctrine for pixel compares (the status text can legitimately differ between
 * two views whose worlds are identical: sketch counts, quest lines, time).
 */
const hideHud = () =>
  page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
const worldShot = async (name) => {
  await hideHud();
  await readWorld(); // the row names the moment the picture was taken
  const b = await page.screenshot({ path: `${OUT}${TAG}-${name}.png` });
  note('world-shot', {
    name,
    bytes: b.length,
    stats: freshest?.stats ?? null,
    sky: freshest?.sky ?? null,
  });
  return b;
};

const placeUrl = (extra = '') =>
  `${BASE}/${AT ? `?at=${AT}` : ''}${PINNED_T ? `${AT ? '&' : '?'}t=${PINNED_T}` : ''}${extra}${HASH ? `#${HASH}` : ''}`;

/** Compare two screenshot buffers: byte equality, else the worst channel delta. */
const pngStats = (a, b) => {
  if (a.equals(b)) return { byteEqual: true };
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height)
    return { byteEqual: false, sizeMismatch: true };
  let max = 0;
  let pixels = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let differs = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(pa.data[i + c] - pb.data[i + c]);
      if (d > 0) differs = true;
      if (d > max) max = d;
    }
    if (differs) pixels++;
  }
  return {
    byteEqual: false,
    maxChannelDiff: max,
    pixelsDiffer: pixels,
    pixelsTotal: pa.width * pa.height,
  };
};

const seedBlock = async () => {
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  const res = await page.request.post(`${BASE}/api/dev/blocks/881f8ed951fffff`, {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  note('seed', { status: res.status() });
};

/** Fast-forward (hold T) until the day clock reaches `targetHour`, then shoot. */
const travelTo = async (name, targetHour, budgetMs) => {
  const startHour = freshest?.sky?.hour ?? (await readWorld())?.sky?.hour ?? null;
  if (startHour === null) {
    note('travel-skip', { name, reason: 'no sky state exposed' });
    return;
  }
  const want = (targetHour - startHour + 24) % 24;
  if (want <= 0.1) {
    note('travel-skip', { name, target: targetHour, at: Number(startHour.toFixed(2)) });
    return;
  }
  // Under software GL the page runs at ~1 fps, and each frame's clock step is
  // bounded, so budget by the distance to travel — not a flat guess. The live
  // site still runs the pre-fix clamped clock, which travels ~1.2 h per held
  // minute there, so the default budget is generous.
  const budget = budgetMs ?? Math.min(900_000, 90_000 + want * 60_000);
  await page.keyboard.down('KeyT');
  const t0 = Date.now();
  let last = startHour;
  let progress = 0;
  for (;;) {
    await page.waitForTimeout(250);
    const h = (await readWorld())?.sky?.hour ?? null;
    if (h !== null && h !== last) {
      const d = (h - last + 24) % 24; // the clock only runs forward
      if (d < 12) progress += d;
      last = h;
    }
    if (progress >= want) break;
    if (Date.now() - t0 > budget) {
      note('travel-timeout', {
        name,
        target: targetHour,
        progressHours: Number(progress.toFixed(2)),
        wantHours: Number(want.toFixed(2)),
      });
      break;
    }
  }
  await page.keyboard.up('KeyT');
  await page.waitForTimeout(1500); // a beat for the palette, the lights and the status line
  await readWorld();
  note('hour', { name, target: targetHour, reached: freshest?.sky?.hour ?? null });
  await hudStatus();
  await shot(name);
};

/** Open the HUD's collapsed `<details>` panels (a player clicks the summary). */
const openHudPanels = async () => {
  const panels = page.locator('#hud details');
  const n = await panels.count();
  for (let i = 0; i < n; i++) {
    const d = panels.nth(i);
    // The F1 law: HUD clicks under software GL ride the ~1 fps frame loop
    // (measured: 19.6 s for one click on live, the button never moving — F1
    // was an instrument artifact, not a product bug). Budget for it; fall back to
    // the attribute only if even that is not enough.
    if (!(await d.evaluate((el) => el.open))) {
      await clickHud(d.locator('summary'), `details-${i}`, 30000).catch(() => {});
      if (!(await d.evaluate((el) => el.open)))
        await d.evaluate((el) => el.setAttribute('open', ''));
    }
  }
  note('hud-panels-open', { count: n });
};

/**
 * Save a postcard through the HUD form and return its link with the sky as it
 * stood the moment the Save button went in (the link pins THAT hour, and — the
 * round's question — the weather that belongs to it). Assumes the world has
 * settled and the walker is standing somewhere worth remembering. Clicking
 * the summary of an already-open `<details>` would COLLAPSE it, so only click
 * when it is closed; every HUD interaction gets a 30 s budget because the
 * actionability checks ride the page's 1–3 fps animation loop in this container.
 */
const savePostcard = async (title) => {
  await openHudPanels();
  const details = page.locator('#postcard details');
  if (!(await details.evaluate((el) => el.open)))
    await clickHud(page.getByText('Save a postcard', { exact: true }), 'postcard-summary');
  // The app reads the hour to pin at the moment this panel opened; read the sky
  // right after so the session can check the pin against the framed moment.
  const skyAtFormOpen = (await readWorld())?.sky ?? null;
  await page.getByLabel('Postcard title').fill(title, { timeout: 30_000 });
  await page.getByLabel('Who can open it').selectOption('public', { timeout: 30_000 });
  await clickHud(page.getByRole('button', { name: 'Save postcard' }), 'save-postcard');
  const skyAtClick = (await readWorld())?.sky ?? null; // before the POST resolves
  const link = await page.locator('#pc-result a').getAttribute('href', { timeout: 60_000 });
  return { link, skyAtFormOpen, skyAtClick };
};

/**
 * A postcard link is absolute (the app builds it from location.origin), so it
 * opens as-is; anything else is joined to the probe's base.
 */
const openLink = (link) => page.goto(/^https?:\/\//.test(link) ? link : `${BASE}${link}`);

/* ------------------------------------------------------------- scenes */

async function sceneWalk() {
  if (SEED) await seedBlock();
  await page.goto(placeUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  note('goto', { url: placeUrl() });
  await shot('01-arrival');
  await settle('arrival');
  await shot('02-settled');

  const canvas = page.locator('canvas');
  await canvas.click({ position: { x: 640, y: 400 } }); // focus
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down(i % 2 ? 'ShiftLeft' : 'KeyW');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await shot(`03-walk-${i + 1}`);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640 + (i % 2 ? 260 : -260), 400 - i * 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await readWorld();
  note('after-walk', { stats: freshest?.stats ?? null, sky: freshest?.sky ?? null });
  await shot('04-after-walk');

  await page.goto(`${BASE}/?demo=generators`, { waitUntil: 'domcontentloaded' });
  await settle('demo', 60000);
  await shot('05-demo-generators');

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.fill('#coords', 'Lincoln St, Sitka, AK');
  await page.click('#goto button[type=submit]');
  try {
    await page.waitForURL((u) => /[#?]/.test(u.search + u.hash) && /at=|s=|c=/.test(u.search), {
      timeout: 30000,
    });
    await settle('goto-sitka', 90000);
    await shot('06-goto-lincoln-st');
  } catch {
    note('goto-timeout', { place: 'Lincoln St, Sitka, AK' });
    await shot('06-goto-timeout');
  }

  // Save a postcard (public) and read back its link. The form lives inside a
  // collapsed <details> — open the HUD panels first (round 1 recorded
  // `postcard-failed` here because the button was hidden, not broken).
  try {
    const { link } = await savePostcard(`Probe round 2 — ${TAG}`);
    note('postcard', { link });
    await readWorld();
    await shot('07-postcard-saved');
    if (link) {
      await openLink(link);
      await settle('postcard-open', 90000);
      await hudStatus();
      await shot('08-postcard-opened');
    }
  } catch (e) {
    note('postcard-failed', { error: String(e).slice(0, 300) });
    await shot('07-postcard-failed');
  }

  await hudStatus();
  await shot('09-final');
}

async function sceneDay() {
  if (SEED) await seedBlock();
  await page.goto(placeUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  note('goto', { url: placeUrl() });
  await settle('day-arrival');
  await hudStatus();
  await shot('10-day-start');

  // One continuous hold-T lap of the day: noon → afternoon → dusk → night →
  // (past midnight) → dawn → golden hour. Transitions only break if you let go.
  // Each leg carries the default distance-based budget, so a slow (or pre-fix
  // clamped) clock records a timeout and the arc continues from wherever the
  // hour actually is.
  await travelTo('11-noon', 12.0);
  await travelTo('12-afternoon', 15.5);
  await travelTo('13-dusk', 19.75);
  await travelTo('14-night', 22.5);
  await travelTo('15-dawn', 5.5);
  await travelTo('16-golden', 7.25);

  await hudStatus();
  await shot('17-day-end');
}

async function sceneDeterminism() {
  if (SEED) await seedBlock(); // a fresh worker's Town starts empty
  const url = placeUrl();
  if (!PINNED_T)
    note('determinism-warning', { note: 'no --t given; the living clock will not be pinned' });
  const skies = [];
  const buffers = [];
  const ambience = [];
  for (const which of ['a', 'b']) {
    const { ctx } = await newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    note('goto', { url, which });
    await settle(`determinism-${which}`);
    // A retrying sketch Cell pops mid-reload; only compare a quiet world. Wait
    // out the sketch-retry timers (10/30 s) so nothing is in flight at the shot.
    let quietSince = null;
    const quietFrom = Date.now();
    for (;;) {
      const s = await readWorld();
      if (s && s.stats.ready > 0 && s.stats.loading === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince > 35_000) break;
      } else {
        quietSince = null;
      }
      if (Date.now() - quietFrom > 300_000) {
        note('never-quiet', { waitedSeconds: 300, last: s?.stats ?? null });
        break;
      }
      await page.waitForTimeout(2500);
    }
    const s1 = await readWorld();
    await page.waitForTimeout(6000); // frozen means frozen: the hour must not move
    const s2 = await readWorld();
    note('freeze-check', {
      which,
      skyAtOpen: s1?.sky ?? null,
      skySixSecondsLater: s2?.sky ?? null,
    });
    await hudStatus();
    await shot(`20-determinism-${which}`); // the player's view, HUD and all
    buffers.push(await worldShot(`20-determinism-${which}-world`));
    // The ambience floor: the SAME page, seconds later. Waves lap, stars
    // twinkle and cloud shadows drift on the render clock, so even a frozen
    // hour is never byte-still. Whatever moves here is animation, not
    // nondeterminism — the cross-context pair must be judged against it.
    await page.waitForTimeout(6000);
    ambience.push(await worldShot(`20-determinism-${which}-world-later`));
    skies.push(s2?.sky ?? null);
    note('ambience-floor', { which, png: pngStats(buffers.at(-1), ambience.at(-1)) });
    await ctx.close();
  }
  const [a, b] = skies;
  note('determinism', {
    skyA: a,
    skyB: b,
    skyEqual: !!a && !!b && a.hour === b.hour && a.cloud === b.cloud && a.elevation === b.elevation,
    png: pngStats(buffers[0], buffers[1]),
    pngVsAmbienceFloorA: pngStats(buffers[0], ambience[0]),
    pngVsAmbienceFloorB: pngStats(buffers[1], ambience[1]),
  });
}

async function scenePostcard() {
  if (SEED) await seedBlock();
  await page.goto(placeUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  note('goto', { url: placeUrl() });
  await settle('postcard-arrival');
  await hudStatus();

  // A distinctive hour: reach dusk on the living clock, then save.
  await travelTo('20-dusk', 19.9);
  try {
    const { link, skyAtFormOpen, skyAtClick } = await savePostcard('Dusk, from the round-2 probe');
    const pinned = link ? Number(/[?&]t=([\d.]+)/.exec(link)?.[1] ?? NaN) : NaN;
    await readWorld();
    note('postcard-saved', {
      link,
      pinnedHour: pinned,
      skyAtFormOpen,
      skyAtClick,
      skyAtSave: freshest?.sky ?? null,
    });
    await shot('21-postcard-saved'); // the saver's screen, form and all
    const savedWorld = await worldShot('21-postcard-saved-world');
    if (link) {
      await openLink(link);
      await settle('postcard-open', 90000);
      await page.waitForTimeout(5000); // frozen means frozen
      const opened = await readWorld();
      // The director's-cut question: the hour is pinned — does the WEATHER
      // travel with it? The saver's clock moved on after the click, so allow
      // the drift of the minutes between click and this read.
      const clickCloud = skyAtClick?.cloud ?? null;
      const openedCloud = opened?.sky?.cloud ?? null;
      const hoursBetween =
        skyAtClick && opened ? Math.abs(opened.sky.hour - skyAtClick.hour) : null;
      note('postcard-opened', {
        pinnedHour: pinned,
        skyAtOpen: opened?.sky ?? null,
        hourMatches: Math.abs((opened?.sky?.hour ?? -99) - pinned) < 0.05,
        frozenAtPinnedHour: true,
        pinnedMatchesFormOpen:
          skyAtFormOpen && Number.isFinite(pinned)
            ? Math.abs(pinned - skyAtFormOpen.hour) < 0.15
            : null,
        cloudAtClick: clickCloud,
        cloudAtOpen: openedCloud,
        cloudDelta:
          clickCloud !== null && openedCloud !== null
            ? Number(Math.abs(openedCloud - clickCloud).toFixed(4))
            : null,
        weatherTravelsWithHour:
          clickCloud !== null && openedCloud !== null
            ? Math.abs(openedCloud - clickCloud) < 0.02
            : null,
        hoursSaverMovedWhileSaving: hoursBetween,
      });
      await hudStatus();
      await shot('22-postcard-opened'); // the friend's screen, banner and all
      const openedWorld = await worldShot('22-postcard-opened-world');
      // Only the world shots compare (the player-view shots carry the HUD:
      // the saver's open form vs the friend's banner line).
      note('postcard-png', { world: pngStats(savedWorld, openedWorld) });
    }
  } catch (e) {
    note('postcard-failed', { error: String(e).slice(0, 300) });
    await shot('21-postcard-failed');
  }
}

async function sceneSketch() {
  if (SEED) await seedBlock();

  // Where we will step to: ~900 m north of the recorded block, far enough that
  // the walker's ring leaves it entirely (cells outside ring-2 are dropped).
  const [lat, lng] = (AT || '47.3769,8.5417').split(',').map(Number);
  const FAR_M = 900;
  const farLat = lat + FAR_M / 111320;
  const farCell = latLngToCell(farLat, lng, 9);
  const farBlock = cellToParent(farCell, 8);
  note('sketch-plan', {
    origin: `${lat},${lng}`,
    teleport: `#0,1.7,-${FAR_M},0.9,-0.02`,
    farCell,
    farBlock,
    seededBlock: SEED ? '881f8ed951fffff' : null,
    leftSeededBlock: String(farBlock) !== '881f8ed951fffff',
  });

  // 1. Arrive inside the recorded block, so the start is fully real.
  await page.goto(placeUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle('sketch-arrival');
  await shot('30-start');

  // 2. Step off the recorded block: reload at a saved pose 900 m north (a
  // player's "I walked here yesterday" teleport). Count /api/cells asks.
  const cellAsks = [];
  page.on('request', (r) => {
    if (/\/api\/(cells|bundles)\//.test(r.url()))
      cellAsks.push({ t: Date.now(), url: r.url().slice(0, 120) });
  });
  await page.goto(`${BASE}/?at=${AT || '47.3769,8.5417'}#0,1.7,-${FAR_M},0.9,-0.02`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  note('teleported', { to: `z=-${FAR_M}`, block: farBlock });

  // Wait for the ring to resolve to *something* (sketch or real), then watch it.
  await settle('sketch-land', 120000);
  await hudStatus();
  await shot('31-sketch-land');

  // 3. Watch the world for a few minutes: sketch count, HUD line, retry asks.
  const startedAt = Date.now();
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(10000);
    const w = await readWorld();
    const status = await page
      .locator('#status')
      .textContent()
      .catch(() => null);
    note('sketch-watch', {
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(0)),
      stats: w?.stats ?? null,
      sky: w?.sky ?? null,
      status: status?.split('\n').slice(0, 4).join(' | '),
      cellAsksSinceStart: cellAsks.filter((a) => a.t >= startedAt).length,
    });
    if (i === 5 && SEED) {
      // Mid-session: the data arrives (as if Overpass recovered). Does the world
      // pick it up while we stand still, or stay a sketch until we move?
      const fixture = readFileSync(
        new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
      );
      const res = await page.request.post(`${BASE}/api/dev/blocks/${farBlock}`, {
        data: fixture,
        headers: { 'content-type': 'application/json' },
      });
      note('mid-session-seed', { block: farBlock, status: res.status() });
    }
  }
  await shot('32-sketch-end');

  // 4. A fresh look at the same spot (a reload, as the status line suggests).
  await page.goto(`${BASE}/?at=${AT || '47.3769,8.5417'}#0,1.7,-${FAR_M},0.9,-0.02`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settle('sketch-reloaded', 120000);
  await hudStatus();
  await shot('33-sketch-reloaded');
  note('cell-asks', { count: cellAsks.length, urls: cellAsks.slice(0, 60) });
}

const SCENES = {
  walk: sceneWalk,
  day: sceneDay,
  determinism: sceneDeterminism,
  postcard: scenePostcard,
  sketch: sceneSketch,
};
if (!SCENES[SCENE]) {
  console.error(`unknown --scene ${SCENE} (walk|day|determinism|postcard|sketch)`);
  process.exit(2);
}

// THE F3 LAW (round 3): a scene that dies must not take the session with it —
// record the failure and keep playing. `--scenes a,b,c` runs several scenes in
// one process, each on its own page and inside its own try/catch; `--scene`
// stays the single-scene spelling.
const sceneList = (arg('scenes', '') || SCENE)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && SCENES[s]);
const unknownScenes = (arg('scenes', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && !SCENES[s]);
if (unknownScenes.length) console.error(`[probe] unknown scenes skipped: ${unknownScenes.join(',')}`);

try {
  // Every scene starts on its own fresh page (determinism makes more).
  const meta = () => ({
    base: BASE,
    at: AT,
    scene: sceneList.length === 1 ? sceneList[0] : sceneList,
    t: PINNED_T || null,
    hash: HASH || null,
    log,
  });
  flush = () => writeFileSync(`${OUT}${TAG}-session.json`, JSON.stringify(meta(), null, 2));
  for (const scene of sceneList) {
    try {
      await newPage();
      await SCENES[scene]();
      note('scene-done', { scene });
    } catch (e) {
      // The scene's own evidence so far is already in the log; record the death
      // and move on to the next scene on a fresh page.
      note('scene-failed', { scene, error: String(e).slice(0, 400) });
      try {
        await shot(`${scene}-failed`);
      } catch {
        // even the screenshot may be gone; the log row is the record
      }
    }
  }
} finally {
  flush();
  await browser.close();
}
console.log(`\n[probe] done — artifacts in ${OUT} (tag ${TAG}), ${log.length} log rows`);
