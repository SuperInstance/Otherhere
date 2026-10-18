import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { MatchState, ServerMessage } from '@otherhere/core';

async function create(lat = 47.3769, lng = 8.5417): Promise<string> {
  const res = await SELF.fetch('https://x/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ lat, lng }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

type Client = {
  ws: WebSocket;
  send(msg: unknown): void;
  next<T extends ServerMessage['t']>(
    t: T,
    where?: (m: Extract<ServerMessage, { t: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { t: T }>>;
};

async function connect(
  code: string,
  name: string,
): Promise<Client & { welcome: Extract<ServerMessage, { t: 'welcome' }> }> {
  const res = await SELF.fetch(`https://x/api/sessions/${code}/ws`, {
    headers: { upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener('message', (e) => {
    inbox.push(JSON.parse(e.data as string) as ServerMessage);
    waiters.splice(0).forEach((w) => w());
  });
  const client: Client = {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    async next(t, where = () => true) {
      for (;;) {
        const i = inbox.findIndex((m) => m.t === t && where(m as never));
        if (i >= 0) return inbox.splice(i, 1)[0] as never;
        await new Promise<void>((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), 3000);
        });
      }
    },
  };
  client.send({ t: 'hello', name });
  return { ...client, welcome: await client.next('welcome') };
}

describe('sessions API', () => {
  it('creates a session with a readable code and describes it', async () => {
    const code = await create();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const info = (await (await SELF.fetch(`https://x/api/sessions/${code}`)).json()) as {
      info: { origin: { lat: number } };
      match: MatchState;
    };
    expect(info.info.origin.lat).toBe(47.3769);
    expect(info.match.phase).toBe('lobby');
  });

  it('rejects bad input and unknown sessions', async () => {
    expect(
      (await SELF.fetch('https://x/api/sessions', { method: 'POST', body: '{"lat":"x"}' })).status,
    ).toBe(400);
    expect((await SELF.fetch('https://x/api/sessions/OOOOOO')).status).toBe(400);
    expect((await SELF.fetch('https://x/api/sessions/ABCDEF')).status).toBe(404);
  });

  it('serves STUN-only ICE servers when no TURN key is configured', async () => {
    const body = (await (await SELF.fetch('https://x/api/sessions/ABCDEF/ice')).json()) as {
      iceServers: { urls: string[] }[];
    };
    expect(body.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  });
});

describe('SessionDO', () => {
  it('balances teams and announces peers', async () => {
    const code = await create();
    const a = await connect(code, 'Ada');
    expect(a.welcome.you.team).toBe(0);
    expect(a.welcome.peers).toEqual([]);
    const b = await connect(code, 'Bo');
    expect(b.welcome.you.team).toBe(1);
    expect(b.welcome.peers.map((p) => p.name)).toEqual(['Ada']);
    const peers = await a.next('peers');
    expect(peers.peers.map((p) => p.name).sort()).toEqual(['Ada', 'Bo']);
  });

  it('relays positions and WebRTC signals to the right peer', async () => {
    const code = await create();
    const a = await connect(code, 'Ada');
    const b = await connect(code, 'Bo');
    a.send({ t: 'pos', x: 3, z: -4, yaw: 1 });
    expect(await b.next('pos')).toEqual({ t: 'pos', id: a.welcome.you.id, x: 3, z: -4, yaw: 1 });
    b.send({ t: 'signal', to: a.welcome.you.id, data: { sdp: 'offer' } });
    expect(await a.next('signal')).toEqual({
      t: 'signal',
      from: b.welcome.you.id,
      data: { sdp: 'offer' },
    });
  });

  it('rejects malformed messages without dropping the connection', async () => {
    const code = await create();
    const a = await connect(code, 'Ada');
    a.send({ t: 'teleport', x: 1 });
    expect((await a.next('error')).message).toBe('unrecognised message');
    a.send({ t: 'pos', x: 1, z: 1, yaw: 0 });
    a.ws.send('not json');
    expect((await a.next('error')).message).toBe('messages must be JSON');
  });

  it('runs capture the flag authoritatively from reported positions', async () => {
    const code = await create();
    const a = await connect(code, 'Ada');
    const b = await connect(code, 'Bo');
    const lobby = a.welcome.match;
    a.send({ t: 'start' });
    const started = await b.next('match', (m) => m.match.phase === 'playing');
    expect(started.match.endsAt! - started.match.startedAt!).toBe(1200 * 1000);

    const enemyFlag = lobby.flags[1];
    a.send({ t: 'pos', x: enemyFlag.x, z: enemyFlag.z, yaw: 0 });
    const pickup = await b.next('match', (m) => m.events.some((e) => e.kind === 'pickup'));
    expect(pickup.events).toContainEqual({ kind: 'pickup', player: a.welcome.you.id, flag: 1 });

    a.send({ t: 'pos', x: lobby.bases[0].x, z: lobby.bases[0].z, yaw: 0 });
    const capture = await b.next('match', (m) => m.events.some((e) => e.kind === 'capture'));
    expect(capture.match.score).toEqual([1, 0]);
  });

  it('returns a carried flag when its carrier disconnects', async () => {
    const code = await create();
    const a = await connect(code, 'Ada');
    const b = await connect(code, 'Bo');
    a.send({ t: 'start' });
    await b.next('match', (m) => m.match.phase === 'playing');
    const flag = a.welcome.match.flags[1];
    a.send({ t: 'pos', x: flag.x, z: flag.z, yaw: 0 });
    await b.next('match', (m) => m.match.flags[1].carrier !== null);
    a.ws.close();
    const back = await b.next('match', (m) => m.events.some((e) => e.kind === 'return'));
    expect(back.match.flags[1].carrier).toBeNull();
  });
});
