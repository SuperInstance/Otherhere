import { describe, expect, it } from 'vitest';
import { BUILDING_PACK } from '@otherhere/core';
import { MemoryLedger, ModelRouter } from '../src/router';
import { JevProvider, JevRejected } from '../src/providers/jev';
import { ChatProvider, stripThinking } from '../src/providers/chat';

const router = () =>
  new ModelRouter({ caps: { jev: 1, groq: 1, minimax: 1 }, ledger: new MemoryLedger() });

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

describe('JevProvider', () => {
  it('posts the pack in Jev shape and parses typed answers and usage', async () => {
    const fetch = fakeFetch({
      model: 'jev-1.13.0',
      answers: {
        visible: { type: 'noul', noul: 0.97 },
        roof_shape: { type: 'choice', choice: 'gable', confidence: 1, probabilities: { gable: 1 } },
      },
      usage: { input_tokens: 400_000, output_tokens: 79 },
    });
    const jev = new JevProvider(router(), {
      apiKey: 'k',
      fetch,
      pricing: { inputPerM: 1, outputPerM: 0 },
    });
    const r = await jev.ask(BUILDING_PACK, 'a house');
    expect(r.value.roof_shape).toMatchObject({ choice: 'gable' });
    expect(r.costUsd).toBeCloseTo(0.4, 6);
    expect(fetch.calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    const sent = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(sent).toMatchObject({ model: 'jev-latest', state: 'a house' });
    expect(Object.keys(sent.questions)).toEqual(Object.keys(BUILDING_PACK.questions));
    expect((fetch.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('sends an image as an asset with the danger-zone header', async () => {
    const fetch = fakeFetch({
      model: 'jev',
      answers: { visible: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 900, output_tokens: 5 },
    });
    const jev = new JevProvider(router(), { apiKey: 'k', fetch });
    await jev.askAboutImage(BUILDING_PACK, 'AAAA', 'The building nearest the centre:');
    const init = fetch.calls[0]!.init;
    expect((init.headers as Record<string, string>)['TypeSafe-Danger-Zone-Images']).toBe('true');
    const sent = JSON.parse(init.body as string) as {
      state: string;
      assets: Record<string, { data_base64: string; format: string }>;
    };
    const [placeholder, asset] = Object.entries(sent.assets)[0]!;
    expect(sent.state).toContain(placeholder);
    expect(asset).toMatchObject({ type: 'image', format: 'jpg', data_base64: 'AAAA' });
  });

  it('surfaces API errors', async () => {
    const jev = new JevProvider(router(), {
      apiKey: 'k',
      fetch: fakeFetch({ detail: 'nope' }, 422),
    });
    await expect(jev.ask(BUILDING_PACK, 'x')).rejects.toThrow(/HTTP 422/);
  });

  it('marks an input Jev declines as a rejection, but not auth or rate limits', async () => {
    const declined = new JevProvider(router(), {
      apiKey: 'k',
      fetch: fakeFetch({ detail: 'Invalid image dimensions' }, 400),
    });
    await expect(declined.askAboutImage(BUILDING_PACK, 'AAAA', 'p')).rejects.toBeInstanceOf(
      JevRejected,
    );
    const limited = new JevProvider(router(), { apiKey: 'k', fetch: fakeFetch({}, 429) });
    const err = await limited.ask(BUILDING_PACK, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JevRejected);
  });
});

describe('ChatProvider', () => {
  it('sends an image as a data URL and strips reasoning from the answer', async () => {
    const fetch = fakeFetch({
      model: 'qwen/qwen3.8-27b',
      choices: [{ message: { content: '<think>hmm</think>\nA brick house with a gable roof.' } }],
      usage: { prompt_tokens: 1800, completion_tokens: 20 },
    });
    const groq = new ChatProvider(router(), 'groq', { apiKey: 'k', fetch });
    const r = await groq.describe('AAAA', 'Describe the building');
    expect(r.value).toBe('A brick house with a gable roof.');
    const sent = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(sent.model).toBe('qwen/qwen3.8-27b');
    expect(sent.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
    expect(fetch.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('strips any number of think blocks', () => {
    expect(stripThinking('<think>a</think>x<think>b</think>y')).toBe('xy');
  });
});
