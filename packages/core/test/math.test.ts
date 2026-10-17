import { describe, expect, it } from 'vitest';
import { detCos, detSin, quantizeMm, DEG } from '../src/math/det';

describe('deterministic trig (ADR-0006)', () => {
  it('matches Math.sin/cos to 1e-10 across a wide range', () => {
    for (let x = -50; x <= 50; x += 0.0137) {
      expect(Math.abs(detSin(x) - Math.sin(x))).toBeLessThan(1e-10);
      expect(Math.abs(detCos(x) - Math.cos(x))).toBeLessThan(1e-10);
    }
  });

  it('is exact at key angles', () => {
    expect(detSin(0)).toBe(0);
    expect(detCos(0)).toBe(1);
    expect(Math.abs(detCos(90 * DEG))).toBeLessThan(1e-15);
  });

  it('produces pinned bit patterns (golden)', () => {
    // If these change, every Bundle hash changes. Bump INTERPRETER_VERSION.
    const bits = (x: number) => {
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, x);
      return b.getBigUint64(0).toString(16);
    };
    expect([bits(detCos(47.3769 * DEG)), bits(detSin(1.234))]).toMatchInlineSnapshot(`
      [
        "3fe5ab660e6dc6d8",
        "3fee33c23ed44442",
      ]
    `);
  });
});

describe('quantizeMm', () => {
  it('rounds to millimetres', () => {
    expect(quantizeMm(1.23449)).toBe(1234);
    expect(quantizeMm(-0.0005)).toBe(-0);
    expect(quantizeMm(12.3456)).toBe(12346);
  });
});
