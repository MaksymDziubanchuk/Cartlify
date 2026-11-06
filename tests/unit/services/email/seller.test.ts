import { afterEach, describe, expect, it } from '@jest/globals';

import { sellerLineOf } from '@services/email/seller.js';

import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// the seller at the foot of every mail: the parts root filled in, as root wrote them, the words
// around them in the language of the mail; nothing while root filled in none

const SELLER = {
  sellerLegalName: 'Cartlify LLC',
  sellerAddress: 'Main St 1, Kyiv',
  sellerTaxId: '12345678',
  sellerEmail: 'legal@cartlify.test',
  sellerPhone: '+380501234567',
};

afterEach(() => {
  resetShopSettings();
});

describe('sellerLineOf', () => {
  it.each([
    [
      'en',
      'Seller: Cartlify LLC, Main St 1, Kyiv, tax ID 12345678, legal@cartlify.test, +380501234567',
    ],
    [
      'uk',
      'Продавець: Cartlify LLC, Main St 1, Kyiv, податковий номер 12345678, legal@cartlify.test, +380501234567',
    ],
    [
      'es',
      'Vendedor: Cartlify LLC, Main St 1, Kyiv, identificación fiscal 12345678, legal@cartlify.test, +380501234567',
    ],
  ])('names every part root filled in (%s), the values as written', (locale, line) => {
    setShopSettings(SELLER);

    expect(sellerLineOf(locale)).toBe(line);
  });

  it('leaves out a part root left empty or blank', () => {
    setShopSettings({ ...SELLER, sellerAddress: null, sellerTaxId: '  ', sellerPhone: '' });

    expect(sellerLineOf('en')).toBe('Seller: Cartlify LLC, legal@cartlify.test');
  });

  it('is empty while root filled in none of them', () => {
    setShopSettings({
      sellerLegalName: null,
      sellerAddress: null,
      sellerTaxId: null,
      sellerEmail: null,
      sellerPhone: null,
    });

    expect(sellerLineOf('en')).toBe('');
  });
});
