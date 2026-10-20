import { describe, expect, it } from 'vitest';
import {
  PLACE_BATTERY,
  PLACE_PACK,
  placeState,
  sha256Hex,
  type Answers,
  type Essence,
  type PlaceCensus,
} from '@otherhere/core';
import { MemoryLedger, ModelRouter } from '../src/router';
import { JevProvider } from '../src/providers/jev';
import {
  askPlaceVector,
  askPlaceVectorState,
  normalizedPlaceVector,
  placeVectorFrom,
} from '../src/place';

const router = () => new ModelRouter({ caps: { jev: 1 }, ledger: new MemoryLedger() });

function fakeFetch(response: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(f, { calls });
}

/** Canned answers in the battery's shapes: the sealed round's Zürich medians. */
const ZURICH: Answers = {
  tall_for_a_town: { type: 'noul', noul: 0.23 },
  steep_roofs: { type: 'noul', noul: 0.17 },
  uniform_roofs: { type: 'noul', noul: 0.04 },
  dense_not_spread: { type: 'noul', noul: 0.59 },
  warm_earthy_walls: { type: 'noul', noul: 0.71 },
  mostly_conifers: { type: 'noul', noul: 0.02 },
  rainy_coast: { type: 'noul', noul: 0.06 },
  heights_recorded: { type: 'noul', noul: 0.27 },
  height_scale: { type: 'score', score: 4.27, confidence: 0.9 },
  known_in_detail: { type: 'score', score: 1.54, confidence: 0.9 },
  green_setting: { type: 'score', score: 1.41, confidence: 0.9 },
};

const essence = (over: Partial<Essence> = {}): Essence => ({
  town: 't',
  palette: [],
  roofShapes: {},
  heightM: { median: 0, p90: 0 },
  propFamilies: {},
  sampleCount: 0,
  ...over,
});
const census = (over: Partial<PlaceCensus> = {}): PlaceCensus => ({
  featuresByKind: {},
  known: { height: 0, roof: 0, colour: 0 },
  knownSpecies: 0,
  factsBySource: {},
  ...over,
});

describe('placeVectorFrom', () => {
  it('extracts noul probabilities and score levels, one entry per question', () => {
    const v = placeVectorFrom(ZURICH);
    expect(Object.keys(v).sort()).toEqual(Object.keys(PLACE_PACK.questions).sort());
    expect(v).toMatchObject({ steep_roofs: 0.17, height_scale: 4.27 });
  });

  it('refuses an incomplete or wrongly-shaped answer set', () => {
    const partial = { ...ZURICH };
    delete partial.rainy_coast;
    expect(() => placeVectorFrom(partial)).toThrow(/no answer for rainy_coast/);
    expect(() =>
      placeVectorFrom({ ...ZURICH, steep_roofs: { type: 'choice', choice: 'x', confidence: 1 } }),
    ).toThrow(/steep_roofs answered choice, expected noul/);
  });
});

describe('normalizedPlaceVector', () => {
  it('maps scores onto 0–1 by their rubric width and leaves noul alone', () => {
    const n = normalizedPlaceVector(placeVectorFrom(ZURICH));
    expect(n.steep_roofs).toBe(0.17);
    expect(n.height_scale).toBeCloseTo((4.27 - 1) / 9, 6); // 10 levels
    expect(n.known_in_detail).toBeCloseTo((1.54 - 1) / 4, 6); // 5 levels
  });
});

describe('askPlaceVector', () => {
  const e = essence({
    sampleCount: 100,
    heightM: { median: 13.5, p90: 19.5 },
    roofShapes: { flat: 0.45, gable: 0.15, hip: 0.35, shed: 0.05 },
    palette: ['#e3d5b8', '#ff9e6b'],
    biome: 'temperate',
  });
  const c = census({
    featuresByKind: { building: 500, tree: 250 },
    known: { height: 0.3, roof: 0.05, colour: 0 },
    factsBySource: { osm: 10000 },
  });

  it('asks the sealed battery over the deterministic state, and receipts it', async () => {
    const fetch = fakeFetch({
      model: 'jev-1.13.0',
      answers: ZURICH,
      usage: { input_tokens: 1500, output_tokens: 90 },
    });
    const v = await askPlaceVector(
      new JevProvider(router(), { apiKey: 'k', fetch, pricing: { inputPerM: 1, outputPerM: 0 } }),
      e,
      c,
    );
    expect(v).toMatchObject({ battery: PLACE_BATTERY, model_served: 'jev-1.13.0' });
    expect(v.vector).toEqual(placeVectorFrom(ZURICH));
    expect(v.stateSha).toBe(await sha256Hex(placeState(e, c)));
    expect(v.costUsd).toBeCloseTo(1500 / 1e6, 9);
    const sent = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(sent.model).toBe('jev-1.13.0');
    expect(sent.state).toBe(placeState(e, c));
    expect(Object.keys(sent.questions)).toEqual(Object.keys(PLACE_PACK.questions));
  });

  it('is the same ask as askPlaceVectorState over the serialized state', async () => {
    const state = placeState(e, c);
    const fetch = fakeFetch({
      model: 'jev-1.13.0',
      answers: ZURICH,
      usage: { input_tokens: 1500, output_tokens: 90 },
    });
    const v = await askPlaceVectorState(
      new JevProvider(router(), { apiKey: 'k', fetch, pricing: { inputPerM: 1, outputPerM: 0 } }),
      state,
    );
    expect(v.stateSha).toBe(await sha256Hex(state));
    expect(JSON.parse(fetch.calls[0]!.init.body as string).state).toBe(state);
  });
});
