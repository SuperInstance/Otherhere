import { z } from 'zod';
import type { MatchEvent, MatchState, Team } from './ctf';

// Session wire protocol (ADR-0011). Client → SessionDO messages are validated;
// SessionDO → client messages are trusted by the client.

const Num = z.number().finite();
export const SESSION_CODE = /^[A-HJ-NP-Z2-9]{6}$/; // no 0/O/1/I: easy to read aloud

export const ClientMessage = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), name: z.string().trim().min(1).max(24) }),
  z.strictObject({ t: z.literal('pos'), x: Num, z: Num, yaw: Num }),
  /** WebRTC offer/answer/candidate, relayed verbatim to one peer. */
  z.strictObject({ t: z.literal('signal'), to: z.string().max(40), data: z.json() }),
  z.strictObject({ t: z.literal('start') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type PeerInfo = { id: string; name: string; team: Team };

export type SessionInfo = {
  code: string;
  origin: { lat: number; lng: number };
  ruleset: string;
  createdAt: string;
};

export type ServerMessage =
  | { t: 'welcome'; you: PeerInfo; session: SessionInfo; peers: PeerInfo[]; match: MatchState }
  | { t: 'peers'; peers: PeerInfo[] }
  | { t: 'pos'; id: string; x: number; z: number; yaw: number }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'match'; match: MatchState; events: MatchEvent[] }
  | { t: 'error'; message: string };

/** A fresh, readable join code. Not part of any content address, so true randomness is fine. */
export function newSessionCode(
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return s;
}
