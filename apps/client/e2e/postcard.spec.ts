import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Stats = {
  ready: number;
  loading: number;
  verified: number;
  mismatched: number;
  features: number;
};
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __otherhere?: { stats: Stats } }).__otherhere?.stats);

async function settle(page: Page) {
  await expect
    .poll(async () => (await stats(page))?.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await stats(page))?.loading, { timeout: 60_000 }).toBe(0);
  await page.waitForTimeout(500);
}

const hideHud = (page: Page) =>
  page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });

test('save a postcard, open it by link, and see the same place', async ({
  page,
  browser,
  request,
}) => {
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
  await expect(friend.locator('#status')).toContainText('Postcard: Bahnhofplatz at dusk');
  const s = await stats(friend);
  expect(s!.ready).toBe(7);
  expect(s!.mismatched).toBe(0);
  await hideHud(friend);
  const shared = await friend.screenshot({ path: 'test-results/postcard-shared.png' });
  // The postcard starts where it was saved and is built from the same Facts, so it looks the same.
  expect(shared.equals(live)).toBe(true);
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
  await expect(page.locator('#status')).toContainText('Postcard: Home', { timeout: 60_000 });
});
