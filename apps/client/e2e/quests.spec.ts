import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type Debug = {
  stats: { ready: number; loading: number; quests: number };
  quests: { featureId: string; x: number; z: number; top: number }[];
};
const debug = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __otherhere?: Debug }).__otherhere);

test('quest beacons mark imagined buildings, and a photo completes one', async ({
  page,
  request,
}) => {
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  await page.goto('/?at=47.3769,8.5417#-120,140,260,-0.35,-0.55');
  await expect
    .poll(async () => (await debug(page))?.stats, { timeout: 60_000 })
    .toMatchObject({ ready: 7, loading: 0 });
  const { stats, quests } = (await debug(page))!;
  // Three per Cell at most, and every one has a beacon.
  expect(stats.quests).toBeGreaterThan(0);
  expect(stats.quests).toBeLessThanOrEqual(21);
  expect(quests).toHaveLength(stats.quests);
  await expect(page.locator('#status')).toContainText('nearby: photograph a building');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/quests.png' });

  // Hover straight above one quest building and tap the middle of the screen.
  const q = quests[0]!;
  await page.goto('about:blank');
  await page.goto(`/?at=47.3769,8.5417#${q.x},${q.top + 40},${q.z},0,-1.5707`);
  await expect.poll(async () => (await debug(page))?.stats.loading, { timeout: 60_000 }).toBe(0);
  await expect
    .poll(async () => (await debug(page))?.quests.map((x) => x.featureId), { timeout: 60_000 })
    .toContain(q.featureId);
  // The first tap after a load can land before the camera settles; allow time for the panel.
  await page.mouse.click(640, 400);
  await expect(page.locator('#feature-quest')).toContainText('Quest:', { timeout: 15_000 });

  await page
    .locator('#photo')
    .setInputFiles(new URL('../../../docs/img/demo.png', import.meta.url).pathname);
  await expect(page.locator('#feature-result')).toContainText('Quest complete (1 so far)', {
    timeout: 30_000,
  });
  // The building's Facts now come from the photo, so its Quest is gone.
  await expect
    .poll(async () => (await debug(page))?.quests.map((x) => x.featureId), { timeout: 30_000 })
    .not.toContain(q.featureId);
});
