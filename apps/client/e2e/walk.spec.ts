import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Stats = {
  ready: number;
  loading: number;
  verified: number;
  mismatched: number;
  features: number;
  sketch: number;
};

const stats = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __otherhere?: { stats: Stats; backend: string } }).__otherhere,
  );

/** Compare only the rendered world: hide the HUD overlays, whose text can legitimately differ. */
const sceneShot = async (page: Page, path: string) => {
  await page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
  return page.locator('canvas').screenshot({ path });
};

async function settle(page: Page, cells: number) {
  await expect
    .poll(async () => (await stats(page))?.stats.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(cells);
  await expect.poll(async () => (await stats(page))?.stats.loading, { timeout: 60_000 }).toBe(0);
  await page.waitForTimeout(500);
}

test('generator demo builds in the browser with the golden hash', async ({ page }) => {
  await page.goto('/?demo=generators');
  await settle(page, 1);
  const s = await stats(page);
  expect(s!.stats.verified).toBe(1);
  expect(s!.stats.mismatched).toBe(0);
  await page.screenshot({ path: 'test-results/demo.png' });
});

test('walk a real neighbourhood; reload gives the identical scene', async ({
  page,
  request,
}, info) => {
  // Seed the recorded Zürich block through the dev-only route (no network needed).
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  const seeded = await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto('/?at=47.3769,8.5417#0,1.7,0,0.6,-0.05');
  await settle(page, 7);
  const s = await stats(page);
  expect(s!.stats.mismatched).toBe(0);
  expect(s!.stats.verified).toBe(s!.stats.ready);
  expect(s!.stats.features).toBeGreaterThan(1000);
  const before = await sceneShot(page, `test-results/zurich-${info.repeatEachIndex}-a.png`);

  await page.reload();
  await settle(page, 7);
  const after = await sceneShot(page, `test-results/zurich-${info.repeatEachIndex}-b.png`);
  expect(after.equals(before)).toBe(true);
});

test('rejects malformed coordinates with a recoverable message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Coordinates').fill('zurich');
  await page.getByRole('button', { name: 'Walk here' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter latitude and longitude');
});
