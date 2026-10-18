import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const post = (path: string, ip: string) =>
  SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
    body: '{}',
  });

describe('production hardening', () => {
  it('limits photo analysis per client, and leaves other clients alone', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++)
      statuses.push((await post('/api/features/osm:w1/observe', '203.0.113.7')).status);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await post('/api/features/osm:w1/observe', '203.0.113.8')).status).not.toBe(429);
  });

  it('answers API errors as JSON with nosniff', async () => {
    const res = await SELF.fetch('https://x/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('geocode', () => {
  it('needs a query, and fails softly when the lookup service is unreachable', async () => {
    const empty = await SELF.fetch('https://x/api/geocode?q=%20');
    expect(empty.status).toBe(400);
    // Tests point Nominatim at a closed port.
    const down = await SELF.fetch('https://x/api/geocode?q=Lincoln%20St%2C%20Sitka');
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toContain('use coordinates');
  });
});
