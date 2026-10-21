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
