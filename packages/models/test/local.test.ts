import { describe, expect, it } from 'vitest';
import { BUILDING_PACK } from '@otherhere/core';
import { ProviderUnavailable } from '../src/router';
import {
  distributionConfidence,
  LOCAL_BASE_URL,
  LocalDecisionProvider,
  normalizeAnswer,
} from '../src/providers/local';

function fakeFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(f, { calls });
}

describe('LocalDecisionProvider', () => {
  it('posts the pack in System One shape and parses typed answers', async () => {
    const fetch = fakeFetch({
      model: 'd1-omni-600M',
      answers: {
        visible: { type: 'noul', noul: 0.97 },
        roof_shape: {
          type: 'choice',
          choice: 'gable',
          confidence: 0.9,
          probabilities: { gable: 0.9 },
        },
      },
      usage: { input_tokens: 210, output_tokens: 0 },
    });
    const local = new LocalDecisionProvider({ baseUrl: 'http://127.0.0.1:8095', fetch });
    const r = await local.ask(BUILDING_PACK, 'a house');
    expect(r.value.visible).toMatchObject({ type: 'noul', noul: 0.97 });
    expect(r.value.roof_shape).toMatchObject({ choice: 'gable' });
    expect(r.costUsd).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
    expect(fetch.calls[0]!.url).toBe('http://127.0.0.1:8095/v1/systemone');
    const sent = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(sent).toMatchObject({ model: 'd1-omni-600M', state: 'a house' });
    expect(Object.keys(sent.questions)).toEqual(Object.keys(BUILDING_PACK.questions));
    // A local model needs no credential.
    expect((fetch.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('defaults to the local endpoint and the flash model', async () => {
    const fetch = fakeFetch({
      model: 'd1-omni-600M',
      answers: { visible: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const local = new LocalDecisionProvider({ fetch });
    await local.ask(BUILDING_PACK, 'a house');
    expect(fetch.calls[0]!.url).toBe(`${LOCAL_BASE_URL}/v1/systemone`);
    expect(JSON.parse(fetch.calls[0]!.init.body as string).model).toBe('d1-omni-600M');
  });

  it('sends an image as a plain data-URL list', async () => {
    const fetch = fakeFetch({
      model: 'd1-omni-600M',
      answers: { visible: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 900, output_tokens: 0 },
    });
    const local = new LocalDecisionProvider({ baseUrl: 'http://127.0.0.1:8095', fetch });
    await local.askAboutImage(BUILDING_PACK, 'AAAA', 'The building nearest the centre:');
    const sent = JSON.parse(fetch.calls[0]!.init.body as string) as {
      state: string;
      images: string[];
    };
    expect(sent.state).toBe('The building nearest the centre:');
    expect(sent.images).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('treats an unreachable local server as an unavailable provider', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const local = new LocalDecisionProvider({ baseUrl: 'http://127.0.0.1:1', fetch });
    await expect(local.ask(BUILDING_PACK, 'a house')).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it('treats a 5xx from the local server as an unavailable provider', async () => {
    const fetch = fakeFetch({ error: 'boom' }, 503);
    const local = new LocalDecisionProvider({ baseUrl: 'http://127.0.0.1:8095', fetch });
    await expect(local.ask(BUILDING_PACK, 'a house')).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});

describe('normalizeAnswer', () => {
  it('keeps a noul as the probability of yes', () => {
    expect(normalizeAnswer({ type: 'noul', noul: 0.42 })).toEqual({ type: 'noul', noul: 0.42 });
  });

  it('derives a missing choice confidence from the distribution', () => {
    const a = normalizeAnswer({
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.8, b: 0.2 },
    });
    expect(a).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.8 });
  });

  it('scores a flat distribution as low confidence', () => {
    const a = normalizeAnswer({
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.5, b: 0.5 },
    });
    expect(a).toMatchObject({ confidence: 0.5 });
  });

  it('derives a missing score confidence from the distribution', () => {
    const a = normalizeAnswer({
      type: 'score',
      score: 1.8,
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.3 },
    });
    expect(a).toMatchObject({ type: 'score', score: 1.8, confidence: 0.4 });
  });

  it('keeps the score legend so the level scale survives parsing', () => {
    const a = normalizeAnswer({
      type: 'score',
      score: 1.2,
      legend: { 0: 'none', 1: 'minor', 2: 'major', 3: 'critical' },
      probabilities: { 0: 0.3, 1: 0.3, 2: 0.3, 3: 0.1 },
    });
    expect(a).toMatchObject({
      type: 'score',
      score: 1.2,
      legend: { 0: 'none', 3: 'critical' },
    });
  });

  it('falls back to the shared parser for an unrecognised shape', () => {
    expect(() => normalizeAnswer({ type: 'nope' })).toThrow();
  });
});

describe('distributionConfidence', () => {
  it('is 0 with no distribution', () => {
    expect(distributionConfidence(undefined)).toBe(0);
    expect(distributionConfidence({})).toBe(0);
  });

  it('normalises the largest share of the distribution', () => {
    expect(distributionConfidence({ a: 3, b: 1 })).toBeCloseTo(0.75, 6);
  });

  it('is 0 for an all-zero distribution', () => {
    expect(distributionConfidence({ a: 0, b: 0 })).toBe(0);
  });
});
