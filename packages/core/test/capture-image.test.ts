import { describe, expect, it } from 'vitest';
import { fitForShared, JEV_IMAGE_SIDE } from '../src/capture/image';

const { min, max } = JEV_IMAGE_SIDE;

/**
 * `fitForShared` exists because of a measured failure: an eval harness sized images
 * by their long side, which put a 600×242 panorama at 512×207 — under Jev's 280 px
 * floor — and the cloud refused it with HTTP 400 "Invalid image dimensions". The
 * cloud arm was scored zero on a five-answer case for a reason that had nothing to
 * do with the model (see docs/notes/local-decision-models.md).
 */
describe('fitForShared', () => {
  it('keeps every side inside [min, max] for any frame', () => {
    const frames: [number, number][] = [
      [600, 449],
      [600, 600],
      [600, 242],
      [600, 742],
      [600, 885],
      [600, 400],
      [600, 503],
      [4032, 3024],
      [8000, 1000],
      [200, 200],
      [1280, 720],
      [1, 1],
    ];
    for (const [w, h] of frames) {
      const fit = fitForShared(w, h);
      for (const side of [fit.width, fit.height]) {
        expect(side).toBeGreaterThanOrEqual(min);
        expect(side).toBeLessThanOrEqual(max);
      }
    }
  });

  it('raises the long side for a panorama rather than dropping it under the floor', () => {
    // The eval's panorama: 512×207 is what the long-side-only fit produced, and the
    // cloud refused it. The short side has to clear 280, so the long side goes to 695.
    expect(fitForShared(600, 242)).toEqual({ width: 695, height: 280 });
  });

  it('leaves an ordinary frame at the cap', () => {
    expect(fitForShared(600, 449)).toEqual({ width: 512, height: 383 });
    expect(fitForShared(600, 600)).toEqual({ width: 512, height: 512 });
    expect(fitForShared(600, 742)).toEqual({ width: 414, height: 512 });
    expect(fitForShared(600, 885)).toEqual({ width: 347, height: 512 });
  });

  it('honours the cap, because a local model pays for every pixel', () => {
    const fit = fitForShared(4032, 3024);
    expect(Math.max(fit.width, fit.height)).toBe(512);
  });

  it('crops only past the aspect Jev allows', () => {
    const fit = fitForShared(8000, 1000);
    expect(fit).toEqual({ width: 1568, height: 280 });
  });

  it('upscales a tiny frame only as far as the floor demands', () => {
    expect(fitForShared(200, 200)).toEqual({ width: 280, height: 280 });
  });

  it('never crops to satisfy the local cap', () => {
    // The frame keeps its aspect ratio: 600×242 in, 695×280 out.
    const fit = fitForShared(600, 242);
    expect(fit.width / fit.height).toBeCloseTo(600 / 242, 1);
  });
});
