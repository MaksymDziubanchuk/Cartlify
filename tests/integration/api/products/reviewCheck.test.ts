import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createReview,
  createUser,
  deleteProductFromCatalog,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { jsonResponse } from '../../../helpers/fetchStub.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  answerAsModel,
  realOpenAi,
  stopModel,
  useModel,
  type ModelAnswer,
  type ModelCall,
  type ModerationAnswer,
  type ModerationCall,
} from '../../../helpers/openai.js';

// the comment of a review is checked before anything is written, by two checks at once: the model
// by the rules of the shop (obscene words in any form, insults, dangerous calls, a text about
// another thing, ads, personal data; an opinion, however negative, is never a reason) and the
// moderation of openai, which refuses the dangerous kinds alone from a high score. A refused
// comment is answered with the reasons and nothing is written; a check that fails lets the
// comment through, and with no key of openai nobody is asked

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

const writeReview = (user: TestUser, productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/reviews`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const reviewsOf = (productId: number) =>
  asAdmin((tx) =>
    tx.review.findMany({ where: { productId }, select: { rating: true, comment: true } }),
  );

// the model and the moderation of the test, recording what the app asked
function checks(
  model: (call: ModelCall) => ModelAnswer = () => ({ reasons: [] }),
  moderation: (call: ModerationCall) => ModerationAnswer = () => ({}),
) {
  const moderated: ModerationCall[] = [];
  const asked = answerAsModel(model, (call) => {
    moderated.push(call);
    return moderation(call);
  });

  return { asked, moderated };
}

const failure = (status: number) =>
  jsonResponse({ error: { message: 'The server had an error' } }, status);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(stopModel);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('the check of the comment of a review', () => {
  it('publishes a comment both checks let through, asking each once', async () => {
    const product = await createProduct();
    const { asked, moderated } = checks();

    const res = await writeReview(await newUser(), product.id, {
      rating: 1,
      comment: 'Awful lamp, broke in two days, a waste of money',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      rating: 1,
      comment: 'Awful lamp, broke in two days, a waste of money',
    });
    expect(asked.map((call) => call.purpose)).toEqual(['review_check']);
    expect(asked[0]!.customerText).toBe('Awful lamp, broke in two days, a waste of money');
    expect(moderated).toEqual([
      {
        model: 'omni-moderation-latest',
        text: 'Awful lamp, broke in two days, a waste of money',
      },
    ]);
  });

  // the model judges whether the text is about the product by its name and its category; the
  // comment is the data of the message, never a part of the rules
  it('gives the model the product, its category and the comment as data, kept nowhere', async () => {
    const tag = uniqueTag();
    const home = await createCategory({ name: `Home ${tag}` });
    const lighting = await createCategory({ name: `Lighting ${tag}`, parentId: home.id });
    const product = await createProduct({
      categoryId: lighting.id,
      name: `Brass desk lamp ${tag}`,
    });
    const { asked } = checks();

    const res = await writeReview(await newUser(), product.id, { comment: 'Warm light' });

    expect(res.statusCode).toBe(201);
    const request = asked[0]!.request;
    expect(request.store).toBe(false);
    expect(request.temperature).toBe(0);
    expect(request.text?.format).toMatchObject({ name: 'review_comment_check', strict: true });
    expect(request.input).toEqual([
      {
        role: 'user',
        content: JSON.stringify({
          product: `Brass desk lamp ${tag}`,
          category: `Home ${tag} > Lighting ${tag}`,
          comment: 'Warm light',
        }),
      },
    ]);
    expect(request.instructions).not.toContain('Warm light');
  });

  it('refuses a comment the model rejects with its reasons and writes nothing', async () => {
    const product = await createProduct();
    checks(() => ({ reasons: ['profanity', 'off_topic'] }));

    const res = await writeReview(await newUser(), product.id, {
      rating: 2,
      comment: 'A comment the model refuses',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'REVIEW_COMMENT_REJECTED',
      details: { reasons: ['profanity', 'off_topic'] },
    });
    // the rating of the same request is not written either: the person fixes the text and sends both
    expect(await reviewsOf(product.id)).toEqual([]);
  });

  it('refuses a comment the moderation scores high in a dangerous kind', async () => {
    const product = await createProduct();
    checks(undefined, () => ({ 'illicit/violent': 0.93, violence: 0.95 }));

    const res = await writeReview(await newUser(), product.id, { comment: 'A dangerous call' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'REVIEW_COMMENT_REJECTED',
      details: { reasons: ['dangerous'] },
    });
    expect(await reviewsOf(product.id)).toEqual([]);
  });

  // a harsh word about the shop scores harassment, a sharp knife some violence
  it('publishes a harsh comment the moderation scores low in the dangerous kinds', async () => {
    const product = await createProduct();
    checks(undefined, () => ({ harassment: 0.97, violence: 0.6 }));

    const res = await writeReview(await newUser(), product.id, {
      comment: 'Cuts like a beast, but the shop is slow as hell',
    });

    expect(res.statusCode).toBe(201);
  });

  it('names the reasons of both checks once each, in the order of the rules', async () => {
    const product = await createProduct();
    checks(
      () => ({ reasons: ['spam', 'abuse'] }),
      () => ({ hate: 0.9, 'self-harm/instructions': 0.9 }),
    );

    const res = await writeReview(await newUser(), product.id, { comment: 'Refused twice' });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ reasons: ['abuse', 'dangerous', 'spam'] });
  });

  it('checks a comment added to a review that has a rating, a refused one leaves the rating', async () => {
    const product = await createProduct();
    const author = await newUser();
    await createReview(author.id, product.id, { rating: 4 });
    const { asked } = checks(() => ({ reasons: ['personal_data'] }));

    const res = await writeReview(author, product.id, { comment: 'Call me at +380501234567' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'REVIEW_COMMENT_REJECTED',
      details: { reasons: ['personal_data'] },
    });
    expect(asked).toHaveLength(1);
    expect(await reviewsOf(product.id)).toEqual([{ rating: 4, comment: null }]);
  });

  it('asks nobody for a rating alone', async () => {
    const product = await createProduct();
    const { asked, moderated } = checks();

    const res = await writeReview(await newUser(), product.id, { rating: 5 });

    expect(res.statusCode).toBe(201);
    expect(asked).toEqual([]);
    expect(moderated).toEqual([]);
  });

  it('asks nobody for a product out of the catalog', async () => {
    const product = await createProduct();
    await deleteProductFromCatalog(product.id);
    const { asked, moderated } = checks();

    const res = await writeReview(await newUser(), product.id, { comment: 'Fine' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect(asked).toEqual([]);
    expect(moderated).toEqual([]);
  });

  // a review waits for no outage of openai: a check that fails says nothing against the comment,
  // the other check still decides; the log names the check and the code, never the text
  it('publishes the comment when the model fails and logs it without the text', async () => {
    const product = await createProduct();
    checks(() => failure(500));

    const res = await writeReview(await newUser(), product.id, { comment: 'Secret words 7731' });

    expect(res.statusCode).toBe(201);
    const logged = takeLogs({ msg: 'review comment check failed' });
    expect(logged).toEqual([
      expect.objectContaining({
        check: 'model',
        provider: 'openai',
        code: 'AI_API_UNAVAILABLE',
        statusCode: 500,
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain('Secret words');
  });

  it('refuses by the moderation while the model is down', async () => {
    const product = await createProduct();
    checks(
      () => failure(503),
      () => ({ 'hate/threatening': 0.99 }),
    );

    const res = await writeReview(await newUser(), product.id, { comment: 'A threat' });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ reasons: ['abuse'] });
    expect(takeLogs({ msg: 'review comment check failed' })).toEqual([
      expect.objectContaining({ check: 'model', code: 'AI_API_UNAVAILABLE' }),
    ]);
  });

  it('refuses by the model while the moderation is down', async () => {
    const product = await createProduct();
    checks(
      () => ({ reasons: ['off_topic'] }),
      () => failure(429),
    );

    const res = await writeReview(await newUser(), product.id, { comment: 'Elections soon' });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ reasons: ['off_topic'] });
    expect(takeLogs({ msg: 'review comment check failed' })).toEqual([
      expect.objectContaining({ check: 'moderation', code: 'AI_RATE_LIMIT', statusCode: 429 }),
    ]);
  });

  it('publishes the comment when both checks fail', async () => {
    const product = await createProduct();
    checks(
      () => failure(500),
      () => failure(500),
    );

    const res = await writeReview(await newUser(), product.id, { comment: 'Nobody checked' });

    expect(res.statusCode).toBe(201);
    expect(
      takeLogs({ msg: 'review comment check failed' })
        .map((line) => line.check)
        .sort(),
    ).toEqual(['model', 'moderation']);
  });

  it('publishes the comment on a broken answer of the model', async () => {
    const product = await createProduct();
    checks(() => ({ reasons: ['rude'] }));

    const res = await writeReview(await newUser(), product.id, { comment: 'Odd answer' });

    expect(res.statusCode).toBe(201);
    expect(takeLogs({ msg: 'review comment check failed' })).toEqual([
      expect.objectContaining({ check: 'model', code: 'REVIEW_CHECK_ANSWER_INVALID' }),
    ]);
  });

  // a shop may keep the bot and leave the comments unchecked (the start warns about it)
  it('publishes without asking anybody when the check is off', async () => {
    const product = await createProduct();
    const { asked, moderated } = checks(() => ({ reasons: ['profanity'] }));
    env.REVIEW_CHECK_ENABLED = false;

    try {
      const res = await writeReview(await newUser(), product.id, { comment: 'Not checked' });

      expect(res.statusCode).toBe(201);
      expect(asked).toEqual([]);
      expect(moderated).toEqual([]);
    } finally {
      env.REVIEW_CHECK_ENABLED = true;
    }
  });

  // the server runs without the key of openai (the start warns about it): no check at all
  it('publishes without asking anybody when there is no key of openai', async () => {
    const product = await createProduct();

    const res = await writeReview(await newUser(), product.id, { comment: 'Unchecked' });

    expect(res.statusCode).toBe(201);
    expect(await reviewsOf(product.id)).toEqual([{ rating: null, comment: 'Unchecked' }]);
  });
});

// the check itself: the model of the test unless the run takes openai for real (service:openai,
// a cent a run). Its words are not checked, its form is: an answer of the schema comes in time and
// lets a plain comment through; a failure or a broken answer would log a warning and fail the test.
// What the rules decide for comments in other languages is checked by a script outside the repo
describe(`the check (${realOpenAi ? 'openai' : 'the model of the test'})`, () => {
  it('publishes a plain comment about the product', async () => {
    const product = await createProduct({ name: `Brass desk lamp ${uniqueTag()}` });
    const calls = useModel();

    const res = await writeReview(await newUser(), product.id, {
      rating: 5,
      comment: 'Warm light, a sturdy base, worth the price.',
    });

    expect(res.statusCode).toBe(201);
    expect(calls.map((call) => call.purpose)).toEqual(['review_check']);
    if (realOpenAi) expect(calls[0]!.status).toBe(200);
  });
});
