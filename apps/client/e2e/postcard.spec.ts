import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectIdentical } from './identical';

type Stats = {
  ready: number;
  loading: number;
  verified: number;
  mismatched: number;
  features: number;
  waking: number;
};
const stats = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __otherhere?: {
            stats: Stats;
            terrain?: { loading: number };
            forest?: { settled: boolean };
          };
        }
      ).__otherhere?.stats,
  );
const display = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __otherhere?: {
            terrain?: { loading: number };
            forest?: { settled: boolean };
          };
        }
      ).__otherhere,
  );

async function settle(page: Page) {
  await expect
    .poll(async () => (await stats(page))?.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await stats(page))?.loading, { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await stats(page))?.waking, { timeout: 60_000 }).toBe(0);
  // The display layers stream after the cells stand (tiles re-stand distant
  // buildings; the forest plants a few chunks a frame) — wait for the quiet world.
  await expect
    .poll(async () => (await display(page))?.terrain?.loading ?? 0, { timeout: 300_000 })
    .toBe(0);
  await expect
    .poll(async () => (await display(page))?.forest?.settled ?? true, { timeout: 300_000 })
    .toBe(true);
  await page.waitForTimeout(500);
}

const hideHud = (page: Page) =>
  page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });

test('save a postcard, open it by link, and see the same place', async ({
  page,
  browser,
  request,
}) => {
  // Two full display settles (saver and friend) under software GL: ~150 s each.
  test.setTimeout(600_000);
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });

  // A pinned hour freezes the sky, so the postcard and its opening see the
  // same one (the saver's link pins the same hour for the friend).
  await page.goto('/?at=47.3769,8.5417&t=9.5#0,1.7,0,0.6,-0.05');
  await settle(page);
  await page.getByText('Save a postcard', { exact: true }).click();
  await page.getByLabel('Postcard title').fill('Bahnhofplatz at dusk');
  await page.getByLabel('Who can open it').selectOption('friends');
  await page.getByRole('button', { name: 'Save postcard' }).click();
  const link = await page.locator('#pc-result a').getAttribute('href', { timeout: 60_000 });
  // The link pins the hour the postcard was saved: a capsule is a frozen moment.
  expect(link).toMatch(/\?c=pc_[a-z2-9]{10}(&k=[a-z2-9]+)?&t=\d{1,2}\.\d{2}$/);
  await hideHud(page);
  const live = await page.screenshot({ path: 'test-results/postcard-live.png' });
  await page.close(); // one software-rendered city at a time

  // A friend opens the link in a fresh browser: Bundles are rebuilt from the snapshot.
  const friendCtx = await browser.newContext();
  const friend = await friendCtx.newPage();
  await friend.goto(new URL(link!).pathname + new URL(link!).search);
  await settle(friend);
  await expect(friend.locator('#status-moment')).toContainText('Postcard: Bahnhofplatz at dusk');
  // The gift arrives clean (playtest r5, lane C): the address box and the
  // routine counts wait behind More options, and expanding brings them back.
  await expect(friend.locator('#goto')).toBeHidden();
  await expect(friend.locator('#hud')).toHaveClass(/gift/);
  // What the recipient and the licence need stays whole (review P0 #2): the
  // moment tier is visible — the attribution rides it too (e2e terrain is
  // closed by design, so its text cannot render here; placement is unit-tested
  // in test/status.test.ts) — and no tier is ever height-clipped.
  await expect(friend.locator('#status-moment')).toBeVisible();
  const clipped = await friend.evaluate(() =>
    ['status-moment', 'status', 'status-cells'].map((id) => {
      const cs = getComputedStyle(document.getElementById(id)!);
      return cs.overflow === 'hidden' || cs.maxHeight !== 'none';
    }),
  );
  expect(clipped).toEqual([false, false, false]);
  // Problems and notices are never clipped away: a quest invitation is a
  // notice, and it must be visible whole in the compact panel.
  await expect(friend.locator('#status span', { hasText: 'quests nearby' })).toBeVisible();
  // The routine counts are a whole tier behind More options, not a mid-line cut.
  await expect(friend.locator('#status-cells')).toBeHidden();
  await friend.getByRole('button', { name: 'More options' }).click();
  await expect(friend.locator('#goto')).toBeVisible();
  await expect(friend.locator('#status-cells')).toBeVisible();
  await friend.getByRole('button', { name: 'Fewer options' }).click();
  await expect(friend.locator('#goto')).toBeHidden();
  const s = await stats(friend);
  expect(s!.ready).toBe(7);
  expect(s!.mismatched).toBe(0);
  await hideHud(friend);
  const shared = await friend.screenshot({ path: 'test-results/postcard-shared.png' });
  // The postcard starts where it was saved and is built from the same Facts, so it
  // looks the same. Two independent browser contexts may round the fog gradient
  // one ulp apart, so the cross-context compare allows a measured sliver and no
  // more; same-context reloads stay byte-exact (the walk spec). Measured, every
  // differing pixel exactly 1/255 with alpha exact: 496 of 1,024,000 on CI's
  // chromium (the environment that gates merges — this is the bound), 466 twice
  // in the dev container's SwiftShader, 172 on CI before the scene-clock fix.
  // Tightening the bound below the environment's own measurement fails the spec;
  // a chromium build change can move it, and the error message carries the new
  // measurement for re-pinning.
  await expectIdentical(shared, live, 1, 496);
  await friendCtx.close();
});

test('private postcards do not open without their key', async ({ page, request }) => {
  const res = await request.post('/api/capsules', {
    data: {
      title: 'Home',
      scope: 'private',
      cells: ['891f8ed951bffff'],
      center: { lat: 47.3769, lng: 8.5417 },
    },
  });
  const { id, ownerKey } = (await res.json()) as { id: string; ownerKey: string };
  await page.goto(`/?c=${id}`);
  await expect(page.getByRole('alert')).toContainText('does not exist, or it is private');
  await page.goto(`/?c=${id}&k=${ownerKey}`);
  await expect(page.locator('#status-moment')).toContainText('Postcard: Home', {
    timeout: 60_000,
  });
});
