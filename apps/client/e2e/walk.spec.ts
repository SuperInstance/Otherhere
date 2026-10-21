import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Stats = {
  ready: number;
  loading: number;
  verified: number;
  mismatched: number;
  features: number;
  sketch: number;
  waking: number;
};

const stats = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __otherhere?: {
            stats: Stats;
            backend: string;
            terrain?: { loading: number };
            forest?: { settled: boolean };
          };
        }
      ).__otherhere,
  );

/** Compare only the rendered world: hide the HUD overlays, whose text can legitimately differ. */
const sceneShot = async (page: Page, path: string) => {
  await page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
  await page.bringToFront(); // background pages get no animation frames
  return page.screenshot({ path }); // the canvas fills the viewport
};

async function settle(page: Page, cells: number) {
  await expect
    .poll(async () => (await stats(page))?.stats.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(cells);
  await expect.poll(async () => (await stats(page))?.stats.loading, { timeout: 60_000 }).toBe(0);
  // A cell still waking is still changing what the frame shows.
  await expect.poll(async () => (await stats(page))?.stats.waking, { timeout: 60_000 }).toBe(0);
  // The display layers stream after the cells stand: elevation tiles still
  // decoding re-stand distant buildings, and the forest plants a few chunks a
  // frame. A shot before they finish is a shot of a half-built world.
  await expect
    .poll(async () => (await stats(page))?.terrain?.loading ?? 0, { timeout: 300_000 })
    .toBe(0);
  await expect
    .poll(async () => (await stats(page))?.forest?.settled ?? true, { timeout: 300_000 })
    .toBe(true);
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
  // Settling the full display (cells, wakes, elevation tiles, forest) takes ~150 s
  // per load under software GL at ~1 fps — CI's real rendering is far faster.
  test.setTimeout(600_000);
  // Seed the recorded Zürich block through the dev-only route (no network needed).
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  const seeded = await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  expect(seeded.ok()).toBe(true);

  // A pinned hour freezes the sky (the world still rebuilds identically;
  // the day clock is display-layer and deliberately moves otherwise).
  await page.goto('/?at=47.3769,8.5417&t=9.5#0,1.7,0,0.6,-0.05');
  await settle(page, 7);
  const s = await stats(page);
  expect(s!.stats.mismatched).toBe(0);
  expect(s!.stats.verified).toBe(s!.stats.ready);
  expect(s!.stats.features).toBeGreaterThan(1000);
  const before = await sceneShot(page, `test-results/zurich-${info.repeatEachIndex}-a.png`);

  // The determinism law itself: a pinned scene holds still. Everything that
  // visibly moves — the ocean, cloud shadows, mist, stars — rides the sky's
  // freezable clock, so three seconds later the same load renders byte-exact.
  await page.waitForTimeout(3000);
  const still = await sceneShot(page, `test-results/zurich-${info.repeatEachIndex}-a2.png`);
  expect(still.equals(before)).toBe(true);

  await page.reload();
  await settle(page, 7);
  const after = await sceneShot(page, `test-results/zurich-${info.repeatEachIndex}-b.png`);
  expect(after.equals(before)).toBe(true);
});

test('starts in downtown Sitka when no place is given', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Address, place or coordinates')).toHaveValue('57.0531, -135.3351');
});

test('a place found by address keeps its name in the box', async ({ page }) => {
  await page.goto('/?at=57.0531,-135.3351&q=Lincoln%20St%2C%20Sitka');
  await expect(page.getByLabel('Address, place or coordinates')).toHaveValue('Lincoln St, Sitka');
});

test('an address that cannot be looked up gets a recoverable message', async ({ page }) => {
  // Tests point the edge's Nominatim at a closed port, so every lookup fails.
  await page.goto('/?at=47.3769,8.5417');
  await page.getByLabel('Address, place or coordinates').fill('Lincoln St, Sitka, AK');
  await page.getByRole('button', { name: 'Walk here' }).click();
  // The edge gives up on the lookup after 8 s (geocode.ts), and a closed port does not
  // always refuse at once on CI runners: wait longer than the edge does.
  await expect(page.getByRole('alert')).toContainText('use coordinates', { timeout: 15_000 });
});
