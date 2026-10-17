import { GeneratorDef } from '../schema/generator';
import type { FeatureKind } from '../schema/feature';
import type { GeneratorRef } from '../schema/bundle';
import { canonicalJson } from '../hash/canonical';
import { sha256Hex } from '../hash/sha256';
import building from './building.basic.json';
import road from './road.basic.json';
import tree from './prop.tree.json';
import bench from './prop.bench.json';
import streetlight from './prop.streetlight.json';

/** The generators shipped with this build, validated at load. */
export const BUILTIN_GENERATORS: readonly GeneratorDef[] = [
  building,
  road,
  tree,
  bench,
  streetlight,
].map((g) => GeneratorDef.parse(g));

export type GeneratorSet = {
  defs: readonly GeneratorDef[];
  forKind(kind: FeatureKind): GeneratorDef | undefined;
  refs(): Promise<GeneratorRef[]>;
};

export function generatorSet(defs: readonly GeneratorDef[] = BUILTIN_GENERATORS): GeneratorSet {
  const sorted = [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let refs: Promise<GeneratorRef[]> | null = null;
  return {
    defs: sorted,
    forKind: (kind) => sorted.find((g) => g.appliesTo.includes(kind)),
    refs: () =>
      (refs ??= Promise.all(
        sorted.map(async (g) => ({
          id: g.id,
          version: g.version,
          hash: await sha256Hex(canonicalJson(g)),
        })),
      )),
  };
}
