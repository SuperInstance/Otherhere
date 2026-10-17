import { describe, expect, it } from 'vitest';
import { BudgetExceeded, MemoryLedger, ModelRouter, dayKey } from '../src/router';

const now = () => new Date('2026-10-17T12:00:00Z');

describe('ModelRouter (invariant 9)', () => {
  it('records actual spend per provider per UTC day', async () => {
    const ledger = new MemoryLedger();
    const router = new ModelRouter({ caps: { jev: 1 }, ledger, now });
    const r = await router.run('jev', 0.01, { inputPerM: 2, outputPerM: 0 }, async () => ({
      value: 'ok',
      usage: { inputTokens: 500_000, outputTokens: 10 },
      model: 'jev-1',
    }));
    expect(r.costUsd).toBe(1);
    expect(r.provider).toBe('jev');
    expect(await ledger.spent('jev', dayKey(now()))).toBe(1);
  });

  it('refuses a call that could exceed the daily cap, without making it', async () => {
    const ledger = new MemoryLedger();
    await ledger.add('groq', dayKey(now()), 0.95);
    const router = new ModelRouter({ caps: { groq: 1 }, ledger, now });
    let called = false;
    const attempt = router.run('groq', 0.1, { inputPerM: 1, outputPerM: 1 }, async () => {
      called = true;
      return { value: 1, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
    });
    await expect(attempt).rejects.toBeInstanceOf(BudgetExceeded);
    expect(called).toBe(false);
  });

  it('treats providers without a cap as disabled', async () => {
    const router = new ModelRouter({ caps: {}, ledger: new MemoryLedger(), now });
    await expect(
      router.run('claude', 0, { inputPerM: 1, outputPerM: 1 }, async () => ({
        value: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'm',
      })),
    ).rejects.toThrow(/no budget/);
  });

  it('resets each UTC day', async () => {
    const ledger = new MemoryLedger();
    await ledger.add('jev', '2026-10-16', 100);
    const router = new ModelRouter({ caps: { jev: 1 }, ledger, now });
    await expect(
      router.run('jev', 0.5, { inputPerM: 0, outputPerM: 0 }, async () => ({
        value: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'm',
      })),
    ).resolves.toBeTruthy();
  });

  it('still records spend when the call fails after starting', async () => {
    const ledger = new MemoryLedger();
    const router = new ModelRouter({ caps: { jev: 1 }, ledger, now });
    await expect(
      router.run('jev', 0.2, { inputPerM: 1, outputPerM: 1 }, async () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    // A failed call is charged its estimate: providers may bill partial work.
    expect(await ledger.spent('jev', dayKey(now()))).toBe(0.2);
  });
});
