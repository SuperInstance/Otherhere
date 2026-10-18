import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Not an assertion of looks: produces an overview image for humans reviewing changes.
test('aerial overview of the seeded Zürich block', async ({ page, request }) => {
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });
  await page.goto('/?at=47.3769,8.5417#-120,140,260,-0.35,-0.55');
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
    .toMatchObject({ loading: 0 });
  await page.waitForTimeout(500);
  await page.addStyleTag({ content: '#hud, #help { visibility: hidden !important; }' });
  await page.screenshot({ path: 'test-results/aerial.png' });
});
