import { DurableObject } from 'cloudflare:workers';
import { JudgeEvent, type DecisionLog } from '@otherhere/core';
import type { BudgetLedger } from '@otherhere/models';
import type { Env } from './env';

/**
 * Operational state for one deployment: model spend per provider per day
 * (the router's ledger, invariant 9), every Ladder decision, and judge events.
 * A single instance (`ops`); its traffic is a few writes per model call.
 */
export class OpsDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS spend (provider TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (provider, day));
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, at TEXT NOT NULL, subject TEXT NOT NULL, rung TEXT NOT NULL, outcome TEXT NOT NULL, cost_usd REAL NOT NULL, confidence REAL NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_by_at ON decisions(at);
      CREATE TABLE IF NOT EXISTS judge_events (rowid INTEGER PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
    `);
  }

  async spent(provider: string, day: string): Promise<number> {
    return (
      this.sql
        .exec<{ usd: number }>(
          'SELECT usd FROM spend WHERE provider = ? AND day = ?',
          provider,
          day,
        )
        .toArray()[0]?.usd ?? 0
    );
  }

  async add(provider: string, day: string, usd: number): Promise<void> {
    this.sql.exec(
      'INSERT INTO spend (provider, day, usd) VALUES (?, ?, ?) ON CONFLICT(provider, day) DO UPDATE SET usd = usd + excluded.usd',
      provider,
      day,
      usd,
    );
  }

  async spendToday(day: string): Promise<Record<string, number>> {
    return Object.fromEntries(
      this.sql
        .exec<{ provider: string; usd: number }>(
          'SELECT provider, usd FROM spend WHERE day = ?',
          day,
        )
        .toArray()
        .map((r) => [r.provider, r.usd]),
    );
  }

  async logDecision(d: DecisionLog): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO decisions (id, at, subject, rung, outcome, cost_usd, confidence, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      d.id,
      d.at,
      d.subject,
      d.rung,
      d.outcome,
      d.costUsd,
      d.confidence,
      JSON.stringify(d),
    );
  }

  async recentDecisions(limit: number): Promise<DecisionLog[]> {
    return this.sql
      .exec<{ body: string }>(
        'SELECT body FROM decisions ORDER BY at DESC LIMIT ?',
        Math.min(200, Math.max(1, limit)),
      )
      .toArray()
      .map((r) => JSON.parse(r.body) as DecisionLog);
  }

  /** Two judges (truth, taste): storage only for now. */
  async recordJudgeEvent(e: unknown): Promise<void> {
    const ev = JudgeEvent.parse(e);
    this.sql.exec(
      'INSERT INTO judge_events (kind, at, body) VALUES (?, ?, ?)',
      ev.kind,
      ev.at,
      JSON.stringify(ev),
    );
  }

  async judgeEventCount(kind: 'truth' | 'taste'): Promise<number> {
    return this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM judge_events WHERE kind = ?', kind)
      .toArray()[0]!.n;
  }
}

export const opsStub = (env: Env) => env.OPS.get(env.OPS.idFromName('ops'));

/** The router's ledger, backed by the OpsDO. */
export function opsLedger(env: Env): BudgetLedger {
  const ops = opsStub(env);
  return { spent: (p, d) => ops.spent(p, d), add: (p, d, usd) => ops.add(p, d, usd) };
}
