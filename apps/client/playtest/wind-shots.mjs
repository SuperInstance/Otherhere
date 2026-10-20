/**
 * OH-B2 screenshot driver — Sitka street level + the arrival/establishing view,
 * at a calm-overcast moment and a clear-broken-sky moment, as still-air and wind
 * pairs for pixel evidence. Software GL runs the page at ~0.5–3 fps, so every
 * leg is a separate run: `node wind-shots.mjs <scene>` with
 * street-calm | street-wind | establishing-calm | establishing-wind | arrival`.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '/home/z/my-project/otherhere-lab/playtest-artifacts';
const EXE =
  '/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:8787';
const PLACE = '57.0531,-135.33';
const scene = process.argv[2] ?? 'street';
mkdirSync(OUT, { recursive: true });

const sky = (page) => page.evaluate(() => window.__otherhere?.sky ?? null);
const forestStat = (page) => page.evaluate(() => window.__otherhere?.forest ?? null);
const worldStat = (page) => page.evaluate(() => window.__otherhere?.stats ?? null);

const log = (...a) => console.log(`[${Math.floor(process.uptime())}s]`, ...a);

async function hideHud(page) {
  await page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
}

/** Wait until the world settles: cells loaded, terrain active, forest planted. */
async function settle(page, label, minTrees) {
  for (let i = 0; i < 120; i++) {
    const [s, f, skyS] = await Promise.all([worldStat(page), forestStat(page), sky(page)]);
    const ready = s?.ready ?? 0;
    const loading = s?.loading ?? 0;
    const trees = f?.trees ?? 0;
    if (i % 6 === 0)
      log(
        `${label}: ready=${ready} loading=${loading} forest=${trees} chunks=${f?.chunks ?? 0}` +
          ` sky=${skyS ? `h${skyS.hour.toFixed(1)} c${skyS.cloud.toFixed(2)} w${(skyS.wind ?? 0).toFixed(2)}` : '?'}`,
      );
    if (ready > 0 && loading === 0 && trees >= minTrees) {
      log(`${label}: settled (ready=${ready}, trees=${trees})`);
      return { ready, trees };
    }
    await page.waitForTimeout(5000);
  }
  throw new Error(`${label}: never settled`);
}

/** Hold T until the weather matches `want(sky)`, then release. */
async function reachWeather(page, label, want, maxMs = 600000, pollMs = 2500) {
  const t0 = Date.now();
  await page.keyboard.down('KeyT');
  try {
    for (;;) {
      const s = await sky(page);
      if (s && want(s)) {
        log(
          `${label}: reached hour=${s.hour.toFixed(2)} cloud=${s.cloud.toFixed(3)} wind=${s.wind.toFixed(3)}`,
        );
        return s;
      }
      if (Date.now() - t0 > maxMs) {
        log(`${label}: gave up waiting at ${JSON.stringify(s)}`);
        return s;
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await page.keyboard.up('KeyT');
  }
}

async function shot(page, name) {
  const s = await sky(page);
  const f = await forestStat(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  writeFileSync(
    `${OUT}/${name}.json`,
    JSON.stringify(
      { scene, shot: name, sky: s, forest: f, takenAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  log(
    `shot ${name}: hour=${s?.hour.toFixed(3)} cloud=${s?.cloud.toFixed(3)} wind=${s?.wind.toFixed(3)} trees=${f?.trees}`,
  );
}

/** Wait for the clock to advance by at least `dElapsed` seconds of game time.
 * Software GL runs at ~0.5 fps, so wall-clock waits alone can land twice on the
 * same presented frame; the day clock only moves when a frame renders. */
async function waitForClock(page, dElapsed) {
  const s0 = await sky(page);
  const h0 = s0?.hour ?? 0;
  // hour wraps at 24; dElapsed seconds of clock is dElapsed/3600 hours.
  const dHour = dElapsed / 3600;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(3000);
    const s = await sky(page);
    let dh = (s?.hour ?? h0) - h0;
    if (dh < 0) dh += 24;
    if (dh >= dHour) return;
  }
  log(`waitForClock(${dElapsed}s): timed out`);
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => log('PAGE ERROR:', e.message));

try {
  if (scene === 'street' || scene === 'street-calm') {
    // Street level, facing east into the hills (yaw -pi/2), eye 1.7 m.
    await page.goto(`${BASE}/?at=${PLACE}#0,1.7,0,-1.5708,0.08`, { waitUntil: 'domcontentloaded' });
    await settle(page, 'street', 4000);
    await hideHud(page);
    await page.waitForTimeout(4000);
    await shot(page, 'sitka-street-00-orientation');

    // A calm-overcast moment: cloud >= 0.78, wind ~ 0. Still-air pair.
    await reachWeather(page, 'calm', (s) => s.cloud >= 0.78 && s.wind < 0.02);
    await waitForClock(page, 4);
    await shot(page, 'sitka-street-calm-1');
    await waitForClock(page, 4);
    await shot(page, 'sitka-street-calm-2');
  } else if (scene === 'street-wind') {
    // The same street view inside travelling gusts: clear-broken sky, wind on.
    await page.goto(`${BASE}/?at=${PLACE}#0,1.7,0,-1.5708,0.08`, { waitUntil: 'domcontentloaded' });
    await settle(page, 'street', 4000);
    await hideHud(page);
    const now = await reachWeather(
      page,
      'windy',
      (s) => s.wind >= 0.4 && s.hour > 8 && s.hour < 19.5,
      420000,
    ).catch(() => {});
    if (!(now && now.wind >= 0.36)) {
      log('windy: relaxing to any decent wind');
      await reachWeather(page, 'windy2', (s) => s.wind >= 0.34, 300000);
    }
    await waitForClock(page, 4);
    await shot(page, 'sitka-street-wind-1');
    await waitForClock(page, 4);
    await shot(page, 'sitka-street-wind-2');
  } else if (scene === 'street-gale') {
    // Near-full wind for still-pair evidence: Sitka's clearest sky (cloud near the
    // 0.45 band floor) puts the strength near 1.0, where crown travel is metres
    // and the pair diff is undeniable even in software-GL stills.
    await page.goto(`${BASE}/?at=${PLACE}#0,1.7,0,-1.5708,0.08`, { waitUntil: 'domcontentloaded' });
    await settle(page, 'street', 4000);
    await hideHud(page);
    await reachWeather(
      page,
      'gale',
      (s) => s.wind >= 0.55 && s.hour > 7.5 && s.hour < 21.5,
      480000,
      700,
    ).catch(() => {});
    await waitForClock(page, 6);
    await shot(page, 'sitka-street-gale-1');
    await waitForClock(page, 6);
    await shot(page, 'sitka-street-gale-2');
  } else if (scene === 'zurich-gale') {
    // Zürich (temperate band): where the day's wind actually lives (census: max
    // 1.00, 70% of daytime above 0.6 — vs Sitka's rainforest ceiling of 0.56).
    await page.goto(`${BASE}/?at=47.3769,8.5417#0,1.7,0,-1.5708,0.08`, {
      waitUntil: 'domcontentloaded',
    });
    await settle(page, 'zurich', 4000);
    await hideHud(page);
    await reachWeather(
      page,
      'gale',
      (s) => s.wind >= 0.75 && s.hour > 7.5 && s.hour < 21,
      480000,
      700,
    ).catch(() => {});
    await waitForClock(page, 6);
    await shot(page, 'zurich-street-gale-1');
    await waitForClock(page, 6);
    await shot(page, 'zurich-street-gale-2');
  } else if (scene === 'arrival') {
    // A real first visit: the establishing glide. Capture the start pose and a mid-glide frame.
    await page.goto(`${BASE}/?at=${PLACE}`, { waitUntil: 'domcontentloaded' });
    let est = null;
    for (let i = 0; i < 40 && !est; i++) {
      const p = await page.evaluate(() => window.__otherhere?.pose ?? null);
      if (p && (p.y > 50 || Math.abs(p.x) > 50 || Math.abs(p.z) > 50)) est = p;
      else await page.waitForTimeout(1000);
    }
    log('establishing pose:', JSON.stringify(est));
    writeFileSync(`${OUT}/sitka-arrival-pose.json`, JSON.stringify(est, null, 2));
    await page.waitForTimeout(6000); // mid-glide
    await hideHud(page);
    await shot(page, 'sitka-arrival-glide');
    await settle(page, 'arrival', 3000);
    await shot(page, 'sitka-arrival-landed');
  } else if (
    scene === 'establishing' ||
    scene === 'establishing-calm' ||
    scene === 'establishing-wind'
  ) {
    // The establishing viewpoint (the arrival shot's frame), pinned via hash, at
    // both weathers: the whole forest wall in one view, still and then blowing.
    const { readFileSync } = await import('node:fs');
    const est = JSON.parse(readFileSync(`${OUT}/sitka-arrival-pose.json`, 'utf8'));
    const fmt = (n, d) => Number(n.toFixed(d));
    const hash = `#${fmt(est.x, 2)},${fmt(est.y, 2)},${fmt(est.z, 2)},${fmt(est.yaw, 4)},${fmt(est.pitch, 4)}`;
    log('establishing hash:', hash);
    await page.goto(`${BASE}/?at=${PLACE}${hash}`, { waitUntil: 'domcontentloaded' });
    await settle(page, 'establishing', 3000);
    await hideHud(page);
    if (scene !== 'establishing-wind') {
      await page.waitForTimeout(4000);
      await reachWeather(page, 'calm', (s) => s.cloud >= 0.78 && s.wind < 0.02);
      await waitForClock(page, 4);
      await shot(page, 'sitka-arrival-calm-1');
      await waitForClock(page, 4);
      await shot(page, 'sitka-arrival-calm-2');
    }
    if (scene !== 'establishing-calm') {
      await reachWeather(
        page,
        'windy',
        (s) => s.wind >= 0.4 && s.hour > 8 && s.hour < 19.5,
        420000,
      );
      await waitForClock(page, 4);
      await shot(page, 'sitka-arrival-wind-1');
      await waitForClock(page, 4);
      await shot(page, 'sitka-arrival-wind-2');
    }
  }
} finally {
  await browser.close();
}
log('done');
