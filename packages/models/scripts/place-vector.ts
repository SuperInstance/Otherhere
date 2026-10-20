// The place-vector measurement round (ADR-0018): LIVE Jev calls, well under $0.01.
// Usage: pnpm --filter @otherhere/models place-vector
//
// What it measures, on the sealed place.v1 battery:
//  - reproducibility: N runs per state, per-question spread, the ±0.10 drift band;
//  - separation: which questions part Zürich from Sitka, and by how much;
//  - honesty: one decoy run on a nonsense state must read near the floor, not 0;
//  - the version canary: model_served recorded per call.
//
// The Zürich state is the seeded dev block (packages/core/test/fixtures/
// overpass-zurich.json), Essence computed exactly as TownDO.essence() does.
// The Sitka state is CONSTRUCTED from the biome + regional priors — there is no
// recorded Sitka OSM fixture in the repo — following ADR-0017's observed mix
// (~70% hemlock, 25% spruce, 5% cedar) and its description of the town: low
// wooden buildings under a coastal rainforest. The baseline says so.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cellAt,
  computeEssence,
  forestBiome,
  osmToFacts,
  placeCensus,
  PLACE_BATTERY,
  PLACE_PACK,
  placeState,
  resolveFacts,
  townCenter,
  townOf,
  type Essence,
  type Fact,
  type FeatureKind,
  type OverpassResponse,
  type PlaceCensus,
  type ResolvedAttrs,
} from '@otherhere/core';
import { JevProvider } from '../src/providers/jev';
import { MemoryLedger, ModelRouter } from '../src/router';
import { askPlaceVectorState, normalizedPlaceVector, type PlaceVector } from '../src/place';

const RUNS = Number(process.env.RUNS ?? 5);
const DECOY_STATE = 'the frobnicated zix quibbles murpl';

/** The key never touches a log line; it is read from env or the workspace file. */
function loadKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_TOKEN;
  if (fromEnv) return fromEnv;
  // The fleet secrets file sits at the workspace root, one level above the repo.
  for (const p of ['../../../.env.local', '../../../../.env.local']) {
    try {
      const line = readFileSync(new URL(p, import.meta.url), 'utf8')
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
type State = {
  id: string;
  state: string;
  provenance: string;
  essence: Essence;
  census: PlaceCensus;
};

function zurichState(): State {
  const fixture = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/overpass-zurich.json', import.meta.url), 'utf8'),
  ) as OverpassResponse & { block: string };
  const { features, facts } = osmToFacts(fixture, {
    block: fixture.block,
    observedAt: '2026-10-17T00:00:00.000Z',
  });
  const resolved = resolveFacts(facts);
  const town = townOf(cellAt(47.3769, 8.5417));
  const centre = townCenter(town) ?? { lat: 0, lng: 0 };
  const stream: TownFeature[] = features.map((f) => ({
    kind: f.kind,
    attrs: resolved.get(f.id) ?? {},
  }));
  const essence = computeEssence(town, stream, { biome: forestBiome(centre.lat, centre.lng) });
  return {
    id: 'zurich-seed-block',
    state: placeState(essence, placeCensus(stream, facts)),
    provenance: `computed from packages/core/test/fixtures/overpass-zurich.json (seed block ${fixture.block}), as TownDO.essence() sees it`,
    essence,
    census: placeCensus(stream, facts),
  };
}

function sitkaState(): State {
  // Constructed from regional priors, honestly: no recorded Sitka fixture exists.
  // Building stock, palette and species mix follow ADR-0017 and the forest spec.
  const osm = (value: unknown, confidence = 0.8) => ({ value, confidence, source: 'osm' as const });
  const features: TownFeature[] = [];
  const heights = [5, 5.5, 6, 6, 6.5, 7, 5, 6, 6.5, 5.5, 7, 6, 5.5, 6];
  const colours = [
    '#f2f0ea',
    '#7a5a43',
    '#e3d5b8',
    '#e3d5b8',
    '#7a5a43',
    '#f2f0ea',
    '#efe4c8',
    '#7a5a43',
    '#f2f0ea',
    '#e3d5b8',
    '#7a5a43',
    '#f2f0ea',
    '#e3d5b8',
    '#7a5a43',
  ];
  for (let i = 0; i < heights.length; i++) {
    features.push({
      kind: 'building',
      attrs: {
        height: osm(heights[i]),
        'roof.shape': osm('gable'),
        colour: osm(colours[i]),
      } as unknown as ResolvedAttrs,
    });
  }
  for (let i = 0; i < 20; i++) {
    const species = i < 14 ? 'hemlock' : i < 19 ? 'spruce' : 'cedar';
    features.push({
      kind: 'tree',
      attrs: { species: osm(species, 0.9) } as unknown as ResolvedAttrs,
    });
  }
  for (let i = 0; i < 30; i++) features.push({ kind: 'road', attrs: {} });
  for (let i = 0; i < 5; i++) features.push({ kind: 'bench', attrs: {} });
  const facts: Fact[] = features.flatMap((f, i) => {
    if (f.kind !== 'building' && f.kind !== 'tree') return [];
    return Object.entries(f.attrs).map(([attribute, r]) => ({
      featureId: `osm:s${i}`,
      attribute,
      value: r.value as Fact['value'],
      source: 'osm' as const,
      confidence: r.confidence,
      observedAt: '2026-10-19T00:00:00.000Z',
      version: 1,
    }));
  });
  const town = townOf(cellAt(57.0531, -135.3351));
  const essence = computeEssence(town, features, { biome: 'pacific-rainforest' });
  const census = placeCensus(features, facts);
  return {
    id: 'sitka-priors',
    state: placeState(essence, census),
    provenance:
      'constructed from the pacific-rainforest biome and ADR-0017 regional priors (low wooden buildings; ~70/25/5 hemlock/spruce/cedar); NOT recorded Sitka OSM data',
    essence,
    census,
  };
}

const round = (v: number, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const spread = (xs: number[]) => round(Math.max(...xs) - Math.min(...xs));

async function main() {
  const key = loadKey();
  const ledger = new MemoryLedger();
  const router = new ModelRouter({ caps: { jev: 0.05 }, ledger });
  const jev = new JevProvider(router, { apiKey: key });
  const states = [zurichState(), sitkaState()];

  const runs: Record<string, PlaceVector[]> = {};
  let calls = 0;
  for (const s of states) {
    runs[s.id] = [];
    for (let i = 0; i < RUNS; i++) {
      runs[s.id]!.push(await askPlaceVectorState(jev, s.state));
      calls++;
    }
  }
  const decoy = await askPlaceVectorState(jev, DECOY_STATE);
  calls++;
  const spent = Number(
    (await ledger.spent('jev', new Date().toISOString().slice(0, 10))).toFixed(6),
  );

  const ids = Object.keys(runs[states[0]!.id]![0]!.vector);
  const zh = runs['zurich-seed-block']!;
  const si = runs['sitka-priors']!;
  const rows = ids.map((id) => {
    const z = zh.map((r) => r.vector[id]!);
    const s = si.map((r) => r.vector[id]!);
    return {
      id,
      zurich: { median: round(median(z)), spread: spread(z) },
      sitka: { median: round(median(s)), spread: spread(s) },
      separation: round(Math.abs(median(z) - median(s))),
      decoy: round(decoy.vector[id]!),
    };
  });
  // The drift band is a probability band: score answers are levels, so their
  // runs are compared on the normalized 0–1 scale (raw spreads are reported too).
  const band = ids.map((id) => {
    const z = zh.map((r) => normalizedPlaceVector(r.vector)[id]!);
    const s = si.map((r) => normalizedPlaceVector(r.vector)[id]!);
    return { id, spread: round(Math.max(spread(z), spread(s))) };
  });
  const models = [...new Set([...zh, ...si].map((r) => r.model_served).concat(decoy.model_served))];
  const bandBreaches = band.filter((b) => b.spread > 0.1).map((b) => `${b.id} (${b.spread})`);
  const decoyNoul = ids.filter((id) => PLACE_PACK.questions[id]!.type === 'noul');
  const decoyNoulMax = round(Math.max(...decoyNoul.map((id) => decoy.vector[id]!)));

  console.log(
    `battery ${PLACE_BATTERY} · ${calls} calls · $${spent} · models served: ${models.join(', ')}\n`,
  );
  console.log('| question | Zürich med (spread) | Sitka med (spread) | separation | decoy |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows)
    console.log(
      `| ${r.id} | ${r.zurich.median} (${r.zurich.spread}) | ${r.sitka.median} (${r.sitka.spread}) | ${r.separation} | ${r.decoy} |`,
    );
  console.log('');
  console.log(
    `drift band (normalized spread ≤ 0.10): ${bandBreaches.length ? 'BREACH on ' + bandBreaches.join(', ') : 'all within'}`,
  );
  console.log(
    `decoy floor: noul max ${decoyNoulMax} (near-floor, not hard 0); score answers ${rows
      .filter((r) => PLACE_PACK.questions[r.id]!.type === 'score')
      .map((r) => `${r.id}=${r.decoy}`)
      .join(', ')}`,
  );

  const baseline = {
    battery: PLACE_BATTERY,
    at: new Date().toISOString(),
    model_requested: 'jev-1.13.0',
    models_served: models,
    runs_per_state: RUNS,
    total_calls: calls,
    total_cost_usd: spent,
    states: Object.fromEntries(
      states.map((s) => [
        s.id,
        {
          state: s.state,
          stateSha: (runs[s.id] ?? [])[0]?.stateSha ?? null,
          provenance: s.provenance,
        },
      ]),
    ),
    decoy: { state: DECOY_STATE, model_served: decoy.model_served, vector: decoy.vector },
    runs,
    table: rows,
    band,
    checks: {
      drift_band_breaches: bandBreaches,
      decoy_noul_max: decoyNoulMax,
      decoy_score: Object.fromEntries(
        rows
          .filter((r) => PLACE_PACK.questions[r.id]!.type === 'score')
          .map((r) => [r.id, r.decoy]),
      ),
    },
  };
  const out = fileURLToPath(new URL('../tuning/place-baseline.json', import.meta.url));
  writeFileSync(out, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nbaseline written: ${out}`);
  if (bandBreaches.length) process.exitCode = 1;
}

await main();
