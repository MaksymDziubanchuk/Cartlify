import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type { AiGenerateTextRequestDto } from '@services/ai/ai.types.js';

import { rejectedBy } from '../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../helpers/freshImport.js';

type AiClient = typeof import('@services/ai/aiClient.service.js');

const SPECIFIER = '@services/ai/aiClient.service.js';

// synthetic settings, the module reads them at import; empty ones fall back to defaults
const CONFIG = {
  OPENAI_API_KEY: 'sk-test-openai-key',
  OPENAI_MODEL: '',
  OPENAI_TIMEOUT_MS: '',
  OPENAI_MAX_OUTPUT_TOKENS: '',
};

const request: AiGenerateTextRequestDto = {
  instructions: 'You are a shop assistant.',
  messages: [
    { role: 'developer', content: 'Products: mug' },
    { role: 'user', content: 'Any mugs?' },
  ],
};

const answer = (text: string) =>
  jsonResponse({
    id: 'resp_1',
    model: 'gpt-4.1-mini-2025-04-14',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });

const sentBody = (body: string) => JSON.parse(body) as Record<string, unknown>;

// an abort the way fetch reports it, made in this realm so instanceof checks see an Error
const abortError = () =>
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

// a fetch that never answers and gives up when the request is aborted
const hangingFetch = () =>
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      }),
  );

let ai: AiClient;

beforeAll(async () => {
  ai = await importWithEnv<AiClient>(SPECIFIER, CONFIG);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('generateText', () => {
  it('fails without an api key and calls nobody', async () => {
    const unconfigured = await importWithEnv<AiClient>(SPECIFIER, {
      ...CONFIG,
      OPENAI_API_KEY: ' ',
    });
    const calls = stubFetch(() => answer('hi'));

    expect(await rejectedBy(() => unconfigured.generateText(request))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      provider: 'openai',
    });
    expect(calls).toHaveLength(0);
  });

  it('posts the instructions and messages to the responses api with our key', async () => {
    const calls = stubFetch(() => answer('We have mugs.'));

    await ai.generateText(request);

    expect(calls[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
    });
    expect(sentBody(calls[0]!.body)).toEqual({
      model: 'gpt-4.1-mini',
      instructions: request.instructions,
      input: request.messages,
      max_output_tokens: 450,
      store: false,
    });
  });

  // the responses api keeps every request and answer in the openai account unless told not to;
  // the chat carries names, addresses and phones, and the bot sends the whole history each time
  it('asks openai not to store the conversation', async () => {
    const calls = stubFetch(() => answer('ok'));

    await ai.generateText(request);

    expect(sentBody(calls[0]!.body).store).toBe(false);
  });

  it('sends only the role and the text of each message', async () => {
    const calls = stubFetch(() => answer('ok'));
    const withExtra = {
      ...request,
      messages: [{ role: 'user', content: 'hi', createdAt: '2026-01-01' } as never],
    };

    await ai.generateText(withExtra);

    expect(sentBody(calls[0]!.body).input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('takes the model and the output limit from the settings', async () => {
    const configured = await importWithEnv<AiClient>(SPECIFIER, {
      ...CONFIG,
      OPENAI_MODEL: 'gpt-settings-model',
      OPENAI_MAX_OUTPUT_TOKENS: '200',
    });
    const calls = stubFetch(() => answer('ok'));

    await configured.generateText(request);

    expect(sentBody(calls[0]!.body)).toMatchObject({
      model: 'gpt-settings-model',
      max_output_tokens: 200,
    });
  });

  it('lets one request choose its own model and output limit', async () => {
    const calls = stubFetch(() => answer('ok'));

    await ai.generateText({
      ...request,
      options: { model: ' gpt-request-model ', maxOutputTokens: 99 },
    });

    expect(sentBody(calls[0]!.body)).toMatchObject({
      model: 'gpt-request-model',
      max_output_tokens: 99,
    });
  });

  it.each([0, -5, 1.5])(
    'ignores an output limit of %p and uses the default',
    async (maxOutputTokens) => {
      const calls = stubFetch(() => answer('ok'));

      await ai.generateText({ ...request, options: { maxOutputTokens } });

      expect(sentBody(calls[0]!.body).max_output_tokens).toBe(450);
    },
  );

  it('falls back to the default limit when the setting is not a number', async () => {
    const configured = await importWithEnv<AiClient>(SPECIFIER, {
      ...CONFIG,
      OPENAI_MAX_OUTPUT_TOKENS: 'many',
    });
    const calls = stubFetch(() => answer('ok'));

    await configured.generateText(request);

    expect(sentBody(calls[0]!.body).max_output_tokens).toBe(450);
  });

  describe('answer', () => {
    it('gives the text with the model and the response id, nothing of the raw body', async () => {
      stubFetch(() => answer('  We have mugs.  '));

      expect(await ai.generateText(request)).toEqual({
        provider: 'openai',
        model: 'gpt-4.1-mini-2025-04-14',
        text: 'We have mugs.',
        responseId: 'resp_1',
      });
    });

    it('prefers output_text when the body has it', async () => {
      stubFetch(() =>
        jsonResponse({ output_text: ' short ', output: [{ content: [{ text: 'long' }] }] }),
      );

      expect((await ai.generateText(request)).text).toBe('short');
    });

    it('joins the text parts of every output item and skips empty ones', async () => {
      stubFetch(() =>
        jsonResponse({
          output: [
            { type: 'reasoning', content: [] },
            { type: 'message', content: [{ text: 'First.' }, { text: '  ' }, { text: 'Second.' }] },
            { type: 'message' },
          ],
        }),
      );

      expect((await ai.generateText(request)).text).toBe('First.\nSecond.');
    });

    it('names the model it asked for and no response id when the body has neither', async () => {
      stubFetch(() => jsonResponse({ output_text: 'ok' }));

      expect(await ai.generateText(request)).toMatchObject({
        model: 'gpt-4.1-mini',
        responseId: null,
      });
    });

    it('fails on an answer without text', async () => {
      stubFetch(() => jsonResponse({ id: 'resp_2', output: [] }));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_EMPTY_RESPONSE',
        retryable: true,
      });
    });

    // the text of an answer cut by the output limit is a piece: json of a structured answer
    // breaks off, and asking the same again gets the same piece
    it.each(['max_output_tokens', 'content_filter'])(
      'fails on an answer openai cut short (%s) and never gives its piece of text',
      async (reason) => {
        stubFetch(() =>
          jsonResponse({
            id: 'resp_3',
            status: 'incomplete',
            incomplete_details: { reason },
            output: [
              { type: 'message', content: [{ type: 'output_text', text: '{"reply":"We ha' }] },
            ],
          }),
        );

        expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
          code: 'AI_INCOMPLETE_RESPONSE',
          retryable: false,
          message: `AI provider cut the answer short: ${reason}.`,
        });
      },
    );

    it('takes an answer openai marks completed', async () => {
      stubFetch(() => jsonResponse({ id: 'resp_4', status: 'completed', output_text: 'ok' }));

      expect((await ai.generateText(request)).text).toBe('ok');
    });

    it('reports an answer whose status is not a string as an invalid format', async () => {
      stubFetch(() => jsonResponse({ id: 'resp_5', status: 1, output_text: 'ok' }));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_INVALID_RESPONSE_FORMAT',
      });
    });

    it.each([
      ['is not json', () => textResponse('<html>gateway</html>')],
      ['is json null', () => jsonResponse(null)],
      ['has an id that is not a string', () => jsonResponse({ id: 7, output_text: 'ok' })],
      ['has a text that is not a string', () => jsonResponse({ output_text: 5 })],
      ['has an output that is not a list', () => jsonResponse({ output: 'text' })],
      ['is a list, not an object', () => jsonResponse([])],
      ['has an output item that is not an object', () => jsonResponse({ output: [null] })],
      ['has an output item that is a list', () => jsonResponse({ output: [[]] })],
      ['has a content that is not a list', () => jsonResponse({ output: [{ content: 'hi' }] })],
      [
        'has a content part that is not an object',
        () => jsonResponse({ output: [{ content: [5] }] }),
      ],
      [
        'has a content text that is not a string',
        () => jsonResponse({ output: [{ content: [{ text: 5 }] }] }),
      ],
    ])('reports an answer that %s as an invalid format', async (_case, response) => {
      stubFetch(response);

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_INVALID_RESPONSE_FORMAT',
        retryable: false,
      });
    });
  });

  describe('failures', () => {
    it('reports a rate limit', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Rate limit reached' } }, 429));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_RATE_LIMIT',
        statusCode: 429,
      });
    });

    it('keeps the words of an openai server error', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'The server had an error' } }, 500));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_API_UNAVAILABLE',
        statusCode: 500,
        message: 'The server had an error',
        retryable: true,
      });
    });

    it('gives a general message when the error body is not json', async () => {
      stubFetch(() => textResponse('Bad Gateway', 502));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        statusCode: 502,
        message: 'OpenAI API request failed.',
      });
    });

    it.each([
      ['json null', null],
      ['a json string', 'overloaded'],
      ['an error that is a string', { error: 'overloaded' }],
      ['an error message that is not a string', { error: { message: 5 } }],
    ])('gives a general message and no body when the error body is %s', async (_case, body) => {
      stubFetch(() => jsonResponse(body, 503));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        statusCode: 503,
        message: 'OpenAI API request failed.',
        cause: null,
      });
    });

    it('keeps an error body without an error field and gives a general message', async () => {
      stubFetch(() => jsonResponse({}, 500));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        message: 'OpenAI API request failed.',
        cause: {},
      });
    });

    it('does not retry a request openai refused as wrong', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Invalid model' } }, 400));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        statusCode: 400,
        retryable: false,
      });
    });

    it('reports a network failure as unavailable', async () => {
      const failure = new TypeError('fetch failed');
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_API_UNAVAILABLE',
        statusCode: null,
        cause: failure,
      });
    });

    it('reports anything else as unknown', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new RangeError('odd'));

      expect(await rejectedBy(() => ai.generateText(request))).toMatchObject({
        code: 'AI_UNKNOWN_ERROR',
      });
    });
  });

  describe('timeout', () => {
    it('gives up after 12 seconds by default', async () => {
      jest.useFakeTimers();
      hangingFetch();

      let settled = false;
      const pending = ai.generateText(request).finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);

      await jest.advanceTimersByTimeAsync(11_999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(await rejectedBy(() => pending)).toMatchObject({
        code: 'AI_TIMEOUT',
        message: 'AI provider request timed out after 12000 ms.',
        retryable: true,
      });
    });

    it('waits as long as one request asks', async () => {
      jest.useFakeTimers();
      hangingFetch();

      const pending = ai.generateText({ ...request, options: { timeoutMs: 500 } });
      pending.catch(() => undefined);

      await jest.advanceTimersByTimeAsync(500);
      expect(await rejectedBy(() => pending)).toMatchObject({ code: 'AI_TIMEOUT' });
    });

    // the headers came in time, the body did not: the same timeout, not a broken answer that
    // the bot would ask once more
    it('reports a timeout while the answer is read as a timeout', async () => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(abortError()));
          },
        });

        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const pending = ai.generateText({ ...request, options: { timeoutMs: 500 } });
      pending.catch(() => undefined);

      await jest.advanceTimersByTimeAsync(500);
      expect(await rejectedBy(() => pending)).toMatchObject({
        code: 'AI_TIMEOUT',
        message: 'AI provider request timed out after 500 ms.',
      });
    });

    it('leaves no timer behind after an answer', async () => {
      jest.useFakeTimers();
      stubFetch(() => answer('ok'));

      await ai.generateText(request);

      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe('temperature', () => {
  it('lets one request ask for a temperature, openai picks its own without it', async () => {
    const calls = stubFetch(() => answer('ok'));

    await ai.generateText({ ...request, options: { temperature: 0 } });
    await ai.generateText(request);

    expect(sentBody(calls[0]!.body).temperature).toBe(0);
    expect(sentBody(calls[1]!.body)).not.toHaveProperty('temperature');
  });
});

describe('structured output', () => {
  const schema = {
    name: 'answer',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  };

  it('asks for json of the given schema', async () => {
    const calls = stubFetch(() => jsonResponse({ output_text: '{"ok":true}' }));

    expect((await ai.generateText({ ...request, options: { jsonSchema: schema } })).text).toBe(
      '{"ok":true}',
    );
    expect(sentBody(calls[0]!.body).text).toEqual({
      format: { type: 'json_schema', name: 'answer', schema: schema.schema, strict: true },
    });
  });

  it('asks for plain text without a schema', async () => {
    const calls = stubFetch(() => answer('ok'));

    await ai.generateText(request);

    expect(sentBody(calls[0]!.body)).not.toHaveProperty('text');
  });
});

// the moderation of openai scores a text in its categories (harassment, hate, violence and the
// others), free of charge; the check of the comments of reviews takes its scores
describe('moderateText', () => {
  const MODERATIONS = 'https://api.openai.com/v1/moderations';

  const scored = (scores: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    jsonResponse({
      id: 'modr-1',
      model: 'omni-moderation-latest',
      results: [{ flagged: false, categories: {}, category_scores: scores, ...extra }],
    });

  it('fails without an api key and calls nobody', async () => {
    const unconfigured = await importWithEnv<AiClient>(SPECIFIER, {
      ...CONFIG,
      OPENAI_API_KEY: '',
    });
    const calls = stubFetch(() => scored({}));

    expect(await rejectedBy(() => unconfigured.moderateText({ text: 'hi' }))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      provider: 'openai',
    });
    expect(calls).toHaveLength(0);
  });

  it('posts the text to the moderation api of openai with its model and our key', async () => {
    const calls = stubFetch(() => scored({ hate: 0.1 }));

    await ai.moderateText({ text: 'The lamp broke in a week.' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: MODERATIONS,
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-openai-key', 'content-type': 'application/json' },
    });
    expect(sentBody(calls[0]!.body)).toEqual({
      model: 'omni-moderation-latest',
      input: 'The lamp broke in a week.',
    });
  });

  it('gives the scores of the categories, whether openai flagged the text, and the model', async () => {
    stubFetch(() => scored({ hate: 0.91, violence: 0.02 }, { flagged: true }));

    expect(await ai.moderateText({ text: 'x' })).toEqual({
      provider: 'openai',
      model: 'omni-moderation-latest',
      flagged: true,
      scores: { hate: 0.91, violence: 0.02 },
    });
  });

  it.each([
    ['has no results', () => jsonResponse({ id: 'modr-1', results: [] })],
    ['has no scores', () => jsonResponse({ results: [{ flagged: false }] })],
    ['has a score that is not a number', () => scored({ hate: 'high' })],
    ['has a flag that is not a boolean', () => scored({}, { flagged: 'no' })],
    ['is not json', () => textResponse('<html>', 200)],
  ])('reports an answer that %s as an invalid format', async (_case, response) => {
    stubFetch(response);

    expect(await rejectedBy(() => ai.moderateText({ text: 'x' }))).toMatchObject({
      code: 'AI_INVALID_RESPONSE_FORMAT',
    });
  });

  it('reports the failures of openai the way the model does', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'Rate limit reached' } }, 429));
    expect(await rejectedBy(() => ai.moderateText({ text: 'x' }))).toMatchObject({
      code: 'AI_RATE_LIMIT',
      statusCode: 429,
    });

    jest.restoreAllMocks();
    stubFetch(() => jsonResponse({ error: { message: 'The server had an error' } }, 500));
    expect(await rejectedBy(() => ai.moderateText({ text: 'x' }))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      statusCode: 500,
    });
  });

  it('waits as long as the request asks, then gives up as a timeout', async () => {
    jest.useFakeTimers();
    hangingFetch();

    let settled = false;
    const pending = ai.moderateText({ text: 'x', options: { timeoutMs: 500 } }).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await rejectedBy(() => pending)).toMatchObject({ code: 'AI_TIMEOUT' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
