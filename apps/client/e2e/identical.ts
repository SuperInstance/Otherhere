import { PNG } from 'pngjs';
import { expect } from '@playwright/test';

/**
 * Compare two full-page screenshots pixel by pixel, allowing each channel to
 * differ by at most `maxChannelDiff` in at most `maxPixels` pixels (alpha must
 * match exactly). `Buffer.equals` is the doctrine for the same rendering
 * context (a reload re-enters the same pipeline bit-exactly — the walk spec
 * keeps it), but two independent browser contexts may round the fog gradient's
 * transcendentals one ulp apart: measured on CI, the postcard pair differed in
 * 172 of 1,024,000 pixels, every one by exactly 1/255. This helper keeps that
 * evidence honest instead of hiding it in a tolerance: the bound is stated as
 * numbers, the measurement is logged on every comparison, and tightening either
 * number by one must fail the spec.
 */
export async function expectIdentical(
  actual: Buffer,
  expected: Buffer,
  maxChannelDiff: number,
  maxPixels = 0,
): Promise<void> {
  if (actual.equals(expected)) {
    console.log(`expectIdentical: byte-exact (${actual.length} bytes)`);
    return; // the fast, exact path
  }
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(expected);
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let max = 0;
  let pixels = 0;
  let alphaMax = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let touched = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c]! - b.data[i + c]!);
      if (d > 0) touched = true;
      if (d > max) max = d;
    }
    if (touched) pixels++;
    alphaMax = Math.max(alphaMax, Math.abs(a.data[i + 3]! - b.data[i + 3]!));
  }
  console.log(
    `expectIdentical: ${pixels} pixels differ, max channel ${max}/255, max alpha ${alphaMax}`,
  );
  if (max > maxChannelDiff || pixels > maxPixels || alphaMax > 0) {
    throw new Error(
      `screenshots differ: ${pixels} pixels (allowed ${maxPixels}), ` +
        `up to ${max}/255 in one channel (allowed ${maxChannelDiff}), ` +
        `alpha up to ${alphaMax} (must be 0)`,
    );
  }
}
