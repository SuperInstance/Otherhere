import type { AgentManifest, Job, JobKind, Proposal } from '@otherhere/core';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Runs one job and returns the proposal to send back. Handlers never write to a World. */
export type Handler = (job: Job) => Promise<Proposal>;

export type Outcome =
  | { kind: 'idle' }
  | { kind: 'accepted'; job: string; detail: unknown }
  | { kind: 'rejected'; job: string; status: number; error: string }
  | { kind: 'failed'; job: string; error: string };

/**
 * The Plugin loop (ADR-0015): claim a job this device can run, run it, send the
 * result back as a proposal. The edge decides whether to accept it.
 */
export class AgentRuntime {
  constructor(
    private opts: {
      edge: string;
      token: string;
      manifest: AgentManifest;
      handlers: Partial<Record<JobKind, Handler>>;
      fetch?: FetchLike;
      log?: (line: string) => void;
    },
  ) {}

  private post(path: string, body: unknown): Promise<Response> {
    return (this.opts.fetch ?? fetch)(new URL(path, this.opts.edge).toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'x-agent': this.opts.manifest.agent,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /** Claim and run at most one job. */
  async runOnce(): Promise<Outcome> {
    const res = await this.post('/api/agent/claim', this.opts.manifest);
    if (res.status === 204) return { kind: 'idle' };
    if (!res.ok) throw new Error(`claim: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { job } = (await res.json()) as { job: Job };
    const handler = this.opts.handlers[job.kind];
    let proposal: Proposal;
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      proposal = await handler(job);
    } catch (err) {
      // Leave the job alone: its lease runs out and another device can take it.
      const error = (err as Error).message;
      this.opts.log?.(`${job.id}: failed: ${error}`);
      return { kind: 'failed', job: job.id, error };
    }
    const sent = await this.post(`/api/agent/jobs/${encodeURIComponent(job.id)}/result`, proposal);
    const body = (await sent.json().catch(() => ({}))) as { error?: string };
    if (!sent.ok) {
      const error = body.error ?? `HTTP ${sent.status}`;
      this.opts.log?.(`${job.id}: rejected: ${error}`);
      return { kind: 'rejected', job: job.id, status: sent.status, error };
    }
    this.opts.log?.(`${job.id}: accepted ${JSON.stringify(body)}`);
    return { kind: 'accepted', job: job.id, detail: body };
  }

  /** Keep working until `signal` aborts. Waits `idleMs` when there is nothing to do or the edge is unreachable. */
  async run(signal: AbortSignal, idleMs = 15_000): Promise<void> {
    while (!signal.aborted) {
      let wait = 0;
      try {
        if ((await this.runOnce()).kind === 'idle') wait = idleMs;
      } catch (err) {
        this.opts.log?.(`edge: ${(err as Error).message}`);
        wait = idleMs * 2;
      }
      if (wait) await sleep(wait, signal);
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
