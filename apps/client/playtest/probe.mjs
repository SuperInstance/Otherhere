// apps/client/playtest/probe.mjs — OTHERHERE LANE A, round 1.
// An exploratory OUTSIDE-IN probe, not a pass/fail test: it plays the game like
// a player (walks, looks, saves a postcard, opens the demo) and RECORDS
// everything it sees — console messages, page errors, failed network requests,
// world stats, and screenshots — so a human can read a session afterwards.
//
// Usage:
//   node playtest/probe.mjs --base http://localhost:8787 --at 47.3769,8.5417 --seed --tag local-zurich
//   node playtest/probe.mjs --base https://otherhere.superinstance.dev --tag live-default
// Artifacts land in ../playtest-artifacts/<tag>-* (PNG + JSON), plus a session
// summary JSON with every console/error/network record.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = arg('base', 'http://localhost:8787');
const AT = arg('at', ''); // "" = the site default (downtown Sitka)
const TAG = arg('tag', 'probe');
const SEED = process.argv.includes('--seed');
const OUT = new URL('../../../../playtest-artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const log = [];
const note = (kind, detail) => {
  const row = { t: new Date().toISOString().slice(11, 23), kind, ...detail };
  log.push(row);
  console.log(`${row.t} [${kind}]`, JSON.stringify(detail).slice(0, 300));
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    note('console', { type: m.type(), text: m.text().slice(0, 500) });
});
page.on('pageerror', (e) => note('pageerror', { message: String(e).slice(0, 500) }));
page.on('requestfailed', (r) =>
  note('requestfailed', { url: r.url().slice(0, 200), error: r.failure()?.errorText }),
);
page.on('response', (r) => {
  if (r.status() >= 400) note('http', { status: r.status(), url: r.url().slice(0, 200) });
});

const stats = () =>
  page.evaluate(() => {
    const o = window.__otherhere;
    return o ? { ...o.stats, backend: o.backend } : null;
  });

const settle = async (label, timeoutMs = 90000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await stats();
    if (s && s.ready > 0 && s.loading === 0) {
      note('settled', { label, seconds: ((Date.now() - t0) / 1000).toFixed(1), ...s });
      return s;
    }
    if (Date.now() - t0 > timeoutMs) {
      note('settle-timeout', { label, waitedSeconds: (timeoutMs / 1000).toFixed(0), last: s });
      return s;
    }
    await page.waitForTimeout(500);
  }
};

const shot = (name) =>
  page.screenshot({ path: `${OUT}${TAG}-${name}.png` }).then((b) => {
    note('shot', { name, bytes: b.length });
  });

try {
  // 0. Seed a recorded block (local dev only) so the probe is reproducible.
  if (SEED) {
    const fixture = readFileSync(
      new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
    );
    const res = await ctx.request.post(`${BASE}/api/dev/blocks/881f8ed951fffff`, {
      data: fixture,
      headers: { 'content-type': 'application/json' },
    });
    note('seed', { status: res.status() });
  }

  // 1. Arrive like a player.
  const url = `${BASE}/${AT ? `?at=${AT}` : ''}`;
  note('goto', { url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shot('01-arrival');
  await settle('arrival');
  await shot('02-settled');

  // 2. Walk forward for ~12s in bursts, turning between them; screenshot as we go.
  const canvas = page.locator('canvas');
  await canvas.click({ position: { x: 640, y: 400 } }); // focus
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down(i % 2 ? 'KeyW' : 'ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await shot(`03-walk-${i + 1}`);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    // look around a bit
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640 + (i % 2 ? 260 : -260), 400 - i * 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  const s2 = await stats();
  note('after-walk', { stats: s2 });
  await shot('04-after-walk');

  // 3. The generator demo view.
  await page.goto(`${BASE}/?demo=generators`, { waitUntil: 'domcontentloaded' });
  await settle('demo', 60000);
  await shot('05-demo-generators');

  // 4. Back to the place; try the goto form with a place name.
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

  // 5. Save a postcard (public) and read back its link.
  try {
    await page.getByText('Save a postcard', { exact: true }).click({ timeout: 5000 });
    await page.getByLabel('Postcard title').fill('Probe round 1');
    await page.getByLabel('Who can open it').selectOption('public');
    await page.getByRole('button', { name: 'Save postcard' }).click();
    const link = await page.locator('#pc-result a').getAttribute('href', { timeout: 30000 });
    note('postcard', { link });
    await shot('07-postcard-saved');
    if (link) {
      await page.goto(`${BASE}${link}`, { waitUntil: 'domcontentloaded' });
      await settle('postcard-open', 90000);
      await shot('08-postcard-opened');
    }
  } catch (e) {
    note('postcard-failed', { error: String(e).slice(0, 300) });
    await shot('07-postcard-failed');
  }

  // 6. HUD facts at close.
  const status = await page
    .locator('#status')
    .textContent()
    .catch(() => null);
  note('hud-status', { status });
  await shot('09-final');
} finally {
  writeFileSync(`${OUT}${TAG}-session.json`, JSON.stringify({ base: BASE, at: AT, log }, null, 2));
  await browser.close();
}
console.log(`\n[probe] done — artifacts in ${OUT} (tag ${TAG}), ${log.length} log rows`);
