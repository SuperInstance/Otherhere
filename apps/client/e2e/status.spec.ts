import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Stats = { ready: number; loading: number; mismatched: number; sketch: number };
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

test('a failed hash check is announced once, not on every Cell that lands (review P1 #8)', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });

  // Corrupt exactly one served Bundle: flip the file's last byte, inside the
  // GLB's BIN chunk, so it still parses but the client's sha256 no longer
  // matches the manifest — the real stale-R2-bytes failure, staged in the
  // browser. Every later Bundle crosses untouched, so the Cells that land
  // afterwards are healthy.
  let corruptedOne = false;
  await page.route('**/api/bundles/*.glb', async (route) => {
    const res = await route.fetch();
    const buf = Buffer.from(await res.body());
    if (!corruptedOne && buf.length > 64) {
      corruptedOne = true;
      buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
    }
    await route.fulfill({ response: res, body: buf });
  });

  await page.goto('/?at=47.3769,8.5417&t=9.5#0,1.7,0,0.6,-0.05');
  // The recorder goes on before any Cell lands, so the announcement of the
  // mismatch — the first state of #status that carries the hash-check line —
  // cannot be missed. A live region is read whenever it is written; the line
  // is re-announced exactly when its text changes. The old code moved the
  // whole verified/MISMATCHED counts line into the region, so every Cell that
  // landed read out a new pair of numbers through it (the matcher catches
  // that line too, so a regression shows up as many distinct texts).
  await page.evaluate(() => {
    const status = document.getElementById('status')!;
    const texts: (string | null)[] = [];
    const read = () => {
      const line = [...status.children].find((c) =>
        /hash check|MISMATCHED/.test(c.textContent ?? ''),
      );
      texts.push(line?.textContent ?? null);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(status, { childList: true });
    (window as unknown as { __mismatchLineStates: () => (string | null)[] }).__mismatchLineStates =
      () => {
        obs.disconnect();
        return texts;
      };
  });

  // One Cell lands mismatched, the rest healthy.
  await expect.poll(async () => (await stats(page))?.mismatched ?? 0, { timeout: 120_000 }).toBe(1);
  const settled = (await stats(page))!.ready;

  // Land at least two healthy Cells on top: walk forward through the
  // neighbourhood, the way a player does (trusted keyboard input).
  const canvas = page.locator('canvas');
  await canvas.click(); // focus the walk controls
  for (let seg = 0; seg < 6; seg++) {
    if ((await stats(page))!.ready >= settled + 2) break;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);
  }
  const after = await stats(page);
  // The walk must actually have landed new Cells for this to prove anything.
  expect(after!.ready).toBeGreaterThanOrEqual(settled + 2);
  expect(after!.mismatched).toBe(1); // still exactly the one corrupted Cell

  // Collect the recorder: through the mismatch landing and the healthy
  // landings, the announcement must have appeared and never changed its words.
  const states = await page.evaluate(() =>
    (window as unknown as { __mismatchLineStates: () => (string | null)[] }).__mismatchLineStates(),
  );
  const said = states.filter((t): t is string => t !== null);
  expect(said.length).toBeGreaterThan(0);
  expect(said[0]).toContain('1 cell failed its hash check');
  expect(new Set(said).size).toBe(1); // one announcement, not a running counter
  // Evidence for humans: the notice, visible.
  await page.screenshot({ path: 'test-results/status-mismatch.png' });
});
