import { PNG } from 'pngjs';
import { expect } from '@playwright/test';

/**
 * Compare two full-page screenshots pixel by pixel, allowing each channel to
 * differ by at most `maxChannelDiff`. `Buffer.equals` is the doctrine for the
 * same rendering context (a reload re-enters the same pipeline bit-exactly —
 * the walk spec keeps it), but two independent browser contexts may round the
 * fog gradient's transcendentals one ulp apart: measured on CI, the postcard
 * pair differed in 172 of 1,024,000 pixels, every one by exactly 1/255. This
 * helper keeps that evidence honest instead of hiding it in a tolerance.
 */
export async function expectIdentical(
  actual: Buffer,
  expected: Buffer,
  maxChannelDiff: number,
): Promise<void> {
  if (actual.equals(expected)) return; // the fast, exact path
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(expected);
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let max = 0;
  let pixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c]! - b.data[i + c]!);
      if (d > 0) pixels++;
      if (d > max) max = d;
    }
  }
  if (max > maxChannelDiff) {
    throw new Error(
      `screenshots differ by up to ${max}/255 in one channel (${pixels} pixels touched); ` +
        `allowed ${maxChannelDiff}`,
    );
  }
}
