// apps/client/playtest/f1-postcard.mjs — LANE A, round 3: F1's live-only
// reproduction instrument. The round-2 finding: on the live site the Save
// button RESOLVES but the click never lands ("waiting for element to be
// visible, enabled and stable", 30 s), while the same flow succeeds on local
// dev. This probe captures the moment of the failed click from inside the
// page — the button's bounding box every 200 ms (Playwright's stability check
// needs the SAME box on two consecutive animation frames), what sits at the
// click point (elementFromPoint — an overlay would intercept the hit), the
// computed style, the rAF frame rate (software GL runs at 1–3 fps; if the
// render loop stalls below ~0.07 fps two frames never fit in 30 s), and the
// HUD's scroll state. Then it attempts the real click with the sampler still
// running, so the failure and its cause land in the same JSON.
//
// Usage:
//   node playtest/f1-postcard.mjs --base https://otherhere.casey-digennaro.workers.dev --tag live-f1
//   node playtest/f1-postcard.mjs --base http://localhost:5173 --at 47.3769,8.5417 --seed --tag local-f1
// Artifacts: otherhere-lab/playtest-artifacts/<tag>-f1.json (+ -f1.png screenshots)

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = arg('base', 'https://otherhere.casey-digennaro.workers.dev');
const AT = arg('at', ''); // "" = the site default (downtown Sitka)
const TAG = arg('tag', 'live-f1');
const OUT = process.env.PLAYTEST_OUT ?? new URL('../../../../otherhere-lab/playtest-artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const chromiumPath =
  process.env.PW_CHROMIUM ??
  (() => {
    const root = join(homedir(), '.cache', 'ms-playwright');
    if (!existsSync(root)) return undefined;
    const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
    if (!dir) return undefined;
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
    return undefined;
  })();

const url = () => (AT ? `${BASE}/?at=${AT}` : `${BASE}/`);
const rows = [];
const note = (kind, data = {}) =>
  rows.push({ t: Date.now() - t0, kind, ...data }) || console.log(`[${kind}]`, JSON.stringify(data).slice(0, 200));
const t0 = Date.now();

// The in-page sampler: 200 ms ticks for the whole session. Returns a stop()
// handle; the samples array is read back through the page handle.
const SAMPLER = () => {
  const samples = [];
  const btn = document.querySelector('#postcard button[type=submit]');
  const hud = document.getElementById('hud');
  let rafCount = 0;
  const rafLoop = () => { rafCount++; requestAnimationFrame(rafLoop); };
  requestAnimationFrame(rafLoop);
  const iv = setInterval(() => {
    const s = { t: Date.now(), raf: rafCount };
    if (btn) {
      const r = btn.getBoundingClientRect();
      s.box = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      s.hit = hit === btn ? 'button' : hit ? `${hit.tagName.toLowerCase()}#${hit.id || ''}.${hit.className || ''}`.slice(0, 60) : 'none';
      const cs = getComputedStyle(btn);
      s.style = { display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, opacity: cs.opacity };
      s.disabled = btn.disabled;
      const det = btn.closest('details');
      s.open = det ? det.open : null;
      s.label = btn.textContent.trim();
    } else s.gone = true;
    if (hud) s.hudScroll = { sh: hud.scrollHeight, ch: hud.clientHeight, top: hud.scrollTop };
    s.focus = document.hasFocus();
    s.vis = document.visibilityState;
    s.statusLen = (document.getElementById('status')?.textContent ?? '').length;
    samples.push(s);
  }, 200);
  window.__f1 = { samples, stop: () => { clearInterval(iv); window.__f1.done = true; } };
};

const summarize = (samples) => {
  const arr = Array.isArray(samples) ? samples : [];
  const withBtn = arr.filter((s) => s && s.box && typeof s.box === 'object');
  const boxes = withBtn.map((s) => s.box);
  const key = (b) => `x${b.x} y${b.y} w${b.w} h${b.h}`;
  const uniq = new Set(boxes.map(key));
  const fps =
    arr.length > 1 && arr[arr.length - 1].t && arr[0].t
      ? arr[arr.length - 1].raf / ((arr[arr.length - 1].t - arr[0].t) / 1000)
      : 0;
  const hits = {};
  for (const s of withBtn) hits[s.hit] = (hits[s.hit] ?? 0) + 1;
  const styles = new Set(withBtn.map((s) => JSON.stringify(s.style ?? {})));
  const opens = new Set(withBtn.map((s) => s.open));
  const focus = new Set(arr.map((s) => (s ? s.focus : undefined)));
  const statusLens = new Set(arr.map((s) => (s ? s.statusLen : undefined)));
  return {
    n: arr.length, nButton: withBtn.length,
    fps: +fps.toFixed(2),
    uniqueBoxes: uniq.size, boxExamples: [...uniq].slice(0, 6),
    hitTargets: hits, uniqueStyles: [...styles].map((s) => JSON.parse(s)),
    detailsOpen: [...opens], pageFocus: [...focus], statusLengths: [...statusLens].sort((a, b) => a - b),
  };
};

const browser = await chromium.launch({ executablePath: chromiumPath, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('console', (m) => note('console', { type: m.type(), text: m.text().slice(0, 160) }));
page.on('pageerror', (e) => note('pageerror', { error: String(e).slice(0, 200) }));
page.on('requestfailed', (r) => note('netfail', { url: r.url().slice(0, 120), err: r.failure()?.errorText }));

note('start', { base: BASE, at: AT || '(default Sitka)', url: url() });
await page.goto(url(), { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the world to be ready enough to save a postcard: cells loaded.
await page.waitForFunction(
  () => {
    const w = window.__otherhere;
    return w?.stats?.ready >= 1;
  },
  { timeout: 90000, polling: 1000 },
);
note('world-ready', { stats: await page.evaluate(() => window.__otherhere?.stats) });

// Install the sampler BEFORE any interaction, so the whole flow is covered.
await page.evaluate(SAMPLER);

// Open the postcard details (attribute fallback: the r1/r2 law for slow pages).
const opened = await page.evaluate(() => {
  const d = document.querySelector('#postcard details');
  if (d && !d.open) d.setAttribute('open', '');
  return d?.open ?? false;
});
note('details-open', { opened });

await page.getByLabel('Postcard title').fill('F1 reproduction', { timeout: 30000 });
await page.getByLabel('Who can open it').selectOption('public', { timeout: 30000 });
note('form-filled');

// 8 s of quiet sampling — the button at rest.
await page.waitForTimeout(8000);
const rest = await page.evaluate(() => window.__f1.samples.splice(0));
note('rest-summary', summarize(rest));

// The click itself, with a long budget and the sampler running through it.
const clickResult = { clicked: false, error: null, ms: null };
const clickStart = Date.now();
try {
  await page.getByRole('button', { name: 'Save postcard' }).click({ timeout: 45000 });
  clickResult.clicked = true;
} catch (e) {
  clickResult.error = String(e).slice(0, 500);
}
clickResult.ms = Date.now() - clickStart;
note('click', clickResult);

// Did the POST go out? Did the result link appear?
const link = await page.locator('#pc-result a').getAttribute('href', { timeout: 30000 }).catch(() => null);
note('result', { link, pcResult: await page.locator('#pc-result').textContent().catch(() => null) });

const during = await page.evaluate(() => window.__f1.samples.splice(0));
note('during-summary', summarize(during));
await page.evaluate(() => window.__f1.stop());

await page.screenshot({ path: `${OUT}${TAG}-f1.png` });
writeFileSync(
  `${OUT}${TAG}-f1.json`,
  JSON.stringify({ tag: TAG, base: BASE, at: AT, url: url(), clickResult, link, rows, rest, during, restSummary: summarize(rest), duringSummary: summarize(during) }, null, 1),
);
console.log(`\n[f1] click: ${clickResult.clicked ? 'LANDED' : 'FAILED'} in ${clickResult.ms}ms`);
console.log(`[f1] link: ${link ?? 'none'}`);
console.log(`[f1] artifacts: ${OUT}${TAG}-f1.{json,png}`);
await browser.close();
