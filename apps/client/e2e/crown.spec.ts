import { expect, test, type Page } from '@playwright/test';
// The wind's spec, imported by the test itself: the prediction the law grades
// against is computed by the same module the shader mirrors — the point of
// #66 is that the render and the spec cannot quietly drift apart.
import { swayOffset, windStrength } from '../src/wind';
// The law itself, pure and unit-tested: the spec wires the instrument's
// readings and the spec's predictions into it and asserts its verdict.
import { gradeCrown, MIN_QUALIFYING } from '../src/crown-law';

type Demo = {
  witness: {
    x: number;
    z: number;
    y: number;
    height: number;
    width: number;
    yaw: number;
    spruce: boolean;
    flexTip: number;
    apex: { x: number; y: number; z: number };
  };
  cloud: number;
  frozen: boolean;
  ready: boolean;
  trees: number;
  wind: { time: number; strength: number };
  dropped: number;
  bottomUp: boolean | null;
  frames: { t: number; strength: number; u: number; v: number }[];
};

const read = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __otherhere?: { forestDemo?: Demo };
        }
      ).__otherhere?.forestDemo ?? null,
  );

/** Wait until the instrument is ready and has recorded at least `n` readings. */
async function recorded(page: Page, n: number, timeout = 180_000): Promise<Demo> {
  await expect
    .poll(
      async () => {
        const d = await read(page);
        return d && d.ready && d.frames.length >= n ? d.frames.length : 0;
      },
      { timeout },
    )
    .toBeGreaterThanOrEqual(n);
  return (await read(page))!;
}

/** The spec's predicted apex position for every recorded frame time, from
 *  the page's own prediction (which runs the same wind.ts the shader mirrors). */
async function predictions(page: Page, d: Demo): Promise<{ u: number; v: number }[]> {
  const ts = d.frames.map((f) => f.t);
  const ps = await page.evaluate(
    (ts: number[]) =>
      ts.map((t) =>
        (
          window as unknown as {
            __otherhere?: { forestDemo?: { predictTip(t: number): { u: number; v: number } } };
          }
        ).__otherhere?.forestDemo?.predictTip(t),
      ),
    ts,
  );
  // Every frame time yields a prediction; a hole here is a broken instrument.
  if (ps.some((p) => !p)) throw new Error('the instrument failed to predict a recorded frame time');
  return ps as { u: number; v: number }[];
}

/**
 * THE CROWN-MOTION LAW (#66, #85): the crown moves by what `swayOffset` says
 * for the wind state the handle reports — in distance, in direction and in
 * amplitude. The grading lives in `src/crown-law.ts` (pure, unit-tested
 * against sign-flipped, frozen and half-amplitude corruptions); this wrapper
 * holds the instrument's own health checks and asserts the law's verdict on
 * the real shader's readings.
 */
function gradeCrownMotion(d: Demo, pred: { u: number; v: number }[]) {
  // The instrument must have calibrated its row order and found the crown.
  expect(d.bottomUp).not.toBeNull();
  expect(d.trees).toBe(1);
  // The clock the shader saw must have advanced: a stalled feed fails here.
  const span = d.frames[d.frames.length - 1]!.t - d.frames[0]!.t;
  expect(span).toBeGreaterThanOrEqual(2);
  // The handle's strength is the spec's strength for the time it reports.
  for (const f of d.frames.slice(0, 5)) {
    expect(Math.abs(f.strength - windStrength(f.t, d.cloud))).toBeLessThan(1e-9);
  }

  const verdict = gradeCrown(d.frames, pred);
  expect(verdict.pairs.length).toBeGreaterThanOrEqual(MIN_QUALIFYING);
  // Every rejection, verbatim: the law's own words name the failure.
  expect(verdict.rejections, verdict.rejections.join('\n')).toEqual([]);
  return verdict;
}

test('the spruce crown moves by what the wind spec says (#66)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?demo=forest&species=spruce');
  const d = await recorded(page, 30);
  const verdict = gradeCrownMotion(d, await predictions(page, d));
  // The page's own prediction agrees with the test's import of the spec: the
  // instrument and the grader read the same module, on purpose.
  const t = d.frames[Math.floor(d.frames.length / 2)]!.t;
  const pageTip = await page.evaluate(
    (tt) =>
      (
        window as unknown as {
          __otherhere?: { forestDemo?: { predictTip(t: number): { u: number; v: number } } };
        }
      ).__otherhere?.forestDemo?.predictTip(tt),
    t,
  );
  const o = swayOffset(t, d.cloud, d.witness.apex.x, d.witness.apex.z, d.witness.flexTip);
  const own = await page.evaluate(
    (p: [number, number, number]) =>
      (
        window as unknown as {
          __otherhere?: { forestDemo?: { project(x: number, y: number, z: number): unknown } };
        }
      ).__otherhere?.forestDemo?.project(p[0], p[1], p[2]),
    [d.witness.apex.x + o[0], d.witness.apex.y, d.witness.apex.z + o[1]] as [
      number,
      number,
      number,
    ],
  );
  expect(pageTip).not.toBeNull();
  expect(own).not.toBeNull();
  expect(Math.abs(pageTip!.u - (own as { u: number }).u)).toBeLessThanOrEqual(1e-6);
  expect(Math.abs(pageTip!.v - (own as { v: number }).v)).toBeLessThanOrEqual(1e-6);
  // Evidence for humans: the stand, mid-run.
  await page.screenshot({ path: 'test-results/crown-spruce.png' });
  expect(verdict.pairs.length).toBeGreaterThan(0);
});

test('the hemlock crown moves by what the wind spec says (#66)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?demo=forest&species=hemlock');
  const d = await recorded(page, 30);
  expect(d.witness.spruce).toBe(false);
  gradeCrownMotion(d, await predictions(page, d));
  await page.screenshot({ path: 'test-results/crown-hemlock.png' });
});

test('a pinned forest stand holds still (the instrument reads zero)', async ({ page }) => {
  await page.goto('/?demo=forest&t=9.5');
  const d = await recorded(page, 10);
  expect(d.frozen).toBe(true);
  expect(d.wind.time).toBe(0); // pinned from frame zero, like the walk spec's sky
  // Still frames: every reading is the same apex, to the pixel.
  const first = d.frames[0]!;
  for (const f of d.frames) {
    expect(Math.abs(f.u - first.u)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(f.v - first.v)).toBeLessThanOrEqual(0.5);
  }
});
