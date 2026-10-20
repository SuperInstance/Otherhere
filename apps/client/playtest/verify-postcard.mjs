// Verify a saved postcard link opens with its pinned hour and rebuilt world.
const link = process.argv[2];
if (!link) {
  console.error('usage: node verify-postcard.mjs <url>');
  process.exit(1);
}
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
const root = join(homedir(), '.cache', 'ms-playwright');
const dir = existsSync(root)
  ? readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .at(-1)
  : undefined;
const p =
  dir &&
  (existsSync(join(root, dir, 'chrome-linux64/chrome'))
    ? join(root, dir, 'chrome-linux64/chrome')
    : existsSync(join(root, dir, 'chrome-linux/chrome'))
      ? join(root, dir, 'chrome-linux/chrome')
      : undefined);
const browser = await chromium.launch({
  executablePath: p,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__otherhere?.stats?.ready >= 1, {
  timeout: 90000,
  polling: 1000,
});
const w = await page.evaluate(() => ({
  sky: window.__otherhere.sky,
  stats: window.__otherhere.stats,
  capsuleLine: (document.getElementById('status')?.textContent ?? '').split('\n')[0],
}));
const m = link.match(/[?&]t=([0-9.]+)/);
console.log(
  JSON.stringify(
    {
      pinnedInLink: m ? +m[1] : null,
      skyHour: w.sky?.hour,
      frozen: w.sky?.frozen,
      capsuleLine: w.capsuleLine,
      cells: w.stats?.ready,
    },
    null,
    1,
  ),
);
await page.screenshot({
  path: '/home/z/my-project/otherhere-lab/playtest-artifacts/f1-postcard-opened.png',
});
await browser.close();
