import { describe, expect, it } from '@jest/globals';

import validateId from '@middlewares/validateId.js';
import { BadRequestError } from '@utils/errors.js';

import { fakeReply, fakeRequest } from '../../helpers/fakeHttp.js';
import { rejectedBy } from '../../helpers/errors.js';

const check = (value: unknown) =>
  (validateId('productId') as (...args: unknown[]) => Promise<void>).call(
    undefined,
    fakeRequest({ params: { productId: value } }),
    fakeReply().reply,
  );

describe('validateId', () => {
  it.each(['1', '42', '2147483647'])('passes the id %s', async (value) => {
    await expect(check(value)).resolves.toBeUndefined();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['a fraction', '1.5'],
    ['a word', 'abc'],
    ['empty', ''],
    ['digits with text', '12abc'],
    // these become valid numbers through Number(), but an id is only digits
    ['in exponent form', '1e3'],
    ['in hex form', '0x1A'],
    ['with spaces', ' 7 '],
  ])('throws INVALID_ID_PARAM when the id is %s', async (_case, value) => {
    const err = await rejectedBy(() => check(value));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
  });

  // a route with a params schema runs ajv coercion first, the hook then gets a number
  it('passes an id that a params schema already turned into a number', async () => {
    await expect(check(42)).resolves.toBeUndefined();
  });

  it.each([0, -3, 1.5, Number.NaN])(
    'throws INVALID_ID_PARAM when a coerced id is %p',
    async (value) => {
      await expect(check(value)).rejects.toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
    },
  );

  it('throws when the param is missing', async () => {
    const run = (validateId('orderId') as (...args: unknown[]) => Promise<void>).call(
      undefined,
      fakeRequest({ params: {} }),
      fakeReply().reply,
    );

    await expect(run).rejects.toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
  });
});
