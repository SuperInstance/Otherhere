import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('tap a building, add a photo, and it sharpens with Facts from the photo', async ({
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

  // Looking straight down from 120 m over dense central Zürich: most taps land on a roof.
  await page.goto('/?at=47.3769,8.5417#126,120,-112,0,-1.5');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __otherhere?: { stats: { ready: number; loading: number } } })
              .__otherhere?.stats,
        ),
      { timeout: 60_000 },
    )
    .toMatchObject({ ready: 7, loading: 0 });

  const panel = page.locator('#feature');
  outer: for (const y of [400, 300, 500, 200, 600, 100, 700]) {
    for (const x of [640, 760, 520, 880, 1000, 1120, 1240, 400]) {
      await page.mouse.click(x, y);
      if (await panel.isVisible()) break outer;
    }
  }
  await expect(panel).toBeVisible();
  await expect(page.locator('#feature-facts')).toContainText('from OpenStreetMap');

  await page
    .locator('#photo')
    .setInputFiles(new URL('../../../docs/img/demo.png', import.meta.url).pathname);
  await expect(page.locator('#feature-result')).toContainText('This building is now sharper', {
    timeout: 30_000,
  });
  await expect(page.locator('#feature-facts')).toContainText('Roof: gable (from a photo');
  await page.screenshot({ path: 'test-results/photo.png' });
});
