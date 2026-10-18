import { describe, expect, it } from 'vitest';
import { fnv1a32 } from '../src/hash/fnv';
import { canonicalJson } from '../src/hash/canonical';
import { sha256Hex } from '../src/hash/sha256';
import { rngFor, mulberry32 } from '../src/hash/rng';

describe('fnv1a32', () => {
  it('matches the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
  it('hashes non-ASCII via UTF-8', () => {
    expect(fnv1a32('Zürich')).not.toBe(fnv1a32('Zurich'));
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('sha256Hex', () => {
  it('hashes strings and bytes', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(await sha256Hex('abc'));
  });
});

describe('seeded RNG', () => {
  it('is a pure function of (stableId, purpose)', () => {
    const a = rngFor('osm:w123', 'height');
    const b = rngFor('osm:w123', 'height');
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect(rngFor('osm:w123', 'colour')()).not.toBe(seqA[0]);
  });
  it('produces values in [0, 1) with a pinned stream (golden)', () => {
    const r = mulberry32(42);
    const xs = Array.from({ length: 4 }, () => r());
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(xs).toMatchInlineSnapshot(`
      [
        0.6011037519201636,
        0.44829055899754167,
        0.8524657934904099,
        0.6697340414393693,
      ]
    `);
  });
});
