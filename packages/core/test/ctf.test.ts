import { describe, expect, it } from 'vitest';
import {
  CTF_V0,
  assignTeam,
  newMatch,
  startMatch,
  stepMatch,
  visibleTo,
  type MatchState,
  type PlayerPos,
} from '../src/game/ctf';

const at = (id: string, team: 0 | 1, x: number, z: number): PlayerPos => ({ id, team, x, z });

function playing(): MatchState {
  return startMatch(newMatch('ABC123', CTF_V0), 1_000);
}

describe('arena setup', () => {
  it('is a pure function of the session code', () => {
    expect(newMatch('ABC123', CTF_V0)).toEqual(newMatch('ABC123', CTF_V0));
    expect(newMatch('ABC123', CTF_V0).bases).not.toEqual(newMatch('ZZZ999', CTF_V0).bases);
  });
  it('places the two bases on opposite sides of the origin, flags at home', () => {
    const m = newMatch('ABC123', CTF_V0);
    const [a, b] = m.bases;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(2 * CTF_V0.arena.baseDistanceM, 2);
    expect(m.flags.map((f) => [f.x, f.z])).toEqual(m.bases.map((b) => [b.x, b.z]));
    expect(m.phase).toBe('lobby');
  });
});

describe('teams', () => {
  it('fills the smaller team, ties go to team 0', () => {
    expect(assignTeam([])).toBe(0);
    expect(assignTeam([0])).toBe(1);
    expect(assignTeam([0, 1, 1])).toBe(0);
  });
});

describe('stepMatch', () => {
  it('does nothing in the lobby', () => {
    const m = newMatch('ABC123', CTF_V0);
    const enemyFlag = m.flags[1];
    const r = stepMatch(m, [at('a', 0, enemyFlag.x, enemyFlag.z)], 2_000);
    expect(r.events).toEqual([]);
  });

  it('picks up the enemy flag, carries it, and captures at home', () => {
    let m = playing();
    const enemy = m.flags[1];
    let r = stepMatch(m, [at('a', 0, enemy.x + 1, enemy.z)], 2_000);
    expect(r.events).toEqual([{ kind: 'pickup', player: 'a', flag: 1 }]);
    m = r.state;
    expect(m.flags[1].carrier).toBe('a');

    const mid = { x: (m.bases[0].x + m.bases[1].x) / 2, z: (m.bases[0].z + m.bases[1].z) / 2 };
    m = stepMatch(m, [at('a', 0, mid.x, mid.z)], 3_000).state;
    expect([m.flags[1].x, m.flags[1].z]).toEqual([mid.x, mid.z]);

    r = stepMatch(m, [at('a', 0, m.bases[0].x, m.bases[0].z)], 4_000);
    expect(r.events).toEqual([{ kind: 'capture', player: 'a', flag: 1, team: 0 }]);
    expect(r.state.score).toEqual([1, 0]);
    expect(r.state.flags[1].carrier).toBeNull();
    expect([r.state.flags[1].x, r.state.flags[1].z]).toEqual([
      r.state.bases[1].x,
      r.state.bases[1].z,
    ]);
  });

  it('cannot pick up its own flag', () => {
    const m = playing();
    const own = m.flags[0];
    expect(stepMatch(m, [at('a', 0, own.x, own.z)], 2_000).events).toEqual([]);
  });

  it('a defender tags an intruder in their half: the flag goes home', () => {
    let m = playing();
    const enemy = m.flags[1];
    m = stepMatch(m, [at('a', 0, enemy.x, enemy.z)], 2_000).state;
    const r = stepMatch(
      m,
      [at('a', 0, enemy.x + 1, enemy.z), at('d', 1, enemy.x + 2, enemy.z)],
      3_000,
    );
    expect(r.events).toEqual([
      { kind: 'tag', player: 'a', by: 'd' },
      { kind: 'return', flag: 1 },
    ]);
    expect(r.state.flags[1].carrier).toBeNull();
  });

  it('only the player standing in the enemy half is tagged', () => {
    const m = playing();
    const home = m.bases[0];
    // `a` is home; `d` has wandered into team 0's half.
    expect(
      stepMatch(m, [at('a', 0, home.x, home.z), at('d', 1, home.x + 1, home.z)], 2_000).events,
    ).toEqual([{ kind: 'tag', player: 'd', by: 'a' }]);
  });

  it('ends when a team reaches capturesToWin', () => {
    let m = playing();
    for (let i = 0; i < CTF_V0.capturesToWin; i++) {
      m = stepMatch(m, [at('a', 0, m.flags[1].x, m.flags[1].z)], 2_000 + i * 10).state;
      m = stepMatch(m, [at('a', 0, m.bases[0].x, m.bases[0].z)], 2_005 + i * 10).state;
    }
    expect(m.phase).toBe('ended');
    expect(m.winner).toBe(0);
  });

  it('ends on time with the leader winning, or a draw', () => {
    const m = playing();
    const r = stepMatch(m, [], m.endsAt!);
    expect(r.state.phase).toBe('ended');
    expect(r.state.winner).toBeNull();
    expect(r.events).toEqual([{ kind: 'end', winner: null }]);
  });

  it('drops a carried flag home when its carrier leaves', () => {
    let m = playing();
    m = stepMatch(m, [at('a', 0, m.flags[1].x, m.flags[1].z)], 2_000).state;
    const r = stepMatch(m, [], 3_000);
    expect(r.state.flags[1].carrier).toBeNull();
    expect(r.events).toEqual([{ kind: 'return', flag: 1 }]);
  });
});

describe('team fog (visibleTo)', () => {
  const players = [at('a', 0, 0, 0), at('b', 0, 100, 0), at('x', 1, 130, 0), at('y', 1, 500, 0)];
  it('teammates are always visible', () => {
    expect(visibleTo(0, players[1]!, players, CTF_V0.ruleset.fog)).toBe(true);
  });
  it('enemies are visible within reveal radius of any teammate', () => {
    expect(visibleTo(0, players[2]!, players, CTF_V0.ruleset.fog)).toBe(true);
    expect(visibleTo(0, players[3]!, players, CTF_V0.ruleset.fog)).toBe(false);
  });
  it('fog mode none reveals everyone', () => {
    expect(
      visibleTo(0, players[3]!, players, { mode: 'none', revealRadiusM: 1, fadeAfterS: 0 }),
    ).toBe(true);
  });
});

import { ClientMessage, newSessionCode, SESSION_CODE } from '../src/game/protocol';

describe('session protocol', () => {
  it('validates client messages', () => {
    expect(ClientMessage.safeParse({ t: 'pos', x: 1, z: 2, yaw: 0 }).success).toBe(true);
    expect(ClientMessage.safeParse({ t: 'pos', x: Infinity, z: 2, yaw: 0 }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'hello', name: '   ' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'teleport', x: 1 }).success).toBe(false);
  });
  it('makes readable codes', () => {
    for (let i = 0; i < 50; i++) expect(newSessionCode()).toMatch(SESSION_CODE);
  });
});
