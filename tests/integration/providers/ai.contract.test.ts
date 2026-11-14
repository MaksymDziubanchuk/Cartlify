import { afterEach, describe, expect, it } from '@jest/globals';

import { aiProvider, isAiServiceError } from '@providers/ai/index.js';

import { rejectedBy } from '../../helpers/errors.js';
import { aiHarness } from '../../helpers/providers.js';

import type { AiGenerateTextRequestDto } from '@providers/ai/index.js';

// The contract of a provider of the models: what the rest of the app counts on, whoever answers the
// bot, checks the reviews and drafts the translations (src/providers/ai/types.ts). The provider of
// the server goes through these tests, made to answer by its entry in tests/helpers/providers.ts;
// another provider passes them without tests of its own. Against its mock only: a real provider
// would be paid for every request, its real mode has tests of its own.

const harness = aiHarness[aiProvider.name];
const contract = harness.mock ? describe : describe.skip;

const request: AiGenerateTextRequestDto = {
  instructions: 'Answer with one word.',
  messages: [{ role: 'user', content: 'Say yes.' }],
};

const failureOf = async (fn: () => Promise<unknown>) => {
  const err = await rejectedBy(fn);
  expect(isAiServiceError(err)).toBe(true);
  return isAiServiceError(err) ? err.details : null;
};

afterEach(() => {
  harness.reset();
});

contract(`the provider of the models ${aiProvider.name}`, () => {
  it('gives the text the model answered, with its name, the model and the id of the answer', async () => {
    harness.answer('Yes');

    const result = await aiProvider.generateText(request);

    expect(result).toEqual({
      provider: aiProvider.name,
      model: expect.any(String),
      text: 'Yes',
      responseId: expect.anything(),
    });
  });

  it('gives the scores of a text in the categories of its moderation, and whether it flags it', async () => {
    harness.answer('unused', { harassment: 0.97 });

    const result = await aiProvider.moderateText({ text: 'a text to check' });

    expect(result).toMatchObject({
      provider: aiProvider.name,
      model: expect.any(String),
      flagged: expect.any(Boolean),
    });
    expect(result.scores.harassment).toBeGreaterThan(0.9);
  });

  it('tells a limit of the provider as AI_RATE_LIMIT, to be tried again', async () => {
    harness.refuse(429);

    expect(await failureOf(() => aiProvider.generateText(request))).toMatchObject({
      provider: aiProvider.name,
      code: 'AI_RATE_LIMIT',
      retryable: true,
    });
  });

  it('tells a failure of the provider itself as AI_API_UNAVAILABLE, to be tried again', async () => {
    harness.refuse(500);

    expect(await failureOf(() => aiProvider.generateText(request))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      retryable: true,
    });
  });

  it('tells a request it refused as AI_API_UNAVAILABLE, not to be tried again', async () => {
    harness.refuse(400);

    expect(await failureOf(() => aiProvider.generateText(request))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
      retryable: false,
    });
  });

  it('tells no answer at all as AI_API_UNAVAILABLE', async () => {
    harness.refuse('unreachable');

    expect(await failureOf(() => aiProvider.moderateText({ text: 'x' }))).toMatchObject({
      code: 'AI_API_UNAVAILABLE',
    });
  });

  it('says whether it has its key, and asks nobody without it', async () => {
    harness.answer('Yes');
    expect(aiProvider.isConfigured()).toBe(true);

    const details = await harness.withoutKey(async () => {
      expect(aiProvider.isConfigured()).toBe(false);
      return failureOf(() => aiProvider.generateText(request));
    });

    expect(details).toMatchObject({ code: 'AI_API_UNAVAILABLE', statusCode: null });
  });
});
