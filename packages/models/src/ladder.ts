import {
  Answer,
  packConfidence,
  type Answers,
  type Decision,
  type DecisionLog,
  type DecisionRequest,
  type LadderRung,
  type Rung,
} from '@otherhere/core';
import { BudgetExceeded, ProviderUnavailable } from './router';
import { JevRejected, type JevProvider } from './providers/jev';
import type { ChatProvider } from './providers/chat';
import type { ClaudeProvider } from './providers/claude';

export type LadderResult = { decision: Decision; rung: Rung; accepted: boolean } | null;

/**
 * Escalate a decision from the cheapest rung to the most expensive until one is
 * confident enough (ADR-0013). Every attempt is logged with rung, cost, and
 * confidence. Each rung is asked once; a rung that declines the input (`refused`)
 * is logged as a refusal, not a low score, and the next rung is asked. If no rung clears the bar, the most confident answer is returned
 * with `accepted: false`, so callers can treat it as a weak hint or ignore it.
 */
export class Ladder {
  constructor(
    private rungs: LadderRung[],
    private opts: {
      threshold?: number;
      log: (d: DecisionLog) => void | Promise<void>;
      now?: () => Date;
      id?: () => string;
    },
  ) {}

  async decide(req: DecisionRequest): Promise<LadderResult> {
    const threshold = this.opts.threshold ?? 0.7;
    let best: LadderResult = null;
    for (const rung of this.rungs) {
      const t0 = Date.now();
      const base = {
        id: this.opts.id?.() ?? crypto.randomUUID(),
        at: (this.opts.now?.() ?? new Date()).toISOString(),
        pack: req.pack.id,
        packVersion: req.pack.version,
        subject: req.subject,
        rung: rung.rung,
      };
      let d: Decision | null;
      try {
        d = await rung.decide(req);
      } catch (err) {
        await this.opts.log({
          ...base,
          outcome:
            err instanceof BudgetExceeded || err instanceof ProviderUnavailable
              ? 'unavailable'
              : err instanceof JevRejected
                ? 'refused'
                : 'error',
          costUsd: 0,
          latencyMs: Date.now() - t0,
          confidence: 0,
          answers: null,
          error: String((err as Error).message).slice(0, 300),
        });
        continue;
      }
      if (!d) {
        await this.opts.log({
          ...base,
          outcome: 'unavailable',
          costUsd: 0,
          latencyMs: Date.now() - t0,
          confidence: 0,
          answers: null,
        });
        continue;
      }
      const accepted = d.confidence >= threshold;
      await this.opts.log({
        ...base,
        outcome: accepted ? 'accepted' : 'escalated',
        costUsd: d.costUsd,
        latencyMs: Date.now() - t0,
        confidence: d.confidence,
        answers: d.answers,
      });
      if (accepted) return { decision: d, rung: rung.rung, accepted: true };
      if (!best || d.confidence > best.decision.confidence)
        best = { decision: d, rung: rung.rung, accepted: false };
    }
    return best;
  }
}

/** Rung 1: deterministic rules (free). */
export function ruleRung(fn: (req: DecisionRequest) => Answers | null): LadderRung {
  return {
    rung: 'rule',
    async decide(req) {
      const answers = fn(req);
      return answers ? { answers, confidence: packConfidence(answers), costUsd: 0 } : null;
    },
  };
}

export function jevRung(jev: JevProvider): LadderRung {
  return {
    rung: 'jev',
    async decide(req) {
      const r = await jev.ask(req.pack, req.state);
      return { answers: r.value, confidence: packConfidence(r.value), costUsd: r.costUsd };
    },
  };
}

/** Ask a general LLM to answer a pack in Jev's answer shapes. */
export function llmRung(provider: ChatProvider | ClaudeProvider): LadderRung {
  return {
    rung: provider.id,
    async decide(req) {
      const system =
        'Answer every question about the state. Reply with one JSON object mapping each question id to an answer: ' +
        '{"type":"noul","noul":<probability of yes 0..1>} for noul questions, {"type":"choice","choice":<one criteria key>,"confidence":<0..1>} for choice questions, ' +
        '{"type":"score","score":<level index>,"confidence":<0..1>} for score questions. Be calibrated: use low confidence when unsure.';
      const user = JSON.stringify({ state: req.state, questions: req.pack.questions });
      const r =
        provider.id === 'claude'
          ? await (provider as ClaudeProvider).complete(system, user, 4000)
          : await (provider as ChatProvider).complete(
              [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              { maxTokens: 1200, json: true },
            );
      const answers = parseAnswers(r.value, req);
      return answers
        ? { answers, confidence: packConfidence(answers), costUsd: r.costUsd }
        : { answers: {}, confidence: 0, costUsd: r.costUsd };
    },
  };
}

/** Last rung: turn the question into a quest for a person. It never answers inline. */
export function humanRung(enqueue: (req: DecisionRequest) => void | Promise<void>): LadderRung {
  return {
    rung: 'human',
    async decide(req) {
      await enqueue(req);
      return null;
    },
  };
}

function parseAnswers(text: string, req: DecisionRequest): Answers | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const out: Answers = {};
  for (const [id, q] of Object.entries(req.pack.questions)) {
    const a = Answer.safeParse(json[id]);
    if (!a.success || a.data.type !== q.type) return null;
    if (a.data.type === 'choice' && q.type === 'choice' && !(a.data.choice in q.criteria))
      return null;
    out[id] = a.data;
  }
  return out;
}
