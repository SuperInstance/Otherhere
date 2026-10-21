import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

/** A flat, valid Terrarium elevation tile: 0 m everywhere is RGB (128, 0, 0). */
function terrariumTile(): Buffer {
  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 128;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('a gift on a phone keeps the error, the host button and the attribution visible', async ({
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

  // A postcard anyone with the link can open, saved through the API.
  const res = await request.post('/api/capsules', {
    data: {
      title: 'A gift from Zürich',
      scope: 'friends',
      cells: ['891f8ed951bffff'],
      center: { lat: 47.3769, lng: 8.5417 },
    },
  });
  const { id } = (await res.json()) as { id: string };

  // The recipient opens the gift on a phone. E2e points the tile sources at a
  // closed port, so terrain never activates and the licence line never renders;
  // a real Terrarium tile makes the layer honest (review of rounds 06-07, item 2).
  await page.route('**/api/tiles/elev/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: terrariumTile() }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?c=${id}`);

  await expect(page.locator('#hud')).toHaveClass(/gift/);
  await expect(page.locator('#hud')).not.toHaveClass(/expanded/);

  // The attribution rides the moment tier, which a gift never hides.
  await expect(
    page.locator('#status-moment span').filter({ hasText: 'Elevation: Mapzen' }),
  ).toBeVisible({ timeout: 60_000 });

  // The invitation to play is reachable everywhere, not only behind More options.
  await expect(page.getByRole('button', { name: 'Start a match here' })).toBeVisible();

  // An error is a problem, never clipped: it survives collapsing the panel.
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByLabel('Address, place or coordinates').fill('nowhere at all');
  await page.getByRole('button', { name: 'Walk here' }).click();
  // Tests point the edge's Nominatim at a closed port, so every lookup fails;
  // the edge gives up after 8 s (geocode.ts), and a closed port does not always
  // refuse at once, so wait longer than the edge does.
  await expect(page.locator('#coords-error')).toContainText('use coordinates', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Fewer options' }).click();
  await expect(page.locator('#coords-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a match here' })).toBeVisible();
});
