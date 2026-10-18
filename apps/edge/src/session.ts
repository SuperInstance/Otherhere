import { DurableObject } from 'cloudflare:workers';
import {
  assignTeam,
  ClientMessage,
  CTF_V0,
  newMatch,
  startMatch,
  stepMatch,
  type MatchEvent,
  type MatchState,
  type PeerInfo,
  type PlayerPos,
  type ServerMessage,
  type SessionInfo,
  type Team,
} from '@otherhere/core';
import type { Env } from './env';

/** What we remember per socket; survives hibernation via serializeAttachment. */
type Attachment = {
  id: string;
  name: string | null;
  team: Team;
  x: number;
  z: number;
  yaw: number;
  seen: boolean;
};

/**
 * One match (ADR-0011): roster, WebRTC signaling relay, position relay, and the
 * single authority on game events. Uses the WebSocket Hibernation API so an idle
 * lobby costs nothing.
 */
export class SessionDO extends DurableObject<Env> {
  private info: SessionInfo | null = null;
  private match: MatchState | null = null;

  private async load(): Promise<boolean> {
    if (!this.info) {
      this.info = (await this.ctx.storage.get<SessionInfo>('info')) ?? null;
      this.match = (await this.ctx.storage.get<MatchState>('match')) ?? null;
    }
    return !!this.info;
  }

  async init(info: SessionInfo): Promise<void> {
    if (await this.load()) throw new Error('session exists');
    this.info = info;
    this.match = newMatch(info.code, CTF_V0);
    await this.ctx.storage.put({ info, match: this.match });
  }

  async getInfo(): Promise<{ info: SessionInfo; match: MatchState; players: number } | null> {
    if (!(await this.load())) return null;
    return { info: this.info!, match: this.match!, players: this.peers().length };
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    if (!(await this.load())) return new Response('no such session', { status: 404 });
    if (this.ctx.getWebSockets().length >= 16) return new Response('session full', { status: 409 });
    const { 0: client, 1: server } = new WebSocketPair();
    const att: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      name: null,
      team: 0,
      x: 0,
      z: 0,
      yaw: 0,
      seen: false,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }));
  }

  private peers(except?: WebSocket): PeerInfo[] {
    return this.sockets()
      .filter((s) => s.att.name && s.ws !== except)
      .map(({ att }) => ({ id: att.id, name: att.name!, team: att.team }));
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closing; the close handler tidies up.
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    const s = JSON.stringify(msg);
    for (const { ws, att } of this.sockets()) {
      if (ws === except || !att.name) continue;
      try {
        ws.send(s);
      } catch {
        // ignore
      }
    }
  }

  private positions(except?: WebSocket): PlayerPos[] {
    return this.sockets()
      .filter((s) => s.att.name && s.att.seen && s.ws !== except)
      .map(({ att }) => ({ id: att.id, team: att.team, x: att.x, z: att.z }));
  }

  /** Run the Ruleset and publish any change. */
  private async step(now = Date.now(), leaving?: WebSocket) {
    if (!this.match) return;
    const { state, events } = stepMatch(this.match, this.positions(leaving), now);
    const changed =
      events.length > 0 ||
      state.flags.some(
        (f, i) => f.x !== this.match!.flags[i]!.x || f.z !== this.match!.flags[i]!.z,
      );
    this.match = state;
    if (changed) await this.publish(events);
  }

  private async publish(events: MatchEvent[]) {
    await this.ctx.storage.put('match', this.match);
    this.broadcast({ t: 'match', match: this.match!, events });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.load();
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { t: 'error', message: 'messages must be JSON' });
    }
    const r = ClientMessage.safeParse(parsed);
    if (!r.success) return this.send(ws, { t: 'error', message: 'unrecognised message' });
    const msg = r.data;
    const att = ws.deserializeAttachment() as Attachment;

    if (msg.t === 'hello') {
      if (!att.name) att.team = assignTeam(this.peers(ws).map((p) => p.team));
      att.name = msg.name;
      ws.serializeAttachment(att);
      this.send(ws, {
        t: 'welcome',
        you: { id: att.id, name: att.name, team: att.team },
        session: this.info!,
        peers: this.peers(ws),
        match: this.match!,
      });
      this.broadcast({ t: 'peers', peers: this.peers() }, ws);
      return;
    }
    if (!att.name) return this.send(ws, { t: 'error', message: 'say hello first' });

    switch (msg.t) {
      case 'pos':
        Object.assign(att, { x: msg.x, z: msg.z, yaw: msg.yaw, seen: true });
        ws.serializeAttachment(att);
        this.broadcast({ t: 'pos', id: att.id, x: msg.x, z: msg.z, yaw: msg.yaw }, ws);
        await this.step();
        return;
      case 'signal': {
        const target = this.sockets().find((s) => s.att.id === msg.to);
        if (target) this.send(target.ws, { t: 'signal', from: att.id, data: msg.data });
        return;
      }
      case 'start': {
        const now = Date.now();
        if (this.match!.phase !== 'lobby') return;
        this.match = startMatch(this.match!, now);
        await this.ctx.storage.setAlarm(this.match.endsAt!);
        await this.publish([]);
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.load();
    ws.close();
    this.broadcast({ t: 'peers', peers: this.peers(ws) }, ws);
    await this.step(Date.now(), ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** The match clock. */
  override async alarm(): Promise<void> {
    await this.load();
    await this.step();
  }
}
