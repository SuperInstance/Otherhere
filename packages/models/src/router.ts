// The one door every paid model call goes through (invariant 9): per-provider
// daily budget caps, checked before the call and charged after it.

export type Usage = { inputTokens: number; outputTokens: number };
export type Pricing = { inputPerM: number; outputPerM: number };
export type Priced<T> = {
  value: T;
  usage: Usage;
  costUsd: number;
  provider: string;
  model: string;
  latencyMs: number;
};

export interface BudgetLedger {
  spent(provider: string, day: string): Promise<number>;
  add(provider: string, day: string, usd: number): Promise<void>;
}

export class MemoryLedger implements BudgetLedger {
  private m = new Map<string, number>();
  async spent(provider: string, day: string) {
    return this.m.get(`${provider}/${day}`) ?? 0;
  }
  async add(provider: string, day: string, usd: number) {
    this.m.set(`${provider}/${day}`, (this.m.get(`${provider}/${day}`) ?? 0) + usd);
  }
}

export class BudgetExceeded extends Error {
  constructor(
    readonly provider: string,
    readonly spent: number,
    readonly cap: number,
  ) {
    super(`${provider}: daily budget exhausted ($${spent.toFixed(4)} of $${cap})`);
  }
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export const costOf = (u: Usage, p: Pricing) =>
  (u.inputTokens * p.inputPerM + u.outputTokens * p.outputPerM) / 1_000_000;

export class ModelRouter {
  constructor(
    private opts: {
      /** Daily USD cap per provider. A provider with no cap is disabled. */
      caps: Record<string, number>;
      ledger: BudgetLedger;
      now?: () => Date;
    },
  ) {}

  /** Whether a provider has budget configured at all. */
  enabled(provider: string): boolean {
    return (this.opts.caps[provider] ?? 0) > 0;
  }

  /**
   * Run one paid call. `estimateUsd` is an upper bound used for the pre-check;
   * the actual cost (from usage × pricing) is what gets charged.
   */
  async run<T>(
    provider: string,
    estimateUsd: number,
    pricing: Pricing,
    call: () => Promise<{ value: T; usage: Usage; model: string }>,
  ): Promise<Priced<T>> {
    const cap = this.opts.caps[provider];
    if (!cap || cap <= 0) throw new Error(`${provider}: no budget configured`);
    const day = dayKey((this.opts.now ?? (() => new Date()))());
    const spent = await this.opts.ledger.spent(provider, day);
    if (spent + estimateUsd > cap) throw new BudgetExceeded(provider, spent, cap);
    const t0 = Date.now();
    let r: { value: T; usage: Usage; model: string };
    try {
      r = await call();
    } catch (err) {
      await this.opts.ledger.add(provider, day, estimateUsd);
      throw err;
    }
    const costUsd = costOf(r.usage, pricing);
    await this.opts.ledger.add(provider, day, costUsd);
    return { ...r, costUsd, provider, latencyMs: Date.now() - t0 };
  }
}
