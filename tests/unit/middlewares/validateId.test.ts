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
    // ids are int columns: a bigger number is no row, and the database would answer with an error
    ['one above the int range', '2147483648'],
    ['far above the int range', '9999999999'],
    ['above the safe integers', '99999999999999999999'],
  ])('throws INVALID_ID_PARAM when the id is %s', async (_case, value) => {
    const err = await rejectedBy(() => check(value));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
  });

  // a route with a params schema runs ajv coercion first, the hook then gets a number
  it('passes an id that a params schema already turned into a number', async () => {
    await expect(check(42)).resolves.toBeUndefined();
  });

  it.each([0, -3, 1.5, Number.NaN, 2_147_483_648])(
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

describe('validateId and a raw id', () => {
  it('tells the parameter it checks, for the swagger document', () => {
    expect(validateId('productId').idParam).toBe('productId');
  });

  // Number() reads these as numbers, a raw id is digits only
  it.each(['1e3', '0x1A', ' 7 ', '7.0'])('refuses the raw id %p', async (productId) => {
    expect(
      await rejectedBy(() => validateId('productId')(fakeRequest({ params: { productId } }))),
    ).toBeInstanceOf(BadRequestError);
  });
});
