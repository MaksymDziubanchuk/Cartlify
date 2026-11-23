import { describe, expect, it } from '@jest/globals';

import { checkReceiptSettings } from '@helpers/receiptSettings.js';

import type { ReceiptProvider } from '@providers/receipts/index.js';

// The settings of the fiscal receipts a write of the data of the shop leaves (docs/taxes.md): a
// server whose provider makes receipts needs the moment of the receipt, an invoice of every order
// (a receipt registers an invoice), the moment the law of the provider fixes and a seller of a
// country it serves; it is turned on with its keys only. A server without one takes no moment

const provider = (over: Partial<ReceiptProvider> = {}): ReceiptProvider => ({
  name: 'fiskaly',
  label: 'A provider',
  makesReceipts: () => true,
  isConfigured: () => true,
  sellerCountries: () => ['ES'],
  fixedMoment: () => 'payment',
  issue: () => Promise.reject(new Error('not here')),
  status: () => Promise.reject(new Error('not here')),
  ...over,
});

const none = provider({ name: 'none', makesReceipts: () => false });

const values = (over: Partial<Parameters<typeof checkReceiptSettings>[0]> = {}) => ({
  receiptMoment: 'payment' as const,
  invoiceMode: 'every_order' as const,
  sellerCountry: 'ES',
  ...over,
});

// the code of the refusal, null when the values pass
const refusalOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (err) {
    const e = err as { errorCode?: string; details?: unknown };
    return { code: e.errorCode, details: e.details };
  }
};

describe('checkReceiptSettings', () => {
  it('passes the settings a provider that makes receipts needs', () => {
    expect(refusalOf(() => checkReceiptSettings(values(), provider(), null))).toBeNull();
  });

  it('asks for the moment of the receipt while the provider makes receipts', () => {
    expect(
      refusalOf(() => checkReceiptSettings(values({ receiptMoment: null }), provider(), 'payment')),
    ).toMatchObject({ code: 'RECEIPT_MOMENT_REQUIRED' });
  });

  it('turns the receipts on with the keys of the provider only, a later loss of them does not stop a write', () => {
    const unkeyed = provider({ isConfigured: () => false });

    expect(refusalOf(() => checkReceiptSettings(values(), unkeyed, null))).toMatchObject({
      code: 'RECEIPT_PROVIDER_NOT_CONFIGURED',
    });
    expect(refusalOf(() => checkReceiptSettings(values(), unkeyed, 'payment'))).toBeNull();
  });

  it.each([
    ['on request', 'on_request' as const],
    ['not set', null],
  ])('asks for an invoice of every order: invoices %s are refused', (_name, invoiceMode) => {
    expect(
      refusalOf(() => checkReceiptSettings(values({ invoiceMode }), provider(), 'payment')),
    ).toMatchObject({ code: 'RECEIPT_INVOICE_EVERY_ORDER_REQUIRED' });
  });

  it('keeps the moment the law of the provider fixes, and lets root choose when it fixes none', () => {
    expect(
      refusalOf(() =>
        checkReceiptSettings(values({ receiptMoment: 'shipment' }), provider(), 'payment'),
      ),
    ).toEqual({ code: 'RECEIPT_MOMENT_FIXED', details: { moment: 'payment' } });
    expect(
      refusalOf(() =>
        checkReceiptSettings(
          values({ receiptMoment: 'shipment' }),
          provider({ fixedMoment: () => null }),
          'payment',
        ),
      ),
    ).toBeNull();
  });

  it('serves a seller of a country of the provider only, any country when it names none', () => {
    expect(
      refusalOf(() => checkReceiptSettings(values({ sellerCountry: 'DE' }), provider(), 'payment')),
    ).toEqual({
      code: 'RECEIPT_SELLER_COUNTRY_NOT_SUPPORTED',
      details: { country: 'DE', supported: ['ES'] },
    });
    expect(
      refusalOf(() => checkReceiptSettings(values({ sellerCountry: null }), provider(), 'payment')),
    ).toMatchObject({ code: 'RECEIPT_SELLER_COUNTRY_NOT_SUPPORTED' });
    expect(
      refusalOf(() =>
        checkReceiptSettings(
          values({ sellerCountry: 'DE' }),
          provider({ sellerCountries: () => null }),
          'payment',
        ),
      ),
    ).toBeNull();
  });

  it('takes no moment on a server without receipts, and nothing else of the invoices', () => {
    expect(refusalOf(() => checkReceiptSettings(values(), none, null))).toMatchObject({
      code: 'RECEIPT_MOMENT_WITHOUT_PROVIDER',
    });
    expect(
      refusalOf(() =>
        checkReceiptSettings(
          values({ receiptMoment: null, invoiceMode: 'on_request', sellerCountry: 'DE' }),
          none,
          null,
        ),
      ),
    ).toBeNull();
  });
});
