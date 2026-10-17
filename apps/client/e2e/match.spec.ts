import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type SessionView = {
  code: string;
  me: { id: string; team: number } | null;
  phase?: string;
  score?: [number, number];
  peers: {
    id: string;
    team: number;
    x: number;
    z: number;
    via: string | null;
    channel: string | null;
    visible: boolean;
  }[];
};

const session = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __otherhere?: { session: SessionView | null } }).__otherhere
        ?.session ?? null,
  );

test('two players see each other move over WebRTC, then play capture the flag', async ({
  browser,
  request,
}) => {
  const fixture = readFileSync(
    new URL('../../../packages/core/test/fixtures/overpass-zurich.json', import.meta.url),
  );
  await request.post('/api/dev/blocks/881f8ed951fffff', {
    data: fixture,
    headers: { 'content-type': 'application/json' },
  });

  // Player A walks a place and starts a match there.
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?at=47.3769,8.5417&name=Ada');
  await a.getByRole('button', { name: 'Start a match here' }).click();
  await a.waitForURL(/\?s=[A-Z2-9]{6}/);
  const code = new URL(a.url()).searchParams.get('s')!;

  // Player B joins with the invite link (a separate browser context: a second device).
  const b = await (await browser.newContext()).newPage();
  await b.goto(`/?s=${code}&name=Bo`);

  // Both are in, on different teams, connected peer-to-peer.
  await expect
    .poll(async () => (await session(a))?.peers[0]?.channel, { timeout: 30_000 })
    .toBe('open');
  await expect.poll(async () => (await session(b))?.peers[0]?.via, { timeout: 30_000 }).toBe('p2p');
  const sa = (await session(a))!;
  const sb = (await session(b))!;
  expect(sa.me!.team).not.toBe(sb.me!.team);

  // B walks; A sees B's position change.
  const before = (await session(a))!.peers[0]!;
  await b.bringToFront(); // background pages get throttled animation frames
  await b.locator('canvas').click({ position: { x: 900, y: 500 } });
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(3000);
  await b.keyboard.up('KeyW');
  await expect
    .poll(async () => {
      const p = (await session(a))!.peers[0]!;
      return Math.hypot(p.x - before.x, p.z - before.z);
    })
    .toBeGreaterThan(3);

  // Players start at their own bases, 240 m apart: team fog hides the enemy.
  expect((await session(a))!.peers[0]!.visible).toBe(false);

  // Start the match from A's screen.
  await a.bringToFront();
  await a.getByRole('button', { name: 'Start the match' }).click();
  await expect.poll(async () => (await session(b))?.phase).toBe('playing');
  await expect(b.locator('#match-line')).toContainText(`Match ${code}`);
  await a.screenshot({ path: 'test-results/match-a.png' });
});
