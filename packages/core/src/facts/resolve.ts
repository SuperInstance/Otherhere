import { sourceRank, type Fact, type Source } from '../schema/fact';

export type Resolved = { value: unknown; confidence: number; source: Source };
/** Resolved values for one Feature, by attribute. */
export type ResolvedAttrs = Record<string, Resolved>;

/** True if `a` should win over `b` (ADR-0004): rank, confidence, time, version. */
export function outranks(a: Fact, b: Fact): boolean {
  const r = sourceRank(a.source) - sourceRank(b.source);
  if (r !== 0) return r > 0;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  return a.version > b.version;
}

/** Resolve Facts into one winning value per (Feature, attribute). */
export function resolveFacts(facts: Iterable<Fact>): Map<string, ResolvedAttrs> {
  const winners = new Map<string, Map<string, Fact>>();
  for (const f of facts) {
    let byAttr = winners.get(f.featureId);
    if (!byAttr) winners.set(f.featureId, (byAttr = new Map()));
    const cur = byAttr.get(f.attribute);
    if (!cur || outranks(f, cur)) byAttr.set(f.attribute, f);
  }
  const out = new Map<string, ResolvedAttrs>();
  for (const [id, byAttr] of winners) {
    const attrs: ResolvedAttrs = {};
    for (const [attr, f] of byAttr) {
      attrs[attr] = { value: f.value, confidence: f.confidence, source: f.source };
    }
    out.set(id, attrs);
  }
  return out;
}
