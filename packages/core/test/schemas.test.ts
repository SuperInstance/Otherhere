import { describe, expect, it } from 'vitest';
import { Capsule } from '../src/schema/capsule';
import { QuestionPack } from '../src/schema/question-pack';
import { Ruleset } from '../src/schema/ruleset';
import { Feature } from '../src/schema/feature';
import { cellAt } from '../src/geo/h3';
import { ringFor } from '../src/schema/world';

const cell = cellAt(47.3769, 8.5417);

const capsule = {
  format: 'otherhere.capsule',
  formatVersion: 1,
  id: 'cap_00000001',
  kind: 'place',
  title: 'Trail to the falls',
  scope: 'private',
  createdAt: '2026-10-17T00:00:00Z',
  cells: [cell],
  snapshot: { facts: [], generators: [] },
  privacy: { blurred: false },
};

describe('Capsule privacy (invariant 5)', () => {
  it('private capsules need no blur', () => {
    expect(Capsule.safeParse(capsule).success).toBe(true);
  });
  it('cannot leave private scope unblurred', () => {
    expect(Capsule.safeParse({ ...capsule, scope: 'friends' }).success).toBe(false);
    expect(
      Capsule.safeParse({ ...capsule, scope: 'friends', privacy: { blurred: true } }).success,
    ).toBe(true);
  });
  it('kid accounts never publish', () => {
    expect(
      Capsule.safeParse({
        ...capsule,
        scope: 'public',
        privacy: { blurred: true },
        ownerIsKid: true,
      }).success,
    ).toBe(false);
  });
});

describe('QuestionPack limits', () => {
  const q = (question: unknown) =>
    QuestionPack.safeParse({
      id: 'pack.building',
      version: '1.0.0',
      description: '',
      questions: { roof: question },
    });
  it('choice allows 2..255 options; score 2..10 levels', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
    expect(q({ type: 'choice', instructions: '', criteria: '', options: opts(255) }).success).toBe(
      true,
    );
    expect(q({ type: 'choice', instructions: '', criteria: '', options: opts(256) }).success).toBe(
      false,
    );
    expect(q({ type: 'score', instructions: '', criteria: '', levels: 11 }).success).toBe(false);
    expect(q({ type: 'noul', instructions: 'Is it a church?', criteria: '' }).success).toBe(true);
  });
});

describe('Ruleset', () => {
  it('describes capture the flag with team fog', () => {
    expect(
      Ruleset.safeParse({
        id: 'rules.ctf',
        version: '0.1.0',
        name: 'Capture the flag',
        teams: 2,
        durationS: 1200,
        objectives: [{ type: 'capture_the_flag', flagsPerTeam: 1, capturesToWin: 3 }],
        fog: { mode: 'team', revealRadiusM: 40, fadeAfterS: 30 },
      }).success,
    ).toBe(true);
  });
});

describe('Feature', () => {
  it('accepts road segment IDs', () => {
    expect(Feature.safeParse({ id: 'osm:w5:n1-n2', kind: 'road', anchorCell: cell }).success).toBe(
      true,
    );
    expect(
      Feature.safeParse({ id: 'osm:w5', kind: 'road', anchorCell: '8928308280fffff0' }).success,
    ).toBe(false);
  });
});

describe('fog ring stub', () => {
  it('keeps memories recent and nearby cells in focus', () => {
    expect(ringFor({ distanceCells: 0, lastSeenS: 1e9, holdsMemory: false })).toBe('focus');
    expect(ringFor({ distanceCells: 9, lastSeenS: 1e9, holdsMemory: true })).toBe('recent');
    expect(ringFor({ distanceCells: 9, lastSeenS: 1e9, holdsMemory: false })).toBe('remembered');
  });
});
