import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** A GPX track through central Zürich, written as metres east/north of 47.3769, 8.5417. */
function zurichTrack(points: [e: number, n: number][], seconds: number): string {
  const m = 111_195; // metres per degree of latitude
  const t0 = Date.parse('2026-10-18T09:00:00Z');
  const pts = points.map(([e, n], i) => {
    const lat = 47.3769 + n / m;
    const lng = 8.5417 + e / (m * Math.cos((47.3769 * Math.PI) / 180));
    const t = new Date(t0 + (i / (points.length - 1)) * seconds * 1000).toISOString();
    return `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"><time>${t}</time></trkpt>`;
  });
  return `<?xml version="1.0"?><gpx version="1.1" creator="otherhere-test"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

test('import a filmed walk: frames along the GPS track sharpen the buildings passed', async ({
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

  await page.goto('/?at=47.3769,8.5417');
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

  // A 24 s walk up a street lined with buildings (the video is a synthetic test pattern;
  // the test deployment's fake vision model describes a brick gable house for any frame).
  await page.getByText('Learn from a filmed walk', { exact: true }).click();
  await page
    .locator('#walk-video')
    .setInputFiles(new URL('fixtures/walk.webm', import.meta.url).pathname);
  await page.locator('#walk-gpx').setInputFiles({
    name: 'walk.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(
      zurichTrack(
        [
          [60, 20],
          [100, 60],
          [140, 100],
        ],
        24,
      ),
    ),
  });
  await page.getByRole('button', { name: 'Learn from this walk' }).click();
  await expect(page.locator('#walk-result')).toContainText('Done:', { timeout: 120_000 });
  const text = (await page.locator('#walk-result').textContent())!;
  const sharpened = Number(/Done: (\d+)/.exec(text)![1]);
  expect(sharpened).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/walk-import.png' });
});
