import { describe, expect, it } from '@jest/globals';

import {
  AiServiceError,
  createAiApiUnavailableError,
  createAiEmptyResponseError,
  createAiInvalidResponseFormatError,
  createAiRateLimitError,
  createAiTimeoutError,
  createAiUnknownError,
  createOpenAiHttpError,
  getOpenAiErrorMessage,
  isAiServiceError,
} from '@services/ai/ai.errors.js';

const openAiBody = (message: string) => ({ error: { message, type: 'server_error' } });

describe('AiServiceError', () => {
  it('is an Error that carries its details, readable through getters', () => {
    const cause = new Error('socket hang up');
    const err = new AiServiceError(
      {
        provider: 'openai',
        code: 'AI_API_UNAVAILABLE',
        message: 'down',
        statusCode: 503,
        retryable: true,
      },
      cause,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AiServiceError);
    expect(err).toMatchObject({
      name: 'AiServiceError',
      message: 'down',
      provider: 'openai',
      code: 'AI_API_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
      cause,
    });
  });
});

describe('isAiServiceError', () => {
  it('recognizes only errors of this layer', () => {
    expect(isAiServiceError(createAiUnknownError('openai'))).toBe(true);
    expect(isAiServiceError(new Error('plain'))).toBe(false);
    expect(isAiServiceError({ code: 'AI_TIMEOUT', retryable: true })).toBe(false);
    expect(isAiServiceError(null)).toBe(false);
  });
});

describe('ai error factories', () => {
  it('reports an unavailable provider as retryable, with a default message', () => {
    expect(createAiApiUnavailableError('openai')).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      message: expect.stringMatching(/unavailable/i),
      statusCode: null,
      retryable: true,
    });
  });

  it('keeps a given message, status and cause for an unavailable provider', () => {
    const cause = new TypeError('fetch failed');

    expect(createAiApiUnavailableError('openai', 'no network', 502, cause)).toMatchObject({
      message: 'no network',
      statusCode: 502,
      cause,
    });
  });

  it('reports an empty answer as retryable, the next try may give text', () => {
    expect(createAiEmptyResponseError('openai')).toMatchObject({
      code: 'AI_EMPTY_RESPONSE',
      retryable: true,
    });
  });

  it('reports an answer of an unknown shape as not retryable, it will not change', () => {
    expect(createAiInvalidResponseFormatError('openai')).toMatchObject({
      code: 'AI_INVALID_RESPONSE_FORMAT',
      retryable: false,
    });
  });

  it('reports a timeout as retryable and says after how long it gave up', () => {
    const err = createAiTimeoutError('openai', 12000);

    expect(err).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
    expect(err.message).toContain('12000');
  });

  it('reports a rate limit as retryable, with 429 by default', () => {
    expect(createAiRateLimitError('openai')).toMatchObject({
      code: 'AI_RATE_LIMIT',
      statusCode: 429,
      retryable: true,
    });
  });

  it('wraps an unknown failure and keeps it as the cause', () => {
    const cause = new RangeError('weird');

    expect(createAiUnknownError('openai', cause)).toMatchObject({
      code: 'AI_UNKNOWN_ERROR',
      cause,
    });
  });
});

describe('getOpenAiErrorMessage', () => {
  it('takes the message from the openai error body, without surrounding spaces', () => {
    expect(getOpenAiErrorMessage(openAiBody('  Model overloaded  '))).toBe('Model overloaded');
  });

  it.each([
    ['there is no body', null],
    ['the body has no error', {}],
    ['the message is blank', openAiBody('   ')],
  ])('falls back to a generic message when %s', (_case, body) => {
    expect(getOpenAiErrorMessage(body)).toEqual(expect.stringMatching(/\S/));
  });
});

describe('createOpenAiHttpError', () => {
  it('maps 429 to a retryable rate limit and keeps the body as the cause', () => {
    const body = openAiBody('Rate limit reached');

    expect(createOpenAiHttpError(429, body)).toMatchObject({
      code: 'AI_RATE_LIMIT',
      statusCode: 429,
      retryable: true,
      cause: body,
    });
  });

  it.each([500, 502, 503])('maps %i to a retryable unavailable provider', (status) => {
    expect(createOpenAiHttpError(status, openAiBody('The server had an error'))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      statusCode: status,
      retryable: true,
      message: 'The server had an error',
    });
  });

  it.each([408, 504])('maps %i to a retryable timeout and keeps the http status', (status) => {
    const err = createOpenAiHttpError(status, null);

    expect(err).toMatchObject({ code: 'AI_TIMEOUT', retryable: true, statusCode: status });
    // nobody waited zero milliseconds, the message must not say so
    expect(err.message).not.toMatch(/\b0 ms\b/);
    expect(err.message).toContain(String(status));
  });

  it('takes the timeout message from the openai error body when there is one', () => {
    const body = openAiBody('  Request timed out on the upstream  ');

    expect(createOpenAiHttpError(504, body)).toMatchObject({
      code: 'AI_TIMEOUT',
      statusCode: 504,
      message: 'Request timed out on the upstream',
      cause: body,
    });
  });

  it.each([400, 401, 403, 404])(
    'maps %i to a failure that a retry will not fix and keeps the openai message',
    (status) => {
      expect(createOpenAiHttpError(status, openAiBody('Incorrect API key provided'))).toMatchObject(
        {
          statusCode: status,
          retryable: false,
          message: 'Incorrect API key provided',
        },
      );
    },
  );
});
