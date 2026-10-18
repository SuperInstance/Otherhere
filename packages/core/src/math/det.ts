// Deterministic math (ADR-0006). Only + - * / and correctly-rounded primitives
// (sqrt, floor, round, abs, min, max) are used, so results are bit-identical
// on every JS engine. Do not replace these with Math.sin/Math.cos.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG = PI / 180;

// Taylor series on [-π/2, π/2]; truncation error < 1e-16. Coefficients are
// written as exact reciprocals of factorials so they parse identically everywhere.
const S = [
  1,
  -1 / 6,
  1 / 120,
  -1 / 5040,
  1 / 362880,
  -1 / 39916800,
  1 / 6227020800,
  -1 / 1307674368000,
  1 / 355687428096000,
  -1 / 121645100408832000,
  1 / 51090942171709440000,
];
const C = [
  1,
  -1 / 2,
  1 / 24,
  -1 / 720,
  1 / 40320,
  -1 / 3628800,
  1 / 479001600,
  -1 / 87178291200,
  1 / 20922789888000,
  -1 / 6402373705728000,
  1 / 2432902008176640000,
  -1 / 1124000727777607680000,
];

function horner(coeffs: readonly number[], x2: number): number {
  let acc = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) acc = acc * x2 + (coeffs[i] as number);
  return acc;
}

function reduce(x: number): number {
  return x - TAU * Math.round(x / TAU);
}

export function detSin(x: number): number {
  let r = reduce(x);
  // Fold to [-π/2, π/2] using sin(π - r) = sin(r).
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  return clamp(r * horner(S, r * r), -1, 1);
}

export function detCos(x: number): number {
  let r = reduce(x);
  let sign = 1;
  // Fold using cos(π - r) = -cos(r).
  if (r > HALF_PI) {
    r = PI - r;
    sign = -1;
  } else if (r < -HALF_PI) {
    r = -PI - r;
    sign = -1;
  }
  return sign * clamp(horner(C, r * r), -1, 1);
}

/** Quantize a length in metres to integer millimetres. */
export function quantizeMm(v: number): number {
  return Math.round(v * 1000);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
