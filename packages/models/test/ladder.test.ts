import { describe, expect, it } from 'vitest';
import { BUILDING_PACK, type Answers, type DecisionLog, type LadderRung } from '@otherhere/core';
import { Ladder, humanRung, llmRung, ruleRung } from '../src/ladder';
import { observeBuilding } from '../src/observe';
import { BudgetExceeded, MemoryLedger, ModelRouter, ProviderUnavailable } from '../src/router';
import { ChatProvider } from '../src/providers/chat';
import { JevProvider, JevRejected } from '../src/providers/jev';

const sure: Answers = {
  visible: { type: 'noul', noul: 0.98 },
  roof_shape: { type: 'choice', choice: 'gable', confidence: 0.95 },
  floors: { type: 'choice', choice: '2', confidence: 0.9 },
  wall_colour: { type: 'choice', choice: 'brick', confidence: 0.9 },
  roof_colour: { type: 'choice', choice: 'red', confidence: 0.9 },
};
const unsure: Answers = { ...sure, roof_shape: { type: 'choice', choice: 'hip', confidence: 0.4 } };
const fixed = (rung: LadderRung['rung'], answers: Answers | null, costUsd = 0.001): LadderRung => ({
  rung,
  decide: async () =>
    answers
      ? {
          answers,
          confidence: Math.min(
            ...Object.values(answers).map((a) =>
              a.type === 'noul' ? Math.max(a.noul, 1 - a.noul) : a.confidence,
            ),
          ),
          costUsd,
        }
      : null,
});
const req = { pack: BUILDING_PACK, state: 'a house', subject: 'osm:w1' };

describe('Ladder', () => {
  it('stops at the first confident rung and logs every attempt', async () => {
    const logs: DecisionLog[] = [];
    const ladder = new Ladder(
      [ruleRung(() => null), fixed('jev', unsure), fixed('groq', sure), fixed('claude', sure)],
      { log: (d) => void logs.push(d) },
    );
    const r = await ladder.decide(req);
    expect(r).toMatchObject({ rung: 'groq', accepted: true });
    expect(logs.map((l) => [l.rung, l.outcome])).toEqual([
      ['rule', 'unavailable'],
      ['jev', 'escalated'],
      ['groq', 'accepted'],
    ]);
    expect(logs[1]!.confidence).toBe(0.4);
  });

  it('returns the best weak answer, unaccepted, when no rung is sure', async () => {
    const ladder = new Ladder([fixed('jev', unsure), humanRung(() => {})], { log: () => {} });
    expect(await ladder.decide(req)).toMatchObject({ rung: 'jev', accepted: false });
  });

  it('skips a rung whose budget is exhausted', async () => {
    const logs: DecisionLog[] = [];
    const broke: LadderRung = {
      rung: 'jev',
      decide: () => Promise.reject(new BudgetExceeded('jev', 1, 1)),
    };
    const r = await new Ladder([broke, fixed('groq', sure)], {
      log: (d) => void logs.push(d),
    }).decide(req);
    expect(r?.rung).toBe('groq');
    expect(logs[0]).toMatchObject({ rung: 'jev', outcome: 'unavailable' });
  });

  it('logs a declined input as a refusal and asks the next rung', async () => {
    const logs: DecisionLog[] = [];
    const declines: LadderRung = {
      rung: 'jev',
      decide: () => Promise.reject(new JevRejected(400, 'Invalid image dimensions')),
    };
    const r = await new Ladder([declines, fixed('groq', sure)], {
      log: (d) => void logs.push(d),
    }).decide(req);
    expect(r).toMatchObject({ rung: 'groq', accepted: true });
    expect(logs.map((l) => [l.rung, l.outcome])).toEqual([
      ['jev', 'refused'],
      ['groq', 'accepted'],
    ]);
  });

  it('skips a rate-limited rung as unavailable', async () => {
    const logs: DecisionLog[] = [];
    const limited: LadderRung = {
      rung: 'minimax',
      decide: () =>
        Promise.reject(new ProviderUnavailable('minimax', 429, 'Token Plan rate limit')),
    };
    const r = await new Ladder([limited, fixed('claude', sure)], {
      log: (d) => void logs.push(d),
    }).decide(req);
    expect(r?.rung).toBe('claude');
    expect(logs[0]).toMatchObject({ rung: 'minimax', outcome: 'unavailable' });
  });

  it('turns unanswerable questions into quests for people', async () => {
    const quests: string[] = [];
    await new Ladder([humanRung((r) => void quests.push(r.subject))], { log: () => {} }).decide(
      req,
    );
    expect(quests).toEqual(['osm:w1']);
  });
});

describe('llmRung', () => {
  const router = new ModelRouter({ caps: { groq: 1 }, ledger: new MemoryLedger() });
  const groqReplying = (content: string) =>
    new ChatProvider(router, 'groq', {
      apiKey: 'k',
      fetch: async () =>
        Response.json({
          model: 'm',
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
    });

  it('accepts well-formed answers in Jev shape', async () => {
    const d = await llmRung(groqReplying(JSON.stringify(sure))).decide(req);
    expect(d?.answers.roof_shape).toMatchObject({ choice: 'gable' });
    expect(d?.confidence).toBe(0.9);
  });

  it('rejects choices outside the criteria', async () => {
    const d = await llmRung(
      groqReplying(
        JSON.stringify({ ...sure, roof_shape: { type: 'choice', choice: 'dome', confidence: 1 } }),
      ),
    ).decide(req);
    expect(d?.confidence).toBe(0);
  });
});

describe('observeBuilding', () => {
  it('turns a photo into Facts through vision and the Ladder', async () => {
    const router = new ModelRouter({ caps: { groq: 1 }, ledger: new MemoryLedger() });
    const vision = new ChatProvider(router, 'groq', {
      apiKey: 'k',
      fetch: async () =>
        Response.json({
          model: 'm',
          choices: [
            {
              message: { content: 'A red-brick two-storey house with a gable roof of red tiles.' },
            },
          ],
          usage: { prompt_tokens: 1800, completion_tokens: 20 },
        }),
    });
    const ladder = new Ladder([fixed('jev', sure)], { log: () => {} });
    const r = await observeBuilding(
      {
        jpegBase64: 'AAAA',
        featureId: 'osm:w1',
        source: 'capture',
        observedAt: '2026-10-17T00:00:00.000Z',
      },
      { vision, ladder },
    );
    expect(r.observation).toContain('gable');
    expect(r.facts.map((f) => f.attribute).sort()).toEqual([
      'colour',
      'levels',
      'roof.colour',
      'roof.shape',
    ]);
    expect(r.facts.every((f) => f.source === 'capture')).toBe(true);
  });
});

describe('observeBuilding field gating', () => {
  it('keeps confident fields even when one answer is unsure', async () => {
    const router = new ModelRouter({ caps: { groq: 1 }, ledger: new MemoryLedger() });
    const vision = new ChatProvider(router, 'groq', {
      apiKey: 'k',
      fetch: async () =>
        Response.json({
          model: 'm',
          choices: [{ message: { content: 'A brick house.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });
    const ladder = new Ladder([fixed('jev', unsure)], { log: () => {} });
    const r = await observeBuilding(
      {
        jpegBase64: 'AAAA',
        featureId: 'osm:w1',
        source: 'capture',
        observedAt: '2026-10-17T00:00:00.000Z',
      },
      { vision, ladder },
    );
    expect(r.result?.accepted).toBe(false);
    // The unsure roof (0.4) is dropped; floors, walls and roof colour are kept.
    expect(r.facts.map((f) => f.attribute).sort()).toEqual(['colour', 'levels', 'roof.colour']);
  });
});

describe('observeBuilding visibility gate', () => {
  const router = () => new ModelRouter({ caps: { groq: 1, jev: 1 }, ledger: new MemoryLedger() });
  // A vision model that always finds "the building nearest the centre".
  const vision = (r: ModelRouter) =>
    new ChatProvider(r, 'groq', {
      apiKey: 'k',
      fetch: async () =>
        Response.json({
          model: 'm',
          choices: [{ message: { content: 'A two-storey brick house with a gable roof.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });
  const gate = (r: ModelRouter, response: Response) =>
    new JevProvider(r, { apiKey: 'k', fetch: async () => response.clone() });
  const input = {
    jpegBase64: 'AAAA',
    featureId: 'osm:w1',
    source: 'capture' as const,
    observedAt: '2026-10-17T00:00:00.000Z',
  };

  it("Jev reading the photo overrules the vision model's building", async () => {
    const r = router();
    const noBuilding = Response.json({
      model: 'jev-1.13.0',
      answers: { visible: { type: 'noul', noul: 0.04 } },
      usage: { input_tokens: 300, output_tokens: 1 },
    });
    const obs = await observeBuilding(input, {
      vision: vision(r),
      ladder: new Ladder([fixed('jev', sure)], { log: () => {} }),
      gate: gate(r, noBuilding),
    });
    expect(obs.gate).toMatchObject({ noul: 0.04 });
    expect(obs.facts).toEqual([]);
    // Sure enough that the vision call was never made.
    expect(obs.visionCostUsd).toBe(0);
    expect(obs.result).toBeNull();
  });

  it('falls back to the observation when Jev refuses the image', async () => {
    const r = router();
    const refused = Response.json({ detail: 'Invalid image dimensions.' }, { status: 400 });
    const obs = await observeBuilding(input, {
      vision: vision(r),
      ladder: new Ladder([fixed('jev', sure)], { log: () => {} }),
      gate: gate(r, refused),
    });
    expect(obs.gate).toMatchObject({ skipped: 'refused' });
    expect(obs.facts.length).toBe(4);
  });
});
