import { afterEach, describe, expect, it } from '@jest/globals';

import {
  buildAddressData,
  buildDeliveryData,
  findUnavailableItems,
  isRecipientName,
} from '@routes/api/orders/services/helpers/confirmOrder.helper.js';
import { BadRequestError } from '@utils/errors.js';
import type { ConfirmDeliveryBodyDto } from 'types/dto/orders.dto.js';

import { resetDelivery, setDelivery } from '../../../../../../helpers/delivery.js';
import { thrownBy } from '../../../../../../helpers/errors.js';

afterEach(resetDelivery);

const address = {
  country: 'UA',
  postalCode: '01001',
  city: 'Kyiv',
  street: 'Khreshchatyk',
  house: '1',
};

const manual: ConfirmDeliveryBodyDto = {
  method: 'manual',
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
  address,
};

const refusal = (run: () => unknown) => {
  const err = thrownBy(run);

  expect(err).toBeInstanceOf(BadRequestError);
  return (err as BadRequestError).errorCode;
};

const refusalOf = (patch: Partial<ConfirmDeliveryBodyDto>) =>
  refusal(() => buildDeliveryData({ ...manual, ...patch }));

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

describe('buildAddressData', () => {
  it('cuts the spaces around the parts and gives the postal code in the form of its country', () => {
    setDelivery({ DELIVERY_COUNTRIES: ['PL'] });

    expect(
      buildAddressData({
        country: 'PL',
        postalCode: ' 00950 ',
        city: ' Warsaw ',
        street: '\tMarszalkowska\n',
        house: ' 10 ',
        apartment: ' 4 ',
      }),
    ).toEqual({
      country: 'PL',
      postalCode: '00-950',
      city: 'Warsaw',
      street: 'Marszalkowska',
      house: '10',
      apartment: '4',
    });
  });

  it('leaves an apartment of spaces, or none, out', () => {
    expect(buildAddressData({ ...address, apartment: '   ' }).apartment).toBeNull();
    expect(buildAddressData(address).apartment).toBeNull();
  });

  it('refuses a country the shop does not deliver to, and names it', () => {
    const err = thrownBy(() =>
      buildAddressData({ ...address, country: 'PL', postalCode: '00-950' }),
    );

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      errorCode: 'DELIVERY_COUNTRY_NOT_ALLOWED',
      details: { country: 'PL' },
    });
  });

  it.each(['0100', '0100A', '', '01 001'])(
    'refuses the postal code "%s" of Ukraine',
    (postalCode) => {
      expect(refusal(() => buildAddressData({ ...address, postalCode }))).toBe(
        'DELIVERY_POSTAL_CODE_INVALID',
      );
    },
  );

  it('refuses a city or a street without a letter', () => {
    expect(refusal(() => buildAddressData({ ...address, city: '123' }))).toBe(
      'DELIVERY_CITY_INVALID',
    );
    expect(refusal(() => buildAddressData({ ...address, street: '--' }))).toBe(
      'DELIVERY_STREET_INVALID',
    );
  });

  it('takes a house by its number, its name or both, and s/n in any case for a house without a number', () => {
    expect(buildAddressData({ ...address, house: '12a' }).house).toBe('12a');
    expect(buildAddressData({ ...address, house: 'Rose Cottage' }).house).toBe('Rose Cottage');
    expect(buildAddressData({ ...address, house: ' Rose Cottage 3 ' }).house).toBe(
      'Rose Cottage 3',
    );
    expect(buildAddressData({ ...address, house: 'S/N' }).house).toBe('s/n');
  });

  it('refuses a house of only spaces', () => {
    expect(refusal(() => buildAddressData({ ...address, house: '   ' }))).toBe(
      'DELIVERY_HOUSE_INVALID',
    );
  });
});

describe('buildDeliveryData', () => {
  it('cuts the spaces around the names and the note and writes the whole delivery', () => {
    expect(
      buildDeliveryData({
        ...manual,
        recipientFirstName: ' Anna ',
        recipientLastName: '\tKoval\n',
        note: '  Leave near the door. ',
      }),
    ).toEqual({
      method: 'manual',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      recipientPhone: '+380501234567',
      note: 'Leave near the door.',
      ...buildAddressData(address),
    });
  });

  it('writes no note when there is none, or an empty one', () => {
    expect(buildDeliveryData(manual).note).toBeNull();
    expect(buildDeliveryData({ ...manual, note: '   ' }).note).toBeNull();
  });

  it('writes a pickup with the person alone, the parts of the address none', () => {
    setDelivery({ DELIVERY_METHODS: ['manual', 'pickup'] });
    const { address: _address, ...person } = manual;

    expect(buildDeliveryData({ ...person, method: 'pickup' })).toEqual({
      method: 'pickup',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      recipientPhone: '+380501234567',
      note: null,
      country: null,
      postalCode: null,
      city: null,
      street: null,
      house: null,
      apartment: null,
    });
  });

  it('refuses an address for a pickup, and a manual delivery without one', () => {
    setDelivery({ DELIVERY_METHODS: ['manual', 'pickup'] });

    expect(refusalOf({ method: 'pickup' })).toBe('DELIVERY_ADDRESS_NOT_ALLOWED');
    const { address: _address, ...person } = manual;
    expect(refusal(() => buildDeliveryData(person))).toBe('DELIVERY_ADDRESS_REQUIRED');
  });

  it('refuses a method the shop has not enabled, and names it', () => {
    setDelivery({ DELIVERY_METHODS: ['manual'] });
    const { address: _address, ...person } = manual;

    const err = thrownBy(() => buildDeliveryData({ ...person, method: 'pickup' }));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      errorCode: 'DELIVERY_METHOD_NOT_AVAILABLE',
      details: { method: 'pickup' },
    });
  });

  it.each([
    ['recipientFirstName', 'RECIPIENT_FIRST_NAME_INVALID'],
    ['recipientLastName', 'RECIPIENT_LAST_NAME_INVALID'],
  ] as const)('refuses a %s of spaces, without a letter or with a digit', (field, errorCode) => {
    for (const value of ['   ', '---', 'Anna2']) {
      expect(refusalOf({ [field]: value })).toBe(errorCode);
    }
  });

  // the profile phone takes the same single form
  it.each(['0501234567', '+38 050 123 45 67', ' +380501234567', '+0123456789', ''])(
    'refuses the phone "%s"',
    (phone) => {
      expect(refusalOf({ recipientPhone: phone })).toBe('RECIPIENT_PHONE_INVALID');
    },
  );

  it('checks every part before it returns, so nothing half checked is written', () => {
    expect(refusalOf({ recipientPhone: 'not a phone', address: { ...address, city: '1' } })).toBe(
      'RECIPIENT_PHONE_INVALID',
    );
  });
});

// the items an order cannot be confirmed with: a product removed from the catalog, or more than its
// free units, the stock less what the waiting orders hold and the units of batches that are over
describe('findUnavailableItems', () => {
  const item = (
    patch: Partial<{
      quantity: number;
      stock: number;
      reservedStock: number;
      deletedAt: Date | null;
    }> = {},
  ) => ({
    id: 31,
    productId: 4,
    quantity: patch.quantity ?? 2,
    product: {
      deletedAt: patch.deletedAt ?? null,
      stock: patch.stock ?? 5,
      reservedStock: patch.reservedStock ?? 1,
    },
  });

  it('lets through what the free units hold', () => {
    expect(findUnavailableItems([item()], new Map())).toEqual([]);
  });

  it('names an item of more than the free units, the units that are over left out', () => {
    expect(findUnavailableItems([item({ quantity: 2 })], new Map([[4, 3]]))).toEqual([
      { itemId: 31, productId: 4, reason: 'out_of_stock', available: 1, requested: 2 },
    ]);
  });

  it('never gives fewer than no free units', () => {
    expect(findUnavailableItems([item()], new Map([[4, 9]]))[0]).toMatchObject({ available: 0 });
  });

  it('names an item of a product removed from the catalog', () => {
    expect(findUnavailableItems([item({ deletedAt: new Date() })], new Map())).toEqual([
      { itemId: 31, productId: 4, reason: 'deleted', available: 0, requested: 2 },
    ]);
  });
});

describe('findUnavailableItems at the free units', () => {
  it('lets through an item of exactly the free units', () => {
    const item = {
      id: 41,
      productId: 6,
      quantity: 3,
      product: { deletedAt: null, stock: 5, reservedStock: 2 },
    };

    expect(findUnavailableItems([item], new Map())).toEqual([]);
  });
});
