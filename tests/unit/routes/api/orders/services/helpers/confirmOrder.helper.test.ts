import { describe, expect, it } from '@jest/globals';

import {
  buildConfirmOrderData,
  isRecipientName,
} from '@routes/api/orders/services/helpers/confirmOrder.helper.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const refusal = (input: Parameters<typeof buildConfirmOrderData>[0]) => {
  const err = thrownBy(() => buildConfirmOrderData(input));

  expect(err).toBeInstanceOf(BadRequestError);
  return (err as BadRequestError).errorCode;
};

describe('isRecipientName', () => {
  it.each(['Anna', 'Koval-Shevchenko', "O'Brien", 'Zoë', 'Ελένη', 'de la Cruz'])(
    'takes %s',
    (name) => {
      expect(isRecipientName(name)).toBe(true);
    },
  );

  it.each([
    ['a digit', 'Anna2'],
    ['a digit of another script', 'Anna٣'],
    ['no letter', '---'],
    ['nothing', ''],
  ])('refuses a name with %s', (_case, name) => {
    expect(isRecipientName(name)).toBe(false);
  });
});

describe('buildConfirmOrderData', () => {
  it('writes nothing when the request brings no shipping data', () => {
    expect(buildConfirmOrderData({})).toEqual({});
  });

  it('cuts the spaces around the address, the names and the note', () => {
    expect(
      buildConfirmOrderData({
        shippingAddress: '  Main st 1, Kyiv ',
        recipientFirstName: ' Anna ',
        recipientLastName: '\tKoval\n',
        recipientPhone: '+380501234567',
        note: '  Leave near the door. ',
      }),
    ).toEqual({
      shippingAddress: 'Main st 1, Kyiv',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      recipientPhone: '+380501234567',
      note: 'Leave near the door.',
    });
  });

  it('writes only the fields that were sent', () => {
    expect(buildConfirmOrderData({ recipientPhone: '+12345678' })).toEqual({
      recipientPhone: '+12345678',
    });
  });

  it('removes the note when an empty one is sent', () => {
    expect(buildConfirmOrderData({ note: '' })).toEqual({ note: null });
    expect(buildConfirmOrderData({ note: '   ' })).toEqual({ note: null });
  });

  it('refuses an address of spaces', () => {
    expect(refusal({ shippingAddress: '   ' })).toBe('SHIPPING_ADDRESS_INVALID');
  });

  it.each([
    ['recipientFirstName', 'RECIPIENT_FIRST_NAME_INVALID'],
    ['recipientLastName', 'RECIPIENT_LAST_NAME_INVALID'],
  ] as const)('refuses a %s of spaces, without a letter or with a digit', (field, errorCode) => {
    for (const value of ['   ', '---', 'Anna2']) {
      expect(refusal({ [field]: value })).toBe(errorCode);
    }
  });

  // the profile phone takes the same single form
  it.each(['0501234567', '+38 050 123 45 67', ' +380501234567', '+0123456789', ''])(
    'refuses the phone "%s"',
    (phone) => {
      expect(refusal({ recipientPhone: phone })).toBe('RECIPIENT_PHONE_INVALID');
    },
  );

  it('checks every field before it returns, so nothing half checked is written', () => {
    expect(
      refusal({
        shippingAddress: 'Main st 1',
        recipientFirstName: 'Anna',
        recipientLastName: 'Koval',
        recipientPhone: 'not a phone',
      }),
    ).toBe('RECIPIENT_PHONE_INVALID');
  });
});
