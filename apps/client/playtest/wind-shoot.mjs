// apps/client/playtest/wind-shoot.mjs — OTHERHERE LANE B, round 2 (motion meter).
// A focused FEEL probe for the wind in the crowns: settle at street level in a
// forested place, read the weather and the wind, then take two screenshots of
// the same pinned view ~9 s apart (most of a gust period) and count the pixels
// that moved. calm overcast should move ~nothing; clear sky should move the
// crowns. Artifacts land in ../playtest-artifacts/<tag>-*.
//
// Usage:
//   node playtest/wind-shoot.mjs --base http://localhost:5173 --at 57.0531,-135.33 --tag local-sitka-wind

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = arg('base', 'http://localhost:8787');
const AT = arg('at', '57.0531,-135.33');
const TAG = arg('tag', 'wind');
const GAP_MS = Number(arg('gap', '9000'));
const OUT = '/home/z/my-project/otherhere-lab/playtest-artifacts';
mkdirSync(OUT, { recursive: true });

const log = [];
const note = (kind, detail) => {
  const row = { t: new Date().toISOString().slice(11, 23), kind, ...detail };
  log.push(row);
  console.log(`${row.t} [${kind}]`, JSON.stringify(detail).slice(0, 300));
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
page.on('pageerror', (e) => note('pageerror', { message: String(e).slice(0, 400) }));
page.on('console', (m) => {
  if (m.type() === 'error') note('console', { text: m.text().slice(0, 400) });
});

const state = () =>
  page.evaluate(() => {
    const o = window.__otherhere;
    return o
      ? {
          stats: o.stats,
          sky: o.sky,
          terrain: o.terrain && { active: o.terrain.active, chunks: o.terrain.chunks },
          forest: o.forest,
          status: document.querySelector('#status')?.textContent ?? '',
        }
      : null;
  });

const url = `${BASE}/?at=${AT}`;
note('goto', { url });
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Wait for the world to settle and the display forest to plant (near chunks
// first; a few thousand trees is plenty for a street-level read). Software GL
// renders at 1-3 fps, so this is patient by design.
let s;
const t0 = Date.now();
for (;;) {
  s = await state();
  const ready = s?.stats?.ready ?? 0;
  const trees = s?.forest?.trees ?? 0;
  if (ready > 0 && s.terrain?.active && trees > 4000) break;
  if (Date.now() - t0 > 240_000) {
    note('timeout', { ready, trees, terrain: s?.terrain });
    break;
  }
  await page.waitForTimeout(2500);
}
note('settled', {
  seconds: Math.round((Date.now() - t0) / 1000),
  ready: s?.stats?.ready,
  features: s?.stats?.features,
  trees: s?.forest?.trees,
  chunks: s?.forest?.chunks,
  cloud: s?.sky?.cloud,
  wind: s?.sky?.wind,
  hour: s?.sky?.hour,
});
note('status', { text: s?.status.split('\n')[0] ?? '' });

const shot = (name) => page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });

// Two shots of the same view, GAP_MS apart: whatever moved, moved.
await shot('a');
await page.waitForTimeout(GAP_MS);
const s2 = await state();
await shot('b');
note('between', { cloud: s2?.sky?.cloud, wind: s2?.sky?.wind, hour: s2?.sky?.hour });

// Count differing pixels (the e2e's honest-diff idea, reused as a motion meter).
const a = PNG.sync.read(readFileSync(`${OUT}/${TAG}-a.png`));
const b = PNG.sync.read(readFileSync(`${OUT}/${TAG}-b.png`));
let moved = 0;
let maxDiff = 0;
if (a.width === b.width && a.height === b.height) {
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d > 2) moved++;
    maxDiff = Math.max(maxDiff, d);
  }
}
note('motion', {
  pixelsMoved: moved,
  of: a.width * a.height,
  share: Number((moved / (a.width * a.height)).toFixed(4)),
  maxChannelDiff: maxDiff,
  windAtShots: [s?.sky?.wind, s2?.sky?.wind],
});

writeFileSync(`${OUT}/${TAG}-session.json`, JSON.stringify({ url, log }, null, 2));
// Save the video of the whole session (software-GL stop-motion of the sway).
// The webm only finalises when the context closes, so close first, then copy.
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
