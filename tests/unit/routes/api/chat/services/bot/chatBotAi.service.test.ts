import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type { AiGenerateTextRequestDto } from '@services/ai/ai.types.js';

import { jsonResponse, stubFetch } from '../../../../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

type ChatBotAi = typeof import('@routes/api/chat/services/bot/chatBotAi.service.js');

const SPECIFIER = '@routes/api/chat/services/bot/chatBotAi.service.js';
const CONFIG = { OPENAI_API_KEY: 'sk-test-chat-bot-key' };

const CUSTOMER_TEXT = 'my card number is 4242 and my address is Main street 1';

const request: AiGenerateTextRequestDto = {
  instructions: 'You are a shop assistant.',
  messages: [{ role: 'user', content: CUSTOMER_TEXT }],
};

const good = () => jsonResponse({ id: 'resp_1', output_text: 'We have lamps.' });
const broken = () => jsonResponse([]);
const empty = () => jsonResponse({ id: 'resp_2', output: [] });

// a logger that records what the service wrote
const fakeLog = () => ({
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

// answers in turn, the last one repeats
const answers = (...list: Array<() => Response>) => {
  let n = 0;
  return stubFetch(() => list[Math.min(n++, list.length - 1)]!());
};

let ai: ChatBotAi;

beforeAll(async () => {
  ai = await importWithEnv<ChatBotAi>(SPECIFIER, CONFIG);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('askAiForBotText', () => {
  it('gives the text of a good answer and writes nothing to the log', async () => {
    const log = fakeLog();
    const calls = answers(good);

    expect(await ai.askAiForBotText(request, log, 'answer')).toBe('We have lamps.');
    expect(calls).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['in a broken format', broken, 'AI_INVALID_RESPONSE_FORMAT'],
    ['without text', empty, 'AI_EMPTY_RESPONSE'],
  ])('asks the same once more after an answer %s', async (_case, first, code) => {
    const log = fakeLog();
    const calls = answers(first, good);

    expect(await ai.askAiForBotText(request, log, 'answer')).toBe('We have lamps.');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({
      purpose: 'answer',
      attempt: 1,
      willRetry: true,
      code,
    });
  });

  it('gives up after the second broken answer, so the caller sends its fallback', async () => {
    const log = fakeLog();
    const calls = answers(broken, empty);

    expect(await ai.askAiForBotText(request, log, 'fixed_text')).toBeNull();
    expect(calls).toHaveLength(2);
    expect(log.warn.mock.calls.map(([meta]) => meta)).toEqual([
      expect.objectContaining({ attempt: 1, willRetry: true, code: 'AI_INVALID_RESPONSE_FORMAT' }),
      expect.objectContaining({ attempt: 2, willRetry: false, code: 'AI_EMPTY_RESPONSE' }),
    ]);
  });

  it.each([
    [
      'a rate limit',
      () => jsonResponse({ error: { message: 'Rate limit reached' } }, 429),
      'AI_RATE_LIMIT',
    ],
    [
      'a server error',
      () => jsonResponse({ error: { message: 'Server error' } }, 500),
      'AI_API_UNAVAILABLE',
    ],
    // the same request is cut at the same limit again: a second paid call for the same piece
    [
      'an answer cut by the output limit',
      () =>
        jsonResponse({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_text: '{"reply":"We ha',
        }),
      'AI_INCOMPLETE_RESPONSE',
    ],
  ])('does not ask again after %s', async (_case, response, code) => {
    const log = fakeLog();
    const calls = answers(response, good);

    expect(await ai.askAiForBotText(request, log, 'answer')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ code, willRetry: false });
  });

  it('does not ask again after a network failure', async () => {
    const log = fakeLog();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));

    expect(await ai.askAiForBotText(request, log, 'answer')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ code: 'AI_API_UNAVAILABLE' });
  });

  it('logs a missing api key and calls nobody', async () => {
    const unconfigured = await importWithEnv<ChatBotAi>(SPECIFIER, { OPENAI_API_KEY: '' });
    const log = fakeLog();
    const calls = answers(good);

    expect(await unconfigured.askAiForBotText(request, log, 'answer')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ code: 'AI_API_UNAVAILABLE' });
  });

  // openai quotes a part of a wrong key in its message, the customer text is personal
  it('writes neither the customer text nor the provider message to the log', async () => {
    const log = fakeLog();
    answers(() =>
      jsonResponse({ error: { message: 'Incorrect API key provided: sk-test-****-key' } }, 401),
    );

    await ai.askAiForBotText(request, log, 'answer');

    const written = JSON.stringify([...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(written).toContain('"statusCode":401');
    expect(written).not.toMatch(/Incorrect|sk-test|4242|Main street/);
  });
});

const reply = (value: unknown) =>
  jsonResponse({ id: 'resp_r', output_text: JSON.stringify(value) });

describe('parseBotReply', () => {
  it.each([
    [{ reply: ' We have lamps. ', escalate: false, reason: 'NONE' }, 'We have lamps.'],
    [
      { reply: 'An admin will help.', escalate: true, reason: 'DIRECT_ADMIN_REQUEST' },
      'An admin will help.',
    ],
  ])('reads a reply that matches the schema', (value, text) => {
    expect(ai.parseBotReply(JSON.stringify(value))).toEqual({ ...value, reply: text });
  });

  it.each([
    ['is not json', 'We have lamps.'],
    ['is a list', '[]'],
    ['has an empty reply', JSON.stringify({ reply: ' ', escalate: false, reason: 'NONE' })],
    ['has an unknown reason', JSON.stringify({ reply: 'x', escalate: true, reason: 'ANGRY' })],
    [
      'has a loop reason, which only the code finds',
      JSON.stringify({ reply: 'x', escalate: true, reason: 'LOOP_DETECTED' }),
    ],
    ['escalates without a reason', JSON.stringify({ reply: 'x', escalate: true, reason: 'NONE' })],
    [
      'gives a reason without escalating',
      JSON.stringify({ reply: 'x', escalate: false, reason: 'HUMAN_REQUIRED' }),
    ],
    [
      'has escalate as a string',
      JSON.stringify({ reply: 'x', escalate: 'true', reason: 'HUMAN_REQUIRED' }),
    ],
  ])('rejects a reply that %s', (_case, text) => {
    expect(ai.parseBotReply(text)).toBeNull();
  });
});

describe('askAiForBotReply', () => {
  it('asks for json of the reply schema and gives the decision of the model', async () => {
    const log = fakeLog();
    const calls = answers(() =>
      reply({ reply: 'An admin will help.', escalate: true, reason: 'HUMAN_REQUIRED' }),
    );

    expect(await ai.askAiForBotReply(request, log)).toEqual({
      reply: 'An admin will help.',
      escalate: true,
      reason: 'HUMAN_REQUIRED',
    });
    expect(JSON.parse(calls[0]!.body).text).toEqual({
      format: {
        type: 'json_schema',
        name: 'chat_bot_reply',
        schema: ai.CHAT_BOT_REPLY_SCHEMA.schema,
        strict: true,
      },
    });
  });

  it('asks the same once more when the json does not match the schema', async () => {
    const log = fakeLog();
    const calls = answers(
      () => reply({ reply: 'x', escalate: true, reason: 'NONE' }),
      () => reply({ reply: 'We have lamps.', escalate: false, reason: 'NONE' }),
    );

    expect((await ai.askAiForBotReply(request, log))?.reply).toBe('We have lamps.');
    expect(calls).toHaveLength(2);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({
      purpose: 'answer',
      attempt: 1,
      willRetry: true,
      code: 'BOT_REPLY_INVALID',
    });
  });

  it('gives up after a second answer that does not match', async () => {
    const log = fakeLog();
    const calls = answers(() => jsonResponse({ output_text: 'plain text, not json' }));

    expect(await ai.askAiForBotReply(request, log)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(log.warn.mock.calls[1]![0]).toMatchObject({ attempt: 2, willRetry: false });
  });
});
