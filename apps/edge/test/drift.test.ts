import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { runDriftCanary } from '../src/drift';

/**
 * The drift canary (see src/drift.ts): MODEL_FAKE answers `fake-jev`, so the
 * flip logic is exercised against a served model that differs from the pin —
 * exactly the shape of a real flip, without spending anything.
 */

const ops = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x/api/ops/${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-ops', ...init.headers },
  });

async function placeCanarySpend(): Promise<number> {
  const body = (await (await ops('spend')).json()) as Record<string, number>;
  return body['jev-canary'] ?? 0;
}

describe('the drift canary', () => {
  it('asks once, records the reading, and spends under its own key', async () => {
    const before = await placeCanarySpend();
    const reading = await runDriftCanary(env);
    expect(reading).not.toBeNull();
    // The fake serves `fake-jev` to a `jev-latest` ask: a flip by construction.
    expect(reading!.asked).toBe('jev-latest');
    expect(reading!.served).toBe('fake-jev');
    expect(reading!.pinned).toBe('jev-1.13.0');
    expect(reading!.flipped).toBe(true);
    expect(reading!.calm).toBeTypeOf('number');
    expect(reading!.ms).toBeGreaterThanOrEqual(0);
    expect(await placeCanarySpend()).toBeGreaterThan(before);
  });

  it('serves the readings owner-only, newest first, with the flip verdict', async () => {
    await runDriftCanary(env);
    await runDriftCanary(env);
    const res = await ops('drift?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pinned: string;
      flipped_now: string | null;
      readings: { at: string; served: string; flipped: boolean }[];
    };
    expect(body.pinned).toBe('jev-1.13.0');
    expect(body.flipped_now).toBe('fake-jev'); // the fake always "flips"
    expect(body.readings.length).toBe(2);
    expect(new Date(body.readings[0]!.at).getTime()).toBeGreaterThanOrEqual(
      new Date(body.readings[1]!.at).getTime(),
    );
    expect(body.readings[0]!.served).toBe('fake-jev');
    // Without the token the route does not exist.
    const bare = await SELF.fetch('https://x/api/ops/drift');
    expect(bare.status).toBe(404);
  });

  it('a flipped reading is one the pin did not serve', async () => {
    // The verdict the route reports is the stored readings' own logic: the
    // fake's flip above exercises it; assert the definition directly.
    const res = await ops('drift?limit=1');
    const body = (await res.json()) as {
      readings: { served: string; pinned: string; flipped: boolean }[];
    };
    const r = body.readings[0]!;
    expect(r.flipped).toBe(r.served !== r.pinned);
  });
});
