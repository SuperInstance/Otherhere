import { describe, expect, it } from 'vitest';
import {
  ChatCompletionRequest,
  DEFAULT_PACK,
  buildChatCompletion,
  buildError,
  buildChunks,
  buildSystemOneRequest,
  extractImages,
  extractPack,
  isDecisionModel,
  renderAnswers,
  renderContent,
} from '../src/server/openai-adapter';

const user = (text: string) => ({ role: 'user' as const, content: text });

describe('isDecisionModel', () => {
  it('knows the four models and nothing else', () => {
    expect(isDecisionModel('d1-2B')).toBe(true);
    expect(isDecisionModel('clef-flash')).toBe(true);
    expect(isDecisionModel('gpt-4')).toBe(false);
    expect(isDecisionModel('constructor')).toBe(false);
  });
});

describe('extractPack', () => {
  it('finds an inline pack and uses the rest as the state', () => {
    const { pack, state } = extractPack([
      user(
        'A hiker has slipped on a wet boardwalk. {"questions":{"urgent":{"type":"noul","instructions":"Rescue?"}}}',
      ),
    ]);
    expect(Object.keys(pack.questions)).toEqual(['urgent']);
    expect(state).toBe('A hiker has slipped on a wet boardwalk.');
  });

  it('finds a pack in a fenced json block', () => {
    const { pack, state } = extractPack([
      user(
        'Look at this:\n```json\n{"questions":{"severity":{"type":"score","instructions":"How bad?","criteria":["low","high"]}}}\n```\nWhat now?',
      ),
    ]);
    expect(pack.questions['severity']?.['criteria']).toEqual(['low', 'high']);
    expect(state).toContain('What now?');
    expect(state).not.toContain('"questions"');
  });

  it('takes the state from the pack when the pack carries one', () => {
    const { state } = extractPack([
      user('{"state":"the real situation","questions":{"a":{"type":"noul","instructions":"?"}}}'),
    ]);
    expect(state).toBe('the real situation');
  });

  it('does not break on a brace inside a quoted value', () => {
    const { pack } = extractPack([
      user(
        '{"questions":{"a":{"type":"choice","instructions":"a { brace } inside","criteria":{"x":"y"}}}}',
      ),
    ]);
    expect(pack.questions['a']?.['instructions']).toBe('a { brace } inside');
  });

  it('falls back to the built-in pack, with the conversation as the state', () => {
    const { pack, state } = extractPack([user('a hiker has slipped')]);
    expect(pack).toBe(DEFAULT_PACK);
    expect(state).toBe('a hiker has slipped');
  });

  it('takes the LAST user message that has a pack', () => {
    const { pack } = extractPack([
      user('{"questions":{"first":{"type":"noul","instructions":"?"}}}'),
      user('{"questions":{"second":{"type":"noul","instructions":"?"}}}'),
    ]);
    expect(Object.keys(pack.questions)).toEqual(['second']);
  });

  it('ignores JSON that has no questions', () => {
    const { pack } = extractPack([user('{"state":"just some json"}')]);
    expect(pack).toBe(DEFAULT_PACK);
  });
});

describe('extractImages', () => {
  it('collects data URLs from image parts', () => {
    const images = extractImages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ]);
    expect(images).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('ignores remote urls the models cannot read', () => {
    expect(
      extractImages([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }],
        },
      ]),
    ).toEqual([]);
  });
});

describe('buildSystemOneRequest', () => {
  it('carries the state, the questions and the images', () => {
    const request = buildSystemOneRequest('d1-2B', [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '{"questions":{"urgent":{"type":"noul","instructions":"Rescue?"}}}',
          },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ]);
    expect(request.model).toBe('d1-2B');
    expect(request.state).toContain('"questions"');
    expect(request.questions['urgent']?.['type']).toBe('noul');
    expect(request.images).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('leaves the images off when there are none', () => {
    expect(buildSystemOneRequest('d1-2B', [user('hello')]).images).toBeUndefined();
  });
});

describe('renderAnswers', () => {
  it('puts the question text beside the answer', () => {
    const rendered = renderAnswers(
      { urgent: { type: 'noul', noul: 0.98 } },
      { urgent: { type: 'noul', instructions: 'Does this require rescue?' } },
    );
    expect(rendered['urgent']).toEqual({
      question: 'Does this require rescue?',
      answer: { type: 'noul', noul: 0.98 },
    });
  });

  it('renders to json an agent can parse', () => {
    const content = renderContent(
      renderAnswers({ a: { type: 'noul', noul: 1 } }, { a: { instructions: 'q' } }),
    );
    expect(JSON.parse(content)).toEqual({
      a: { question: 'q', answer: { type: 'noul', noul: 1 } },
    });
  });
});

describe('the OpenAI-shaped response', () => {
  it('has no completion tokens, because a decision model emits no text', () => {
    const response = buildChatCompletion('d1-2B', '{}', 245);
    expect(response.choices[0]?.finish_reason).toBe('stop');
    expect(response.choices[0]?.message.role).toBe('assistant');
    expect(response.usage).toEqual({ prompt_tokens: 245, completion_tokens: 0, total_tokens: 245 });
    expect(response.object).toBe('chat.completion');
  });

  it('shapes errors the way an OpenAI client expects', () => {
    const err = buildError('nope', 'bad', 400);
    expect(err.status).toBe(400);
    expect(err.body.error.message).toBe('nope');
  });
});

describe('buildChunks', () => {
  it('streams the way an OpenAI client expects: role, content, finish', () => {
    const chunks = buildChunks('chatcmpl-1', 'd1-2B', '{"a":1}', 1700000000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant' });
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: '{"a":1}' });
    expect(chunks[2]?.choices[0]?.finish_reason).toBe('stop');
    for (const chunk of chunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.id).toBe('chatcmpl-1');
    }
  });
});

describe('ChatCompletionRequest', () => {
  it('accepts the shape a client sends', () => {
    const parsed = ChatCompletionRequest.safeParse({
      model: 'd1-2B',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a request with no messages', () => {
    expect(ChatCompletionRequest.safeParse({ model: 'd1-2B', messages: [] }).success).toBe(false);
  });
});
