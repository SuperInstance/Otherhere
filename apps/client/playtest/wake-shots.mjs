// apps/client/playtest/wake-shots.mjs — OTHERHERE LANE B, round 4 (the wake
// meter). The wake-up moment's own evidence, the way the wind got its video:
// stand in a SKETCH Cell (a place OpenStreetMap has not answered yet), let the
// data arrive mid-session through the dev seed route, and capture the breath —
// the world going from paper to its true state as the replaced Bundle stands
// in. Software GL runs the page at ~1 fps and the wake lasts 1.6 s, so the
// VIDEO is the primary instrument (r2's law: built for continuous motion, not
// stills); three stills ride along best-effort, and the status line's named
// moment ("just sharpened") is receipted in the log while it is live.
//
// Usage (wrangler dev on 8787 with ALLOW_DEV_ROUTES, the oh-scene driver):
//   node playtest/wake-shots.mjs --base http://localhost:8787 --at 47.3769,8.5417 --tag local-wake
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = arg('base', 'http://localhost:8787');
const AT = arg('at', '47.3769,8.5417'); // the seeded Zurich block
const TAG = arg('tag', 'local-wake');
const OUT = process.env.PLAYTEST_OUT ?? '/home/z/my-project/otherhere-lab/playtest-artifacts';
mkdirSync(OUT, { recursive: true });

const [LAT, LNG] = AT.split(',').map(Number);
const FAR_M = 900; // far enough that the walker's ring leaves the seeded block
const farLat = LAT + FAR_M / 111320;

const log = [];
const note = (kind, detail) => {
  const row = { t: new Date().toISOString().slice(11, 23), kind, ...detail };
  log.push(row);
  console.log(`${row.t} [${kind}]`, JSON.stringify(detail).slice(0, 260));
};

const EXE =
  '/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => note('pageerror', { message: String(e).slice(0, 300) }));
page.on('console', (m) => {
  if (m.type() === 'error') note('console', { text: m.text().slice(0, 300) });
});

const state = () =>
  page
    .evaluate(() => {
      const o = window.__otherhere;
      return o
        ? {
            stats: o.stats,
            sky: o.sky,
            status: document.querySelector('#status')?.textContent ?? '',
          }
        : null;
    })
    .catch(() => null);

const shot = async (name) => {
  const s = await state();
  const b = await page.screenshot({ path: `${OUT}/${TAG}-${name}.png`, timeout: 20000 });
  note('shot', { name, bytes: b.length, waking: s?.stats?.waking, sky: s?.sky?.hour });
  return b;
};

// 1. Seed the ORIGIN block so the start stands on real ground (the r2 law).
const fixture = readFileSync(
  new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
);
{
  const r = await page.request.post(`${BASE}/api/dev/blocks/881f8ed951fffff`, {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  note('seed-origin', { status: r.status() });
}

// 2. Arrive 900 m north: the walker's ring is all sketch Cells there.
await page.goto(`${BASE}/?at=${AT}#0,1.7,-${FAR_M},0.9,-0.02`, { waitUntil: 'domcontentloaded' });
note('goto', { at: AT, pose: `#0,1.7,-${FAR_M},0.9,-0.02` });

// 3. Settle the sketch: cells ready (as sketches), nothing loading.
let sketch = 0;
for (let i = 0; i < 90; i++) {
  const s = await state();
  sketch = s?.stats?.sketch ?? 0;
  if (i % 5 === 0) note('settle', { ready: s?.stats?.ready, loading: s?.stats?.loading, sketch });
  if (s && s.stats.ready > 0 && s.stats.loading === 0) break;
  await page.waitForTimeout(4000);
}
note('sketch-settled', { sketch });
await shot('10-sketch-standing'); // the paper world we stand in

// 4. The data arrives (as if Overpass recovered): the same fixture, far block.
//    The sketch Cells retry on their own; when the block turns ok the retry's
//    reload stands the real Bundle in — THE WAKE.
const h3 = await import('h3-js');
const farCell = h3.latLngToCell(farLat, LNG, 9);
const farBlock = h3.cellToParent(farCell, 8);
note('seed-plan', { farCell, farBlock });
{
  const r = await page.request.post(`${BASE}/api/dev/blocks/${farBlock}`, {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  note('seed-far', { status: r.status(), block: farBlock });
}

// 5. Watch for the wake: poll fast (the breath is 1600 ms), catch it live.
let wakeSeen = false;
let statusAtWake = '';
let t0 = 0;
for (let i = 0; i < 240; i++) {
  const s = await state();
  const w = s?.stats?.waking ?? 0;
  if (w > 0) {
    wakeSeen = true;
    statusAtWake = s?.status ?? '';
    t0 = Date.now();
    note('WAKE-DETECTED', {
      waking: w,
      statusFirstLine: statusAtWake.split('\n').find((l) => /sharpen/i.test(l)) ?? null,
    });
    break;
  }
  if (i % 10 === 0)
    note('watch', {
      seconds: i * 0.5,
      ready: s?.stats?.ready,
      loading: s?.stats?.loading,
      sketch: s?.stats?.sketch,
    });
  await page.waitForTimeout(500);
}

if (wakeSeen) {
  await shot('20-wake-A'); // as early as the frames allow
  await page.waitForTimeout(700);
  await shot('21-wake-B');
  await page.waitForTimeout(900);
  await shot('22-wake-C'); // the world settled true
  const s = await state();
  note('wake-after', {
    waking: s?.stats?.waking,
    sketch: s?.stats?.sketch,
    statusStillNamesIt: /sharpen/i.test(s?.status ?? ''),
  });
} else {
  note('wake-missed', {
    hint: 'no waking>0 within 120 s of the seed — did the sketch retry fire?',
  });
  await shot('20-no-wake');
}

// 6. The video lands only on context close (the r2 law).
const video = page.video();
await ctx.close();
await browser.close();
if (video) {
  try {
    const p = await video.path();
    if (p) copyFileSync(p, `${OUT}/${TAG}-session.webm`);
  } catch {
    /* best effort */
  }
}
writeFileSync(
  `${OUT}/${TAG}-session.json`,
  JSON.stringify({ tag: TAG, base: BASE, at: AT, log }, null, 1),
);
console.log(`\n[wake] wakeSeen=${wakeSeen}; artifacts in ${OUT} (${TAG}-*)`);
