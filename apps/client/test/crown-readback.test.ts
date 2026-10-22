import { describe, expect, it } from 'vitest';
import { cornerBackground, trackTip } from '../src/crown-readback';

/** A framebuffer helper: paint RGBA bytes for a test scene. */
function frame(w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  return rgba;
}

/** A dark crown triangle with its apex at (ax, ay), widening gently downward
 *  (narrow enough that the frame's corners stay pure sky). */
const crown =
  (ax: number, ay: number, halfWidth = 3) =>
  (x: number, y: number): [number, number, number] =>
    y >= ay && Math.abs(x - ax) <= ((y - ay) * halfWidth) / 10 ? [44, 74, 50] : [200, 206, 214];

describe('cornerBackground', () => {
  it('reads the flat sky from the corners, ignoring the crown in the middle', () => {
    const w = 64;
    const h = 64;
    const rgba = frame(w, h, crown(32, 20));
    expect(cornerBackground(rgba, w, h)).toEqual([200, 206, 214]);
  });
  it('returns whatever bytes the pipeline wrote, not an assumed colour space', () => {
    const rgba = frame(16, 16, () => [3, 200, 255]);
    expect(cornerBackground(rgba, 16, 16)).toEqual([3, 200, 255]);
  });
});

describe('trackTip', () => {
  it('finds the apex as the centroid of the topmost crown rows', () => {
    const w = 64;
    const h = 64;
    const apexX = 30;
    const apexY = 12;
    const tip = trackTip(frame(w, h, crown(apexX, apexY, 8)), w, h, [200, 206, 214]);
    expect(tip).not.toBeNull();
    // The top band spans rows apexY..apexY+2; a widening triangle's centroid
    // sits within a pixel of the apex column.
    expect(Math.abs(tip!.u - apexX)).toBeLessThanOrEqual(1);
    expect(Math.abs(tip!.v - apexY)).toBeLessThanOrEqual(1.5);
    expect(tip!.pixels).toBeGreaterThan(40);
  });

  it('follows the apex when the crown moves sideways', () => {
    const w = 128;
    const h = 64;
    const bg: [number, number, number] = [200, 206, 214];
    const a = trackTip(frame(w, h, crown(50, 12, 8)), w, h, bg)!;
    const b = trackTip(frame(w, h, crown(66, 12, 8)), w, h, bg)!;
    expect(b.u - a.u).toBeGreaterThan(13); // 16 px of crown motion, read to a pixel
    expect(Math.abs(b.v - a.v)).toBeLessThanOrEqual(1);
  });

  it('reads an empty frame as null, and a speck of noise as null', () => {
    const w = 32;
    const h = 32;
    expect(
      trackTip(
        frame(w, h, () => [200, 206, 214]),
        w,
        h,
        [200, 206, 214],
      ),
    ).toBeNull();
    const speck = frame(w, h, () => [200, 206, 214]);
    for (let k = 0; k < 20; k++) speck[k] = 0; // 5 stray dark pixels
    expect(trackTip(speck, w, h, [200, 206, 214])).toBeNull();
  });

  it('is robust to a background gradient (the mask cuts on max channel diff)', () => {
    const w = 64;
    const h = 64;
    // A sky that darkens gently toward the top (±10 across the frame — well
    // inside the 24 threshold from the corner-read background).
    const paint = (x: number, y: number): [number, number, number] => {
      const base = 200 - Math.round(((h - y) / h) * 10);
      return crown(32, 20)(x, y)[0] === 44 ? [44, 74, 50] : [base, base + 4, base + 8];
    };
    const tip = trackTip(frame(w, h, paint), w, h, [195, 199, 203]);
    expect(tip).not.toBeNull();
    expect(Math.abs(tip!.u - 32)).toBeLessThanOrEqual(1);
  });

  it('reads a bottom-up buffer as the same image (the WebGL readback order)', () => {
    const w = 64;
    const h = 64;
    const upright = frame(w, h, crown(32, 12));
    // The same image stored bottom-up: row i of the buffer is image row h-1-i.
    const flipped = new Uint8Array(upright);
    const row = new Uint8Array(w * 4);
    for (let y = 0; y < Math.floor(h / 2); y++) {
      const a = y * w * 4;
      const b = (h - 1 - y) * w * 4;
      row.set(flipped.subarray(a, a + w * 4));
      flipped.copyWithin(a, b, b + w * 4);
      flipped.set(row, b);
    }
    const a = trackTip(upright, w, h, [200, 206, 214])!;
    const b = trackTip(flipped, w, h, [200, 206, 214], { flipY: true })!;
    expect(b.u).toBeCloseTo(a.u, 6);
    expect(b.v).toBeCloseTo(a.v, 6);
    expect(b.pixels).toBe(a.pixels);
  });
});
