import { DurableObject } from 'cloudflare:workers';
import { canRun, REQUIREMENTS, type AgentManifest, type Job, type JobKind } from '@otherhere/core';
import type { Env } from './env';

/** A claim lasts this long; a result after it is refused and the job is handed out again. */
const LEASE_MS = 5 * 60_000;
/** After this many claims without an accepted result, a job is given up on. */
const MAX_ATTEMPTS = 3;

export type JobStatus = 'queued' | 'leased' | 'done' | 'failed';
export type JobRow = {
  id: string;
  kind: JobKind;
  block: string;
  status: JobStatus;
  agent: string | null;
  attempts: number;
  error: string | null;
  updatedAt: string;
};

/**
 * The Plugin job queue (ADR-0015): one instance for the deployment. Plugins pull
 * jobs they can run and hold a short lease; nothing here writes to a World.
 * Results go to the TownDO, which validates them.
 */
export class JobsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        block TEXT NOT NULL,
        status TEXT NOT NULL,
        agent TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_open ON jobs(status, created_at);
    `);
  }

  /**
   * Queue a job. Idempotent: one job per (kind, block). A finished or failed job
   * is queued again only when `again` is set, e.g. a crawler refreshing a block.
   */
  async enqueue(kind: JobKind, block: string, again = false): Promise<string> {
    const id = `${kind}:${block}`;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO jobs (id, kind, block, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'queued', attempts = 0, error = NULL, agent = NULL,
         lease_until = 0, updated_at = excluded.updated_at
       WHERE ? AND jobs.status IN ('done', 'failed')`,
      id,
      kind,
      block,
      now,
      now,
      again ? 1 : 0,
    );
    return id;
  }

  /** Lease the oldest open job this Plugin can run, or null. Expired leases count as open. */
  async claim(manifest: AgentManifest, now = Date.now()): Promise<Job | null> {
    const kinds = manifest.kinds.filter((k) => canRun(REQUIREMENTS[k], manifest.capabilities));
    if (!kinds.length) return null;
    this.sql.exec(
      `UPDATE jobs SET status = 'failed', error = 'lease expired without a result', updated_at = ?
       WHERE status = 'leased' AND lease_until < ? AND attempts >= ?`,
      now,
      now,
      MAX_ATTEMPTS,
    );
    const row = this.sql
      .exec<{ id: string; kind: JobKind; block: string }>(
        `SELECT id, kind, block FROM jobs
         WHERE (status = 'queued' OR (status = 'leased' AND lease_until < ?))
           AND kind IN (${kinds.map(() => '?').join(',')})
         ORDER BY created_at LIMIT 1`,
        now,
        ...kinds,
      )
      .toArray()[0];
    if (!row) return null;
    const leaseUntil = now + LEASE_MS;
    this.sql.exec(
      `UPDATE jobs SET status = 'leased', agent = ?, lease_until = ?, attempts = attempts + 1,
         updated_at = ? WHERE id = ?`,
      manifest.agent,
      leaseUntil,
      now,
      row.id,
    );
    return { ...row, leaseUntil: new Date(leaseUntil).toISOString() };
  }

  /** The job a result is for, if `agent` still holds its lease. */
  async leaseOf(
    id: string,
    agent: string,
    now = Date.now(),
  ): Promise<{ kind: JobKind; block: string } | null> {
    return (
      this.sql
        .exec<{ kind: JobKind; block: string }>(
          `SELECT kind, block FROM jobs WHERE id = ? AND status = 'leased' AND agent = ? AND lease_until >= ?`,
          id,
          agent,
          now,
        )
        .toArray()[0] ?? null
    );
  }

  /** Record the TownDO's verdict on a result. A rejected result frees the job for another try. */
  async settle(id: string, verdict: { ok: true } | { ok: false; error: string }): Promise<void> {
    const now = Date.now();
    if (verdict.ok) {
      this.sql.exec(
        `UPDATE jobs SET status = 'done', error = NULL, lease_until = 0, updated_at = ? WHERE id = ?`,
        now,
        id,
      );
      return;
    }
    this.sql.exec(
      `UPDATE jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
         error = ?, lease_until = 0, updated_at = ? WHERE id = ?`,
      MAX_ATTEMPTS,
      verdict.error.slice(0, 500),
      now,
      id,
    );
  }

  async list(limit = 50): Promise<JobRow[]> {
    return this.sql
      .exec<{
        id: string;
        kind: JobKind;
        block: string;
        status: JobStatus;
        agent: string | null;
        attempts: number;
        error: string | null;
        updated_at: number;
      }>('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?', Math.min(limit, 500))
      .toArray()
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        block: r.block,
        status: r.status,
        agent: r.agent,
        attempts: r.attempts,
        error: r.error,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
  }
}

export const jobsStub = (env: Env) => env.JOBS.get(env.JOBS.idFromName('jobs'));
