import type { MatchEvent, MatchState, PeerInfo, ServerMessage, SessionInfo } from '@otherhere/core';

export type PeerState = {
  info: PeerInfo;
  x: number;
  z: number;
  yaw: number;
  /** When we last heard where they are, and by which path. */
  heardAt: number;
  via: 'p2p' | 'relay' | null;
  pc?: RTCPeerConnection;
  dc?: RTCDataChannel;
};

export type SessionHandlers = {
  onWelcome(me: PeerInfo, session: SessionInfo, match: MatchState): void;
  onMatch(match: MatchState, events: MatchEvent[]): void;
  onPeers(): void;
  onError(message: string): void;
};

const P2P_HZ = 20;
const RELAY_HZ = 5;

/**
 * One player's connection to a match (ADR-0011): a WebSocket to the SessionDO
 * for roster, signaling, and authoritative events, plus a WebRTC data channel
 * to every other player for smooth motion. The WebSocket also relays motion,
 * so peers that cannot connect directly still see each other.
 */
export class SessionClient {
  me: PeerInfo | null = null;
  readonly peers = new Map<string, PeerState>();
  private ws!: WebSocket;
  private ice: RTCIceServer[] = [];
  private lastP2P = 0;
  private lastRelay = 0;
  private closed = false;

  constructor(
    readonly code: string,
    private name: string,
    private h: SessionHandlers,
  ) {}

  async connect(): Promise<void> {
    try {
      this.ice = (
        (await (await fetch(`/api/sessions/${this.code}/ice`)).json()) as {
          iceServers: RTCIceServer[];
        }
      ).iceServers;
    } catch {
      this.ice = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    }
    this.open();
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/api/sessions/${this.code}/ws`);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.ws.onmessage = (e) => this.onServer(JSON.parse(e.data as string) as ServerMessage);
    this.ws.onclose = () => {
      if (this.closed) return;
      this.h.onError('Lost the connection to the match. Reconnecting…');
      setTimeout(() => this.open(), 1500);
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
    for (const p of this.peers.values()) p.pc?.close();
  }

  private send(msg: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  start() {
    this.send({ t: 'start' });
  }

  /** Share our pose: data channels at 20 Hz, the relay at 5 Hz. */
  sendPose(x: number, z: number, yaw: number, now: number) {
    const msg = JSON.stringify({ x, z, yaw });
    if (now - this.lastP2P >= 1000 / P2P_HZ) {
      this.lastP2P = now;
      for (const p of this.peers.values()) if (p.dc?.readyState === 'open') p.dc.send(msg);
    }
    if (now - this.lastRelay >= 1000 / RELAY_HZ) {
      this.lastRelay = now;
      this.send({ t: 'pos', x, z, yaw });
    }
  }

  private onServer(m: ServerMessage) {
    switch (m.t) {
      case 'welcome':
        this.me = m.you;
        this.syncPeers(m.peers);
        this.h.onWelcome(m.you, m.session, m.match);
        break;
      case 'peers':
        this.syncPeers(m.peers.filter((p) => p.id !== this.me?.id));
        break;
      case 'pos': {
        const p = this.peers.get(m.id);
        // Prefer the data channel; take the relay only when P2P has gone quiet.
        if (p && (p.via !== 'p2p' || performance.now() - p.heardAt > 500)) {
          Object.assign(p, {
            x: m.x,
            z: m.z,
            yaw: m.yaw,
            heardAt: performance.now(),
            via: 'relay',
          });
        }
        break;
      }
      case 'signal':
        void this.onSignal(m.from, m.data as SignalData);
        break;
      case 'match':
        this.h.onMatch(m.match, m.events);
        break;
      case 'error':
        this.h.onError(m.message);
        break;
    }
  }

  private syncPeers(list: PeerInfo[]) {
    const ids = new Set(list.map((p) => p.id));
    for (const [id, p] of this.peers) {
      if (!ids.has(id)) {
        p.pc?.close();
        this.peers.delete(id);
      }
    }
    for (const info of list) {
      const existing = this.peers.get(info.id);
      if (existing) {
        existing.info = info;
        continue;
      }
      this.peers.set(info.id, { info, x: 0, z: 0, yaw: 0, heardAt: 0, via: null });
      // The peer with the smaller ID makes the offer, so each pair negotiates once.
      if (this.me && this.me.id < info.id) void this.offer(info.id);
    }
    this.h.onPeers();
  }

  private peerConnection(id: string): RTCPeerConnection {
    const p = this.peers.get(id)!;
    if (p.pc) return p.pc;
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send({ t: 'signal', to: id, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ondatachannel = (e) => this.attach(id, e.channel);
    p.pc = pc;
    return pc;
  }

  private attach(id: string, dc: RTCDataChannel) {
    const p = this.peers.get(id);
    if (!p) return;
    p.dc = dc;
    dc.onopen = () => this.h.onPeers();
    dc.onclose = () => this.h.onPeers();
    dc.onmessage = (e) => {
      const { x, z, yaw } = JSON.parse(e.data as string) as { x: number; z: number; yaw: number };
      if ([x, z, yaw].every(Number.isFinite))
        Object.assign(p, { x, z, yaw, heardAt: performance.now(), via: 'p2p' });
    };
  }

  private async offer(id: string) {
    const pc = this.peerConnection(id);
    this.attach(id, pc.createDataChannel('pose', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    this.send({ t: 'signal', to: id, data: { description: pc.localDescription!.toJSON() } });
  }

  private async onSignal(from: string, data: SignalData) {
    if (!this.peers.has(from)) return;
    const pc = this.peerConnection(from);
    try {
      if ('description' in data) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.send({
            t: 'signal',
            to: from,
            data: { description: pc.localDescription!.toJSON() },
          });
        }
      } else if ('candidate' in data) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.warn('signaling', err);
    }
  }
}

type SignalData = { description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit };
