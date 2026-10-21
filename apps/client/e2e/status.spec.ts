import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Stats = { ready: number; loading: number };
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __otherhere?: { stats: Stats } }).__otherhere?.stats);

test('the status line announces changes, not the clock (review P0 #4)', async ({
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

  // A pinned hour freezes the sky, so a settled world is fully at rest.
  await page.goto('/?at=47.3769,8.5417&t=9.5#0,1.7,0,0.6,-0.05');
  await expect
    .poll(async () => (await stats(page))?.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await stats(page))?.loading, { timeout: 60_000 }).toBe(0);
  await page.waitForTimeout(700); // let one 500 ms status tick pass

  // A live region announces on every DOM mutation, even a rewrite with
  // identical text. The 500 ms tick used to rewrite the whole status line, so
  // a screen reader announced it twice a second, forever. Now the live tiers
  // must not mutate while nothing changed; the moment tier may tick, because
  // the clock lives there and it is not a live region.
  const mutations = await page.evaluate(
    () =>
      new Promise<{ status: number; cells: number }>((resolve) => {
        const counts = { status: 0, cells: 0 };
        const obs = new MutationObserver((records) => {
          for (const r of records) counts[(r.target as HTMLElement).id as 'status' | 'cells']++;
        });
        obs.observe(document.getElementById('status')!, { childList: true });
        obs.observe(document.getElementById('status-cells')!, { childList: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(counts);
        }, 2600);
      }),
  );
  expect(mutations.status).toBe(0);
  expect(mutations.cells).toBe(0);
});

test('the routine counts are silent; Loaded is announced once, debounced', async ({
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

  await page.goto('/?at=47.3769,8.5417&t=9.5#0,1.7,0,0.6,-0.05');

  // The routine counts change on every cell landing; as a live region they
  // would read a running counter through the whole load (round 08, review of
  // rounds 06-07, item 3). The one thing a listener needs — the place stood
  // up — is said once, after quiet, through the hidden #announce region.
  await expect(page.locator('#status-cells')).not.toHaveAttribute('aria-live');
  await expect(page.locator('#announce')).toHaveAttribute('aria-live', 'polite');

  await expect
    .poll(async () => (await stats(page))?.ready ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await stats(page))?.loading, { timeout: 60_000 }).toBe(0);
  await expect(page.locator('#announce')).toContainText('Loaded', { timeout: 10_000 });

  // A quiet world does not re-announce: count the writes to #announce over
  // a window well past the debounce, after the first announcement landed.
  const writes = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const obs = new MutationObserver((records) => {
          count += records.length;
        });
        obs.observe(document.getElementById('announce')!, { childList: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(count);
        }, 3200);
      }),
  );
  expect(writes).toBe(0);
});
