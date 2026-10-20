/**
 * OH-B2 orientation probe: street level at four yaws, quick settle, to pick the
 * street pose for the calm/wind pairs. Software GL: ~1-3 fps, keep legs short.
 */
import { chromium } from '@playwright/test';

const OUT = '/home/z/my-project/otherhere-lab/playtest-artifacts';
const EXE =
  '/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:8787';
const PLACE = '57.0531,-135.33';

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
const log = (...a) => console.log(`[${Math.floor(process.uptime())}s]`, ...a);

// Yaw 0 faces north (-z), positive yaw turns east? Probe N/E/S/W.
for (const [name, yaw] of [
  ['north', 0],
  ['east', -1.5708],
  ['south', 3.1416],
  ['west', 1.5708],
]) {
  await page.goto(`${BASE}/?at=${PLACE}#0,1.7,0,${yaw.toFixed(4)},0.05`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(75000);
  const s = await page.evaluate(() => window.__otherhere ?? null);
  await page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
  await page.screenshot({ path: `${OUT}/probe-street-${name}.png` });
  log(
    `${name}: sky=${JSON.stringify(s?.sky)} forest=${JSON.stringify(s?.forest)} ready=${s?.stats?.ready}`,
  );
}
await browser.close();
log('done');
