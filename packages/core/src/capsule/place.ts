import { resolveFacts } from '../facts/resolve';
import { Capsule } from '../schema/capsule';
import type { GeneratorRef } from '../schema/bundle';
import type { Fact } from '../schema/fact';
import type { Feature } from '../schema/feature';
import type { Scope } from '../schema/scope';
import type { BundleFeature } from '../bundle/build';
import type { Essence } from '../schema/world';
import { townOf } from '../geo/h3';

export type PlaceCapsuleInput = {
  id: string;
  title: string;
  scope: Scope;
  createdAt: string;
  cells: string[];
  center: { lat: number; lng: number };
  pose?: [number, number, number, number, number];
  features: Feature[];
  facts: Fact[];
  generators: GeneratorRef[];
  essences?: Record<string, Essence>;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A place postcard (ADR-0008): a snapshot of every Fact about the Features
 * anchored in its Cells, plus the generator versions that drew them. Bundles
 * are rebuilt from it, so it never ships meshes. Every place is also an arena.
 */
export function makePlaceCapsule(input: PlaceCapsuleInput): Capsule {
  const cells = [...new Set(input.cells)];
  const inCells = new Set(cells);
  const features = input.features
    .filter((f) => inCells.has(f.anchorCell))
    .sort((a, b) => cmp(a.id, b.id));
  const ids = new Set(features.map((f) => f.id));
  const facts = input.facts
    .filter((f) => ids.has(f.featureId))
    .sort(
      (a, b) =>
        cmp(a.featureId, b.featureId) || cmp(a.attribute, b.attribute) || cmp(a.source, b.source),
    );
  return Capsule.parse({
    format: 'otherhere.capsule',
    formatVersion: 1,
    id: input.id,
    kind: 'place',
    title: input.title,
    scope: input.scope,
    createdAt: input.createdAt,
    cells,
    view: { center: input.center, ...(input.pose ? { pose: input.pose } : {}) },
    snapshot: {
      features,
      facts,
      generators: input.generators,
      ...(input.essences ? { essences: input.essences } : {}),
    },
    // A place postcard holds map Facts only: no imagery, so nothing to blur.
    // Captures (M2) must be blurred by the agent before they can be attached.
    privacy: { blurred: true },
    ownerIsKid: false,
  });
}

export type CapsuleCellInput = { features: BundleFeature[]; essence?: Essence };

/** Per-Cell Bundle inputs, resolved from the snapshot exactly as the TownDO resolves live Facts. */
export function capsuleBundleInputs(c: Capsule): Map<string, CapsuleCellInput> {
  const resolved = resolveFacts(c.snapshot.facts);
  const out = new Map<string, CapsuleCellInput>(
    c.cells.map((cell) => {
      const essence = c.snapshot.essences?.[townOf(cell)];
      return [cell, essence ? { features: [], essence } : { features: [] }];
    }),
  );
  for (const f of c.snapshot.features) {
    out
      .get(f.anchorCell)
      ?.features.push({ id: f.id, kind: f.kind, attrs: resolved.get(f.id) ?? {} });
  }
  return out;
}

/** True if this build draws the Capsule with the same generators it was saved with. */
export function generatorsMatch(c: Capsule, current: GeneratorRef[]): boolean {
  const key = (g: GeneratorRef) => `${g.id}@${g.version}#${g.hash}`;
  const a = new Set(c.snapshot.generators.map(key));
  return current.length === a.size && current.every((g) => a.has(key(g)));
}
