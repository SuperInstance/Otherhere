// apps/client/playtest/sky-shoot.mjs — OTHERHERE LANE B, round 1 evidence.
// Screenshots the living sky at pinned hours (?t=) so the day's arc is one
// glanceable contact sheet. Local dev only (the built client + local Worker).
//
//   node playtest/sky-shoot.mjs --base http://localhost:8787
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? f : process.argv[i + 1];
};
const BASE = arg('base', 'http://localhost:8787');
const OUT = new URL('../../../../playtest-artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const HOURS = [
  ['dawn', 5.75],
  ['morning', 9.5],
  ['noon', 12.25],
  ['golden', 18.5],
  ['night', 22.5],
];
const PLACES = [
  ['sitka', '57.0531,-135.33'], // rainforest prior: heavier skies
];

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const [place, at] of PLACES) {
  for (const [name, t] of HOURS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
    await page.goto(`${BASE}/?at=${at}&t=${t}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // settle: cells ready, then a beat for the sky uniforms to land
    for (let i = 0; i < 120; i++) {
      const s = await page.evaluate(() => window.__otherhere?.stats);
      if (s && s.ready > 0 && s.loading === 0) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    const sky = await page.evaluate(() => window.__otherhere?.sky ?? null);
    await page.screenshot({ path: `${OUT}sky-${place}-${name}.png` });
    console.log(`sky-${place}-${name} t=${t}`, JSON.stringify(sky), 'errors:', errors.length);
    await page.close();
  }
}
await browser.close();
console.log(`[sky-shoot] done -> ${OUT}`);
