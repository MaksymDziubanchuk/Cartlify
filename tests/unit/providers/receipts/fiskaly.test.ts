import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { importWithEnv } from '../../../helpers/freshImport.js';
import { jsonResponse, stubFetch, type FetchCall } from '../../../helpers/fetchStub.js';

import type { ReceiptProvider, ReceiptRequest } from '@providers/receipts/index.js';

// The provider fiskaly (SIGN ES) as it talks to the service: the request it sends for each kind of
// receipt and each rule of the tax (the shapes the tax authority of the test registered,
// notes/fiskaly.md), the taxpayer it makes or checks, and how it reads each answer. The service is a
// stub here; tests/integration/providers/receipts.contract.test.ts holds the same contract against
// the mock and the real TEST. Each test takes a fresh copy of the provider: a token and the
// taxpayer it checked belong to one process

const TEST_BASE = 'https://test.es.sign.fiskaly.com/api/v1';

let provider: ReceiptProvider;

const freshProvider = (
  shop: { sellerTaxId?: string | null; sellerLegalName?: string | null } = {},
) =>
  importWithEnv<typeof import('@providers/receipts/fiskaly/fiskaly.provider.js')>(
    '@providers/receipts/fiskaly/fiskaly.provider.js',
    {
      FISKALY_API_KEY: 'made-up-key',
      FISKALY_API_SECRET: 'made-up-secret',
      FISKALY_ENVIRONMENT: 'test',
    },
    {
      shopSettings: {
        sellerTaxId: 'sellerTaxId' in shop ? shop.sellerTaxId! : 'ESB12345674',
        sellerLegalName: 'sellerLegalName' in shop ? shop.sellerLegalName! : 'Cartlify S.L.',
      },
    },
  ).then((m) => m.fiskalyReceiptProvider);

beforeEach(async () => {
  provider = await freshProvider();
});

afterEach(() => {
  jest.restoreAllMocks();
});

type Answer = { status?: number; body?: unknown } | Error;

// the service of the stub: a token, a taxpayer with the NIF given (none: 404), the devices, and the
// answers the test queues for the invoices (each call of /clients/.../invoices takes the next one)
function serviceOf(opts: { taxpayerNif?: string | null; invoices?: Answer[] } = {}) {
  const invoices = [...(opts.invoices ?? [])];
  const calls = stubFetch((call: FetchCall) => {
    const path = call.url.slice(TEST_BASE.length);
    if (path === '/auth') {
      return jsonResponse({ content: { access_token: { bearer: 'tok', expires_in: 86400 } } });
    }
    if (path === '/taxpayer' && call.method === 'GET') {
      return opts.taxpayerNif === null || opts.taxpayerNif === undefined
        ? jsonResponse({ content: { code: 'E_RESOURCE_NOT_FOUND' } }, 404)
        : jsonResponse({ content: { issuer: { tax_number: opts.taxpayerNif } } });
    }
    if (path === '/taxpayer' || path.startsWith('/signers/') || /^\/clients\/[^/]+$/.test(path)) {
      return jsonResponse({ content: {} });
    }
    if (path.includes('/invoices/')) {
      const next = invoices.shift();
      if (!next) throw new Error(`no answer queued for ${call.method} ${path}`);
      if (next instanceof Error) throw next;
      return jsonResponse(next.body ?? {}, next.status ?? 200);
    }
    throw new Error(`unexpected ${call.method} ${path}`);
  });
  const invoiceCalls = () => calls.filter((c) => c.url.includes('/invoices/'));
  return { calls, invoiceCalls };
}

const registered = (extra: Record<string, unknown> = {}) => ({
  content: {
    id: 'inv-1',
    state: 'ISSUED',
    transmission: { registration: 'REGISTERED', registration_csv: 'A-4AM4GHCNGLVNYA' },
    compliance: {
      code: { type: 'QR_CODE', image: 'iVBORw0KGgo=' },
      url: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674',
      text: 'QR tributario:|VERI*FACTU',
    },
    ...extra,
  },
});
const pending = {
  content: {
    id: 'inv-1',
    state: 'ISSUED',
    transmission: { registration: 'PENDING' },
    compliance: {},
  },
};

const sale = (over: Partial<ReceiptRequest> = {}): ReceiptRequest => ({
  key: 'F-7',
  kind: 'sale',
  series: 'F',
  number: 7,
  issuedAt: new Date('2026-11-22T10:00:00Z'),
  currency: 'EUR',
  taxRule: 'seller',
  taxCountry: 'ES',
  // 3 units of 0.99 (21 % holds 0.52), the delivery of 6 (1.04)
  lines: [
    { name: 'Socks', quantity: 3, rate: 21, net: 2.45, tax: 0.52, gross: 2.97 },
    { name: 'Delivery', quantity: null, rate: 21, net: 4.96, tax: 1.04, gross: 6 },
  ],
  gross: 8.97,
  correctsKey: null,
  ...over,
});

const bodyOf = (call: FetchCall) => JSON.parse(call.body) as { content: Record<string, any> };

describe('the taxpayer of the key', () => {
  it('is made once with the NIF of the shop without its country prefix, with the signer and the client', async () => {
    const service = serviceOf({
      taxpayerNif: null,
      invoices: [{ body: pending }, { body: pending }],
    });

    await provider.issue(sale());
    await provider.issue(sale({ key: 'F-8', number: 8 }));

    const made = service.calls.filter((c) => c.url.endsWith('/taxpayer') && c.method === 'PUT');
    expect(made.map(bodyOf)).toEqual([
      {
        content: {
          issuer: { legal_name: 'Cartlify S.L.', tax_number: 'B12345674' },
          territory: 'SPAIN_OTHER',
        },
      },
    ]);
    // the certificate is fiskaly's: the signer is put with no content
    const signer = service.calls.find((c) => c.url.includes('/signers/'))!;
    expect(signer.body).toBe('{}');
    expect(service.calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(1);
  });

  it('refuses every receipt while the taxpayer of the key has another NIF', async () => {
    const service = serviceOf({ taxpayerNif: 'B00000000' });

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_REFUSED',
      details: { code: 'TAXPAYER_MISMATCH' },
    });
    expect(service.invoiceCalls()).toHaveLength(0);
  });

  it('takes a taxpayer of the same NIF however the shop writes it', async () => {
    provider = await freshProvider({ sellerTaxId: 'es b-12345674' });
    serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await expect(provider.issue(sale())).resolves.toMatchObject({ state: 'pending' });
  });

  it('refuses a shop without its NIF or its legal name', async () => {
    provider = await freshProvider({ sellerTaxId: null });
    serviceOf();

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_REFUSED',
      details: { code: 'SELLER_TAX_DATA_REQUIRED' },
    });
  });
});

describe('the invoice it registers', () => {
  it('is a simplified invoice of our series and number, units at the net of a unit, a sum as one unit', async () => {
    const service = serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await provider.issue(sale());

    const [put] = service.invoiceCalls();
    expect(put!.method).toBe('PUT');
    expect(bodyOf(put!).content).toEqual({
      type: 'SIMPLIFIED',
      series: 'F',
      number: '7',
      text: 'F-7',
      full_amount: '8.97',
      items: [
        {
          text: 'Socks',
          quantity: '3',
          unit_amount: '0.81666667',
          full_amount: '2.97',
          system: { type: 'REGULAR', category: { type: 'VAT', rate: '21' } },
        },
        {
          text: 'Delivery',
          quantity: '1',
          unit_amount: '4.96000000',
          full_amount: '6.00',
          system: { type: 'REGULAR', category: { type: 'VAT', rate: '21' } },
        },
      ],
    });
  });

  it.each([
    [
      'the VAT of another country of the EU (OSS): not taxed in Spain',
      { taxRule: 'recipient' as const, taxCountry: 'FR' },
      { system: { type: 'OSS_IOSS', category: { type: 'NO_VAT', cause: 'NON_TAXABLE_3' } } },
    ],
    [
      'the tax of a country out of the EU the shop took: the goods leave the EU, an export',
      { taxRule: 'recipient' as const, taxCountry: 'GB' },
      { concept: 'INTERNATIONAL_GOOD', system: { type: 'EXPORT', cause: 'TAXABLE_EXEMPT_2' } },
    ],
    [
      'no VAT out of the EU: an export',
      { taxRule: 'none' as const, taxCountry: 'US' },
      { concept: 'INTERNATIONAL_GOOD', system: { type: 'EXPORT', cause: 'TAXABLE_EXEMPT_2' } },
    ],
    [
      'the VAT the buyer pays on receipt out of the EU: an export',
      { taxRule: 'buyer_at_receipt' as const, taxCountry: 'GB' },
      { concept: 'INTERNATIONAL_GOOD', system: { type: 'EXPORT', cause: 'TAXABLE_EXEMPT_2' } },
    ],
    [
      'no VAT in another country of the EU: by the rules of the place',
      { taxRule: 'none' as const, taxCountry: 'DE' },
      { system: { type: 'REGULAR', category: { type: 'NO_VAT', cause: 'NON_TAXABLE_2' } } },
    ],
    [
      'no VAT in Spain: exempt by another cause',
      { taxRule: 'none' as const, taxCountry: 'ES' },
      { system: { type: 'REGULAR', category: { type: 'NO_VAT', cause: 'TAXABLE_EXEMPT_6' } } },
    ],
  ])('registers %s', async (_name, rule, expected) => {
    const service = serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await provider.issue(sale(rule));

    const items = bodyOf(service.invoiceCalls()[0]!).content.items as Record<string, unknown>[];
    for (const item of items) expect(item).toMatchObject(expected);
    if (!('concept' in expected))
      for (const item of items) expect(item).not.toHaveProperty('concept');
  });

  it('registers a line without a tax in Spain as exempt by another cause', async () => {
    const service = serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await provider.issue(
      sale({
        lines: [{ name: 'Gift card', quantity: 1, rate: null, net: 10, tax: 0, gross: 10 }],
        gross: 10,
      }),
    );

    expect(bodyOf(service.invoiceCalls()[0]!).content.items[0].system).toEqual({
      type: 'REGULAR',
      category: { type: 'NO_VAT', cause: 'TAXABLE_EXEMPT_6' },
    });
  });

  // the record of the tax authority holds the taxes of Spain only: the total is the sum of the bases
  // and of those taxes (ImporteTotal), the tax of another country is on the invoice of the buyer
  it.each([
    ['the VAT of another country of the EU (OSS)', 'FR', 'sale' as const, 1],
    ['the tax of a country out of the EU the shop took (an export)', 'GB', 'sale' as const, 1],
    ['a return of a sale taxed in another country', 'FR', 'return' as const, -1],
  ])('registers %s at the sums without that tax', async (_name, taxCountry, kind, sign) => {
    const service = serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    // 4 units of 24.20 (20 % holds 16.13), the delivery of 8 (1.33): 104.80 the buyer paid
    await provider.issue(
      sale({
        kind,
        taxRule: 'recipient',
        taxCountry,
        lines: [
          {
            name: 'Lamp',
            quantity: kind === 'sale' ? 4 : null,
            rate: 20,
            net: sign * 80.67,
            tax: sign * 16.13,
            gross: sign * 96.8,
          },
          {
            name: 'Delivery',
            quantity: null,
            rate: 20,
            net: sign * 6.67,
            tax: sign * 1.33,
            gross: sign * 8,
          },
        ],
        gross: sign * 104.8,
        correctsKey: kind === 'sale' ? null : 'F-7',
      }),
    );

    const content = bodyOf(service.invoiceCalls()[0]!).content;
    const invoice = kind === 'sale' ? content : content.invoice;
    expect(invoice.full_amount).toBe((sign * 87.34).toFixed(2));
    expect(invoice.items.map((item: Record<string, unknown>) => item.full_amount)).toEqual([
      (sign * 80.67).toFixed(2),
      (sign * 6.67).toFixed(2),
    ]);
  });

  it('registers a sale with the VAT of Spain at the sums with it, beside a line without a tax', async () => {
    const service = serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await provider.issue(
      sale({
        lines: [
          { name: 'Socks', quantity: 3, rate: 21, net: 2.45, tax: 0.52, gross: 2.97 },
          { name: 'Gift card', quantity: 1, rate: null, net: 10, tax: 0, gross: 10 },
        ],
        gross: 12.97,
      }),
    );

    const content = bodyOf(service.invoiceCalls()[0]!).content;
    expect(content.full_amount).toBe('12.97');
    expect(content.items.map((item: Record<string, unknown>) => item.full_amount)).toEqual([
      '2.97',
      '10.00',
    ]);
  });

  it.each([
    ['a return', 'return' as const, -6],
    ['the money of a return that came back', 'reversal' as const, 6],
  ])(
    'registers %s as a correcting invoice by differences of the invoice of the sale',
    async (_name, kind, gross) => {
      const service = serviceOf({
        taxpayerNif: 'B12345674',
        invoices: [{ body: pending }, { body: pending }],
      });

      await provider.issue(sale());
      await provider.issue(
        sale({
          key: 'R-1',
          kind,
          series: 'R',
          number: 1,
          // a sum of 6 (21 % holds 1.04), not units, of the sign of the correction
          lines: [
            {
              name: 'Socks',
              quantity: null,
              rate: 21,
              net: gross - Math.sign(gross) * 1.04,
              tax: Math.sign(gross) * 1.04,
              gross,
            },
          ],
          gross,
          correctsKey: 'F-7',
        }),
      );

      const [first, correction] = service.invoiceCalls();
      const saleId = first!.url.split('/invoices/')[1];
      const content = bodyOf(correction!).content;
      expect(content).toMatchObject({
        type: 'CORRECTING',
        id: saleId,
        method: 'DIFFERENCES',
        code: 'CORRECTION_1',
        reference_original_id: true,
        invoice: {
          type: 'SIMPLIFIED',
          series: 'R',
          number: '1',
          full_amount: gross.toFixed(2),
          items: [{ quantity: '1', full_amount: gross.toFixed(2) }],
        },
      });
      expect(correction!.url).not.toBe(first!.url);
    },
  );

  it('puts the same document under the same id on every try', async () => {
    const service = serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [{ body: pending }, { body: pending }],
    });

    await provider.issue(sale());
    await provider.issue(sale());

    const [one, two] = service.invoiceCalls();
    expect(one!.url).toBe(two!.url);
    expect(one!.body).toBe(two!.body);
  });

  it('refuses a document in another currency than the euro, without asking the service', async () => {
    const service = serviceOf({ taxpayerNif: 'B12345674' });

    await expect(provider.issue(sale({ currency: 'USD' }))).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_REFUSED',
      details: { code: 'CURRENCY_NOT_SUPPORTED' },
    });
    expect(service.calls).toHaveLength(0);
  });
});

describe('the answers it reads', () => {
  it('gives a registered receipt its code of the tax authority, the link, the picture and the text a line each', async () => {
    serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: registered() }] });

    await expect(provider.issue(sale())).resolves.toEqual({
      state: 'registered',
      number: 'A-4AM4GHCNGLVNYA',
      url: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674',
      code: 'iVBORw0KGgo=',
      text: 'QR tributario:\nVERI*FACTU',
    });
  });

  // the picture is drawn on the PDF of the document: a png or a jpeg in base64 within a size only
  it.each([
    ['an svg', 'PHN2Zz48L3N2Zz4='],
    ['words that are no base64', 'not a picture'],
    ['a picture too large', 'iVBORw0KGgo' + 'A'.repeat(200_001)],
  ])('keeps no code that is %s', async (_what, image) => {
    serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [
        {
          body: registered({
            compliance: { code: { type: 'QR_CODE', image }, url: null, text: null },
          }),
        },
      ],
    });

    await expect(provider.issue(sale())).resolves.toMatchObject({
      state: 'registered',
      code: null,
    });
  });

  it('takes the data of a picture given as a data url', async () => {
    serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [
        {
          body: registered({
            compliance: { code: { type: 'QR_CODE', image: 'data:image/png;base64,iVBORw0KGgo=' } },
          }),
        },
      ],
    });

    await expect(provider.issue(sale())).resolves.toMatchObject({ code: 'iVBORw0KGgo=' });
  });

  it('gives a receipt the service registers later as pending, with the id of the invoice there', async () => {
    serviceOf({ taxpayerNif: 'B12345674', invoices: [{ body: pending }] });

    await expect(provider.issue(sale())).resolves.toMatchObject({
      state: 'pending',
      number: 'inv-1',
    });
  });

  it.each(['REQUIRES_INSPECTION', 'REQUIRES_CORRECTION', 'INVALID'])(
    'refuses a receipt the tax authority answered %s, with its validations',
    async (registration) => {
      serviceOf({
        taxpayerNif: 'B12345674',
        invoices: [
          {
            body: {
              content: {
                id: 'inv-1',
                transmission: { registration },
                validations: [{ code: '1124', description: 'El valor del campo TipoImpositivo' }],
              },
            },
          },
        ],
      });

      await expect(provider.issue(sale())).rejects.toMatchObject({
        errorCode: 'RECEIPT_PROVIDER_REFUSED',
        details: {
          registration,
          validations: [{ code: '1124', description: 'El valor del campo TipoImpositivo' }],
        },
      });
    },
  );

  it('asks for the document it put before when the service says it has it', async () => {
    const service = serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [
        { status: 409, body: { content: { code: 'E_RESOURCE_CONFLICT' } } },
        { body: registered() },
      ],
    });

    await expect(provider.issue(sale())).resolves.toMatchObject({ state: 'registered' });
    expect(service.invoiceCalls().map((c) => c.method)).toEqual(['PUT', 'GET']);
  });

  it('refuses a document whose number another invoice holds', async () => {
    serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [
        { status: 409, body: {} },
        { status: 404, body: {} },
      ],
    });

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_REFUSED',
      details: { code: 'NUMBER_TAKEN' },
    });
  });

  it('asks where a receipt stands, and sends it when the service never took it', async () => {
    const service = serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [{ body: pending }, { status: 404, body: {} }, { body: registered() }],
    });

    await expect(provider.status(sale())).resolves.toMatchObject({ state: 'pending' });
    await expect(provider.status(sale())).resolves.toMatchObject({ state: 'registered' });
    expect(service.invoiceCalls().map((c) => c.method)).toEqual(['GET', 'GET', 'PUT']);
  });

  it.each([
    ['a failure of the service', { status: 500, body: {} }],
    ['too many requests', { status: 429, body: {} }],
    ['a key it does not take', { status: 401, body: {} }],
    ['no answer at all', new TypeError('fetch failed')],
  ])('waits on %s: the service is unavailable', async (_name, answer) => {
    serviceOf({ taxpayerNif: 'B12345674', invoices: [answer as Answer] });

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_UNAVAILABLE',
    });
  });

  // a token the service no longer takes (a key turned off and on, a token cut short) is not kept
  // until it runs out: the next call asks for a new one
  it.each([401, 403])('asks for a new token after a %p', async (status) => {
    const service = serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [{ status, body: {} }, { body: registered() }],
    });

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_UNAVAILABLE',
    });
    await expect(provider.issue(sale())).resolves.toMatchObject({ state: 'registered' });
    expect(service.calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(2);
  });

  it('refuses a document the service says is wrong', async () => {
    serviceOf({
      taxpayerNif: 'B12345674',
      invoices: [
        {
          status: 400,
          body: {
            content: { code: 'E_BAD_REQUEST', message: 'full amount exceeds limit of 3000' },
          },
        },
      ],
    });

    await expect(provider.issue(sale())).rejects.toMatchObject({
      errorCode: 'RECEIPT_PROVIDER_REFUSED',
      details: { status: 400, code: 'E_BAD_REQUEST', message: 'full amount exceeds limit of 3000' },
    });
  });
});
