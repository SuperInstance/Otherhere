import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILDING_PACK } from '@otherhere/core';
import { JUDGE_FILES, parsePhotos, parseTruth, scoreCase, summarize } from '../src/index';

const root = new URL('../', import.meta.url);
const cases = parseTruth(
  readFileSync(new URL('evals/truth/building-observations.v1.jsonl', root), 'utf8'),
);

describe('the judge is fixed (invariant 6)', () => {
  it('matches JUDGE.lock.json: changing the judge needs a deliberate, reviewed re-pin', () => {
    const lock = JSON.parse(readFileSync(new URL('JUDGE.lock.json', root), 'utf8')) as Record<
      string,
      string
    >;
    for (const f of JUDGE_FILES) {
      expect(
        createHash('sha256')
          .update(readFileSync(new URL(f, root)))
          .digest('hex'),
        f,
      ).toBe(lock[f]);
    }
  });
});

describe('truth eval: building observations v1', () => {
  it('only uses answers the building pack can give', () => {
    for (const c of cases) {
      for (const [q, want] of Object.entries(c.expected)) {
        if (q === 'visible') continue;
        const question = BUILDING_PACK.questions[q];
        expect(
          question?.type === 'choice' && String(want) in question.criteria,
          `${c.id}.${q}=${want}`,
        ).toBe(true);
      }
    }
  });

  it('scores perfect answers as perfect and empty answers as zero', () => {
    const perfect = cases.map((c) =>
      scoreCase(c, {
        visible: { type: 'noul', noul: c.expected.visible ? 1 : 0 },
        ...Object.fromEntries(
          Object.entries(c.expected)
            .filter(([k]) => k !== 'visible')
            .map(([k, v]) => [k, { type: 'choice' as const, choice: v as string, confidence: 1 }]),
        ),
      }),
    );
    expect(summarize(perfect).accuracy).toBe(1);
    expect(summarize(cases.map((c) => scoreCase(c, null))).accuracy).toBe(0);
  });
});

describe('truth eval: building photos v1', () => {
  const photos = parsePhotos(
    readFileSync(new URL('evals/truth/building-photos.v1.jsonl', root), 'utf8'),
  );
  it('has a credited image for every case and labels the pack can give', () => {
    expect(photos).toHaveLength(10);
    for (const p of photos) {
      expect(readFileSync(new URL(`evals/truth/${p.image}`, root)).byteLength).toBeGreaterThan(
        10_000,
      );
      expect(p.credit.license).toMatch(/^CC (BY|PDM|0)\b/);
      for (const [q, want] of Object.entries(p.expected)) {
        if (q === 'visible') continue;
        const question = BUILDING_PACK.questions[q];
        expect(
          question?.type === 'choice' && String(want) in question.criteria,
          `${p.id}.${q}=${want}`,
        ).toBe(true);
      }
    }
  });
});
