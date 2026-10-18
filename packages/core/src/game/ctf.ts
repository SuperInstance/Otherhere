import { rngFor } from '../hash/rng';
import { detCos, detSin, TAU } from '../math/det';
import { Ruleset, type FogRule } from '../schema/ruleset';

// Capture the flag v0. Pure and deterministic: the SessionDO runs `stepMatch`
// over reported positions and is the only authority on its events (ADR-0011).
// Coordinates are the session's world frame: x east, z south, in metres.

export type Team = 0 | 1;
export type XZ = { x: number; z: number };
export type PlayerPos = XZ & { id: string; team: Team };

export type Flag = XZ & { team: Team; carrier: string | null };

export type MatchState = {
  code: string;
  phase: 'lobby' | 'playing' | 'ended';
  bases: [XZ, XZ];
  flags: [Flag, Flag];
  score: [number, number];
  startedAt: number | null;
  endsAt: number | null;
  winner: Team | null;
  /** Players who were just tagged cannot pick up a flag until this time (ms). */
  cooldowns: Record<string, number>;
};

export type MatchEvent =
  | { kind: 'pickup'; player: string; flag: Team }
  | { kind: 'capture'; player: string; flag: Team; team: Team }
  | { kind: 'tag'; player: string; by: string }
  | { kind: 'return'; flag: Team }
  | { kind: 'end'; winner: Team | null };

export type CtfConfig = {
  ruleset: Ruleset;
  capturesToWin: number;
  durationS: number;
  arena: { baseDistanceM: number };
  pickupRadiusM: number;
  captureRadiusM: number;
  tagRadiusM: number;
  tagCooldownS: number;
};

export const CTF_V0: CtfConfig = {
  ruleset: Ruleset.parse({
    id: 'rules.ctf',
    version: '0.1.0',
    name: 'Capture the flag',
    teams: 2,
    durationS: 1200,
    objectives: [{ type: 'capture_the_flag', flagsPerTeam: 1, capturesToWin: 3 }],
    fog: { mode: 'team', revealRadiusM: 45, fadeAfterS: 0 },
  }),
  capturesToWin: 3,
  durationS: 1200,
  arena: { baseDistanceM: 120 },
  pickupRadiusM: 4,
  captureRadiusM: 6,
  tagRadiusM: 2.5,
  tagCooldownS: 5,
};

const dist = (a: XZ, b: XZ) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
const other = (t: Team): Team => (t === 0 ? 1 : 0);

/** The arena is a pure function of the session code: same code, same bases. */
export function newMatch(code: string, cfg: CtfConfig): MatchState {
  const angle = rngFor(code, 'arena')() * TAU;
  const d = cfg.arena.baseDistanceM;
  const ux = detCos(angle);
  const uz = detSin(angle);
  const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const bases: [XZ, XZ] = [
    { x: r(-ux * d), z: r(-uz * d) },
    { x: r(ux * d), z: r(uz * d) },
  ];
  return {
    code,
    phase: 'lobby',
    bases,
    flags: [
      { team: 0, carrier: null, ...bases[0] },
      { team: 1, carrier: null, ...bases[1] },
    ],
    score: [0, 0],
    startedAt: null,
    endsAt: null,
    winner: null,
    cooldowns: {},
  };
}

export function startMatch(m: MatchState, now: number, cfg: CtfConfig = CTF_V0): MatchState {
  if (m.phase !== 'lobby') return m;
  return { ...m, phase: 'playing', startedAt: now, endsAt: now + cfg.durationS * 1000 };
}

/** New players join the smaller team; ties go to team 0. */
export function assignTeam(existing: readonly Team[]): Team {
  const zeros = existing.filter((t) => t === 0).length;
  return zeros <= existing.length - zeros ? 0 : 1;
}

/** True if `p` stands in `team`'s half (closer to that team's base). */
function inHalf(m: MatchState, p: XZ, team: Team): boolean {
  return dist(p, m.bases[team]) < dist(p, m.bases[other(team)]);
}

/** Advance the match given everyone's current positions. */
export function stepMatch(
  prev: MatchState,
  players: readonly PlayerPos[],
  now: number,
  cfg: CtfConfig = CTF_V0,
): { state: MatchState; events: MatchEvent[] } {
  if (prev.phase !== 'playing') return { state: prev, events: [] };
  const m: MatchState = structuredClone(prev);
  const events: MatchEvent[] = [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const sorted = [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const sendHome = (flag: Flag) => {
    flag.carrier = null;
    flag.x = m.bases[flag.team].x;
    flag.z = m.bases[flag.team].z;
    events.push({ kind: 'return', flag: flag.team });
  };

  // Carriers who left drop the flag home.
  for (const f of m.flags) if (f.carrier && !byId.has(f.carrier)) sendHome(f);

  // Tags: a defender touching an intruder in the defender's half.
  const tagged = new Set<string>();
  for (const q of sorted) {
    if (!inHalf(m, q, other(q.team))) continue;
    const by = sorted.find((p) => p.team !== q.team && dist(p, q) < cfg.tagRadiusM);
    if (!by || tagged.has(q.id)) continue;
    tagged.add(q.id);
    events.push({ kind: 'tag', player: q.id, by: by.id });
    m.cooldowns[q.id] = now + cfg.tagCooldownS * 1000;
    const carried = m.flags.find((f) => f.carrier === q.id);
    if (carried) sendHome(carried);
  }

  // Pickups, carrying, and captures.
  for (const p of sorted) {
    const enemy = m.flags[other(p.team)];
    if (!enemy.carrier && (m.cooldowns[p.id] ?? 0) <= now && dist(p, enemy) < cfg.pickupRadiusM) {
      enemy.carrier = p.id;
      events.push({ kind: 'pickup', player: p.id, flag: enemy.team });
    }
    if (enemy.carrier === p.id) {
      enemy.x = p.x;
      enemy.z = p.z;
      if (dist(p, m.bases[p.team]) < cfg.captureRadiusM) {
        m.score[p.team]++;
        enemy.carrier = null;
        enemy.x = m.bases[enemy.team].x;
        enemy.z = m.bases[enemy.team].z;
        events.push({ kind: 'capture', player: p.id, flag: enemy.team, team: p.team });
      }
    }
  }
  for (const [id, until] of Object.entries(m.cooldowns)) if (until <= now) delete m.cooldowns[id];

  const leader = m.score[0] === m.score[1] ? null : m.score[0] > m.score[1] ? 0 : 1;
  if (
    m.score[0] >= cfg.capturesToWin ||
    m.score[1] >= cfg.capturesToWin ||
    (m.endsAt !== null && now >= m.endsAt)
  ) {
    m.phase = 'ended';
    m.winner = leader;
    events.push({ kind: 'end', winner: leader });
  }
  return { state: m, events };
}

/**
 * Team fog (Ruleset.fog). Fog is a rule, not knowledge: everyone in the
 * session knows where everyone is; the Ruleset decides who is drawn.
 */
export function visibleTo(
  viewerTeam: Team,
  target: PlayerPos,
  players: readonly PlayerPos[],
  fog: FogRule,
): boolean {
  if (fog.mode === 'none' || target.team === viewerTeam) return true;
  if (fog.mode === 'personal') return false;
  return players.some((p) => p.team === viewerTeam && dist(p, target) <= fog.revealRadiusM);
}
