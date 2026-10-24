import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, sha256HexSync } from '../src/hash/sha256';

/** The FIPS 180-4 example vectors, plus the million-a's (multi-block,
 *  length-encoding) standard test. The fallback exists for insecure
 *  contexts — a town served over plain http on a LAN address, where
 *  crypto.subtle is undefined — so its answers must be exactly the
 *  standard's, not approximately. */
const VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

describe('sha256HexSync (the no-WebCrypto fallback)', () => {
  it.each(VECTORS)('matches the published vector for %j…', (input, want) => {
    expect(sha256HexSync(input)).toBe(want);
  });

  it('agrees with WebCrypto on binary data of awkward lengths', async () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(sha256HexSync(bytes)).toBe(await sha256Hex(bytes));
    }
  });
});

describe('sha256Hex', () => {
  it('still answers when crypto.subtle is withheld (insecure context)', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(sha256Hex('abc')).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
