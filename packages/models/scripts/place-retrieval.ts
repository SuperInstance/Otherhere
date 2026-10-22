// The place-vector retrieval matrix (ADR-0018 → Arc 3's substrate): does the
// vector space put like places together, and which axes carry the separation?
//
// A local research instrument, like place-vector.ts: LIVE Jev calls, ~$0.001 a
// round, output to tuning/ and stdout. Never CI, never runtime.
//
// Usage: pnpm --filter @otherhere/models place-retrieval
//
// What it measures:
//  - retrieval: pairwise cosine over raw and normalized vectors, for the two
//    baseline states (5 runs each) plus three constructed states with known
//    ground-truth affinities, and the decoy floor;
//  - signal-to-noise: within-state cosine spread (run vs run) against the
//    cross-state gaps — the margin retrieval has to work with;
//  - axis contribution: leave-one-question-out on the Zürich–Sitka cosine,
//    raw and normalized — which question IS the separation.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PLACE_PACK,
  computeEssence,
  placeCensus,
  placeState,
  townOf,
  cellAt,
  type Essence,
  type Fact,
  type FeatureKind,
  type PlaceCensus,
  type ResolvedAttrs,
} from '@otherhere/core';
import { askPlaceVectorState, normalizedPlaceVector, type PlaceVector } from '../src/place';
import { JevProvider } from '../src/providers/jev';
import { MemoryLedger, ModelRouter } from '../src/router';
import { readFileSync as readKeyFile } from 'node:fs';

/** The key never touches a log line; it is read from env or the workspace file
 *  (place-vector.ts's loader, kept in step with it). */
function loadKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_TOKEN;
  if (fromEnv) return fromEnv;
  for (const p of ['../../../.env.local', '../../../../.env.local']) {
    try {
      const line = readKeyFile(new URL(p, import.meta.url), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('TYPESAFE_API_KEY='));
      if (line) return line.slice('TYPESAFE_API_KEY='.length).trim();
    } catch {
      // no file there; try the next
    }
  }
  throw new Error('TYPESAFE_API_KEY not found (env or .env.local)');
}

type TownFeature = { kind: FeatureKind; attrs: ResolvedAttrs };

/** A constructed state: features first, Essence and census derived as the
 *  TownDO derives them, provenance saying exactly how it was made. */
function constructed(
  id: string,
  provenance: string,
  biome: Essence['biome'],
  buildings: { height: number; roof: string; colour: string }[],
  trees: string[],
  roads: number,
  benches: number,
): { id: string; state: string; provenance: string } {
  const osm = (value: unknown, confidence = 0.8) => ({
    value,
    confidence,
    source: 'osm' as const,
  });
  const features: TownFeature[] = [];
  for (const b of buildings)
    features.push({
      kind: 'building',
      attrs: {
        height: osm(b.height),
        'roof.shape': osm(b.roof),
        colour: osm(b.colour),
      } as unknown as ResolvedAttrs,
    });
  for (const s of trees)
    features.push({ kind: 'tree', attrs: { species: osm(s, 0.9) } as unknown as ResolvedAttrs });
  for (let i = 0; i < roads; i++) features.push({ kind: 'road', attrs: {} });
  for (let i = 0; i < benches; i++) features.push({ kind: 'bench', attrs: {} });
  const facts: Fact[] = features.flatMap((f, i) => {
    if (f.kind !== 'building' && f.kind !== 'tree') return [];
    return Object.entries(f.attrs).map(([attribute, r]) => ({
      featureId: `osm:r${i}`,
      attribute,
      value: r.value as Fact['value'],
      source: 'osm' as const,
      confidence: r.confidence,
      observedAt: '2026-10-22T00:00:00.000Z',
      version: 1,
    }));
  });
  const town = townOf(cellAt(0, 0));
  const essence = computeEssence(town, features, biome ? { biome } : {});
  const census: PlaceCensus = placeCensus(features, facts);
  return { id, state: placeState(essence, census), provenance };
}

/** Three states with affinities we believe before measuring:
 *  a fishing village should sit near Sitka; a dense city near Zürich; an
 *  alpine resort between, leaning Sitka on conifers and Zürich on order. */
function newStates() {
  const wood = ['#7a5a43', '#e3d5b8', '#f2f0ea'];
  const fishing = constructed(
    'fishing-village',
    'constructed: low wooden sheds and houses, gable roofs, a working waterfront (priors, no recorded OSM)',
    'pacific-rainforest',
    Array.from({ length: 10 }, (_, i) => ({
      height: 4.5 + (i % 3),
      roof: 'gable',
      colour: wood[i % 3]!,
    })),
    Array.from({ length: 12 }, (_, i) => (i < 8 ? 'hemlock' : i < 11 ? 'spruce' : 'cedar')),
    15,
    3,
  );
  const dense = constructed(
    'dense-city',
    'constructed: tall flat-roofed blocks, plaster and concrete, street trees only (priors, no recorded OSM)',
    'temperate',
    Array.from({ length: 12 }, (_, i) => ({
      height: 24 + (i % 4) * 9,
      roof: 'flat',
      colour: ['#cccccc', '#e3d5b8', '#9a9a9a'][i % 3]!,
    })),
    ['broadleaf', 'broadleaf', 'broadleaf'],
    40,
    8,
  );
  const alpine = constructed(
    'alpine-resort',
    'constructed: mid-size chalets, heavy gables, conifers to the door (priors, no recorded OSM)',
    'temperate',
    Array.from({ length: 10 }, (_, i) => ({
      height: 8 + (i % 2) * 3,
      roof: 'gable',
      colour: wood[i % 3]!,
    })),
    Array.from({ length: 15 }, (_, i) => (i < 10 ? 'spruce' : 'hemlock')),
    20,
    4,
  );
  return [fishing, dense, alpine];
}

const round = (v: number, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (const k of Object.keys(a)) {
    dot += a[k]! * (b[k] ?? 0);
    na += a[k]! ** 2;
  }
  for (const k of Object.keys(b)) nb += b[k]! ** 2;
  return dot / Math.sqrt(na * nb);
}

async function main() {
  const key = loadKey();
  const ledger = new MemoryLedger();
  const router = new ModelRouter({ caps: { jev: 0.05 }, ledger });
  const jev = new JevProvider(router, { apiKey: key });

  // The baseline's runs: five per state, already paid for.
  const baseline = JSON.parse(
    readFileSync(new URL('../tuning/place-baseline.json', import.meta.url), 'utf8'),
  ) as {
    runs: Record<string, PlaceVector[]>;
    decoy: { vector: Record<string, number> };
    states: Record<string, { provenance: string }>;
  };
  const vectors: Record<string, Record<string, number>[]> = {};
  for (const [id, runs] of Object.entries(baseline.runs)) vectors[id] = runs.map((r) => r.vector);
  const decoy = baseline.decoy.vector;

  // Three new states, one live call each.
  let calls = 0;
  for (const s of newStates()) {
    const v = await askPlaceVectorState(jev, s.state);
    vectors[s.id] = [v.vector];
    calls++;
    console.error(`${s.id}: $${v.costUsd.toFixed(6)} · served ${v.model_served}`);
  }
  const spent = await ledger.spent('jev', new Date().toISOString().slice(0, 10));

  const ids = Object.keys(vectors);
  const mid = (id: string) =>
    vectors[id]!.reduce(
      (acc, v) => {
        for (const k of Object.keys(v)) acc[k] = (acc[k] ?? 0) + v[k]! / vectors[id]!.length;
        return acc;
      },
      {} as Record<string, number>,
    );
  const mids = Object.fromEntries(ids.map((id) => [id, mid(id)])) as Record<
    string,
    Record<string, number>
  >;
  const nmid = (id: string) => normalizedPlaceVector(mids[id]!);

  // Retrieval: nearest neighbours, raw and normalized, decoy included.
  console.log(`\nretrieval (cosine, ${calls} new calls, $${spent.toFixed(6)})`);
  const neighbours: Record<string, { raw: [string, number][]; normalized: [string, number][] }> =
    {};
  for (const a of ids) {
    const raw = ids
      .filter((b) => b !== a)
      .map((b) => [b, round(cosine(mids[a]!, mids[b]!))] as [string, number])
      .sort((x, y) => y[1] - x[1]);
    const norm = ids
      .filter((b) => b !== a)
      .map((b) => [b, round(cosine(nmid(a), nmid(b)))] as [string, number])
      .sort((x, y) => y[1] - x[1]);
    neighbours[a] = { raw, normalized: norm };
    console.log(`  ${a}`);
    console.log(`    raw:        ${raw.map(([b, c]) => `${b} ${c}`).join('  ')}`);
    console.log(`    normalized: ${norm.map(([b, c]) => `${b} ${c}`).join('  ')}`);
  }
  const decoyN = normalizedPlaceVector(decoy);
  console.log(
    `  decoy:       ${ids.map((b) => `${b} ${round(cosine(decoy, mids[b]!))}`).join('  ')}`,
  );

  // Signal to noise: within-state spread (zurich, sitka have 5 runs) vs the gaps.
  const snr: Record<string, { within: number; gaps: [string, number][] }> = {};
  for (const a of ['zurich-seed-block', 'sitka-priors']) {
    const runs = vectors[a]!;
    let within = 0;
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++)
        within = Math.max(within, 1 - cosine(runs[i]!, runs[j]!));
    const gaps = ids
      .filter((b) => b !== a)
      .map((b) => [b, round(1 - cosine(mids[a]!, mids[b]!))] as [string, number])
      .sort((x, y) => x[1] - y[1]);
    snr[a] = { within: round(within), gaps };
    console.log(
      `  ${a}: within-run cosine distance ≤ ${round(within)}; nearest gap ${gaps[0]![0]} at ${gaps[0]![1]}`,
    );
  }

  // Axis contribution: leave-one-question-out on the Zürich–Sitka cosine.
  const questions = Object.keys(PLACE_PACK.questions);
  const drop = questions
    .map((q) => {
      const dropOne = (v: Record<string, number>) =>
        Object.fromEntries(Object.entries(v).filter(([k]) => k !== q));
      return {
        question: q,
        raw: round(cosine(dropOne(mids['zurich-seed-block']!), dropOne(mids['sitka-priors']!))),
        normalized: round(
          cosine(dropOne(nmid('zurich-seed-block')), dropOne(nmid('sitka-priors'))),
        ),
      };
    })
    .sort((a, b) => a.normalized - b.normalized); // LOWEST cosine = the question whose removal separates most
  const full = {
    raw: round(cosine(mids['zurich-seed-block']!, mids['sitka-priors']!)),
    normalized: round(cosine(nmid('zurich-seed-block'), nmid('sitka-priors'))),
  };
  console.log(`\nZürich–Sitka full cosine: raw ${full.raw}, normalized ${full.normalized}`);
  console.log('  dropping a question that CARRIES similarity raises separation (lower cosine):');
  for (const d of drop.slice(0, 4))
    console.log(`    -${d.question}: raw ${d.raw}, normalized ${d.normalized}`);

  const out = {
    at: new Date().toISOString(),
    new_calls: calls,
    cost_usd: spent,
    states: {
      ...Object.fromEntries(
        Object.entries(baseline.states).map(([k, v]) => [k, { provenance: v.provenance }]),
      ),
      ...Object.fromEntries(newStates().map((s) => [s.id, { provenance: s.provenance }])),
    },
    neighbours,
    decoy: Object.fromEntries(ids.map((b) => [b, round(cosine(decoyN, nmid(b)))])),
    snr,
    zurich_sitka: { full, drop_one: drop },
  };
  const path = fileURLToPath(new URL('../tuning/place-retrieval.json', import.meta.url));
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwritten: ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
