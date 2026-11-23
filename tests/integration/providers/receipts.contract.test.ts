import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  RECEIPT_PROVIDER_NAMES,
  type ReceiptAnswer,
  type ReceiptRequest,
} from '@providers/receipts/index.js';

import { rejectedBy } from '../../helpers/errors.js';
import { receiptHarness, type ReceiptHarness } from '../../helpers/providers.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// The contract of a provider of fiscal receipts: what the worker of the receipts counts on, whoever
// registers them (src/providers/receipts/types.ts). Each provider that makes receipts goes through
// these tests, made to answer by its entry in tests/helpers/providers.ts (its mock, or the real
// service when the run takes it: fiskaly in TEST, its tax authority of the test); another provider
// passes them without tests of its own. Every test names a series of its own: a number is taken
// once at the service, in every run

const makers = RECEIPT_PROVIDER_NAMES.filter((name) => receiptHarness[name] !== null);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const seriesOf = () => `C${randomBytes(3).toString('hex').toUpperCase()}`;

// a sale of 2 units of 10 with 21 % (3.47 of 20) and a delivery of 5 (0.87)
const saleOf = (series: string, over: Partial<ReceiptRequest> = {}): ReceiptRequest => ({
  key: `${series}-1`,
  kind: 'sale',
  series,
  number: 1,
  issuedAt: new Date(),
  currency: 'EUR',
  taxRule: 'seller',
  taxCountry: 'ES',
  lines: [
    { name: 'T-shirt', quantity: 2, rate: 21, net: 16.53, tax: 3.47, gross: 20 },
    { name: 'Delivery', quantity: null, rate: 21, net: 4.13, tax: 0.87, gross: 5 },
  ],
  gross: 25,
  correctsKey: null,
  ...over,
});

// a correction of the sale: 5 of its goods back (0.87 of tax), or that money come back
const correctionOf = (series: string, kind: 'return' | 'reversal', sale: ReceiptRequest) => {
  const sign = kind === 'return' ? -1 : 1;
  return saleOf(series, {
    key: `${series}-1`,
    kind,
    lines: [
      {
        name: 'T-shirt',
        quantity: null,
        rate: 21,
        net: sign * 4.13,
        tax: sign * 0.87,
        gross: sign * 5,
      },
    ],
    gross: sign * 5,
    correctsKey: sale.key,
  });
};

describe.each(makers)('the receipts of %s', (name) => {
  const harness = receiptHarness[name] as ReceiptHarness;
  const provider = harness.provider;

  // the answer once the service registered a receipt it took: asked again until it says so (the
  // tax authority of the test takes from seconds to minutes)
  async function registeredOf(request: ReceiptRequest, taken: ReceiptAnswer) {
    let answer = taken;
    for (let tries = 0; answer.state === 'pending' && tries < 100; tries += 1) {
      if (harness.real) await sleep(3000);
      answer = await provider.status(request);
    }
    return answer;
  }

  const registered = async (request: ReceiptRequest) =>
    registeredOf(request, await provider.issue(request));

  beforeAll(() => {
    setShopSettings(harness.shop);
  });

  afterAll(() => {
    resetShopSettings();
  });

  it('makes receipts, is turned on by its keys, and names the countries and the moment it serves', () => {
    expect(provider.makesReceipts()).toBe(true);
    expect(provider.isConfigured()).toBe(true);
    const countries = provider.sellerCountries();
    expect(countries === null || countries.includes(String(harness.shop.sellerCountry))).toBe(true);
    expect([null, 'payment', 'shipment']).toContain(provider.fixedMoment());
  });

  it(
    'takes a sale and registers it, with its number, its link, its code and its text',
    async () => {
      const answer = await registered(saleOf(seriesOf()));

      expect(answer).toMatchObject({
        state: 'registered',
        number: expect.any(String),
        url: expect.stringMatching(/^https:\/\//),
      });
      expect(answer.code === null || typeof answer.code === 'string').toBe(true);
      expect(answer.text === null || typeof answer.text === 'string').toBe(true);
    },
    harness.wait,
  );

  it(
    'answers a sale it was given again the same way, without a second one',
    async () => {
      const sale = saleOf(seriesOf());

      const first = await provider.issue(sale);
      const again = await provider.issue(sale);

      expect(again.state === 'pending' || again.state === 'registered').toBe(true);
      expect(['pending', 'registered']).toContain(first.state);
      const done = await registered(sale);
      expect(done.state).toBe('registered');
    },
    harness.wait,
  );

  it(
    'registers a return of a sale, and the money of a return that came back',
    async () => {
      // a correction goes once the service took the sale; all three are registered after
      const sale = saleOf(seriesOf());
      const back = correctionOf(seriesOf(), 'return', sale);
      const again = correctionOf(seriesOf(), 'reversal', sale);
      const taken = [
        await provider.issue(sale),
        await provider.issue(back),
        await provider.issue(again),
      ];

      const answers = await Promise.all(
        [sale, back, again].map((request, i) => registeredOf(request, taken[i]!)),
      );

      expect(answers.map((answer) => answer.state)).toEqual([
        'registered',
        'registered',
        'registered',
      ]);
    },
    harness.wait,
  );

  // a line of 96.80, a tax of 16.13 in it: past the 10 the tax authority lets the total of the
  // record differ by, so a tax of another country taken into the total is refused
  it.each([
    [
      'the VAT of another country of the EU',
      { taxRule: 'recipient' as const, taxCountry: 'FR' },
      20,
    ],
    [
      'the tax of a country out of the EU the shop took',
      { taxRule: 'recipient' as const, taxCountry: 'GB' },
      20,
    ],
    ['no VAT out of the EU', { taxRule: 'none' as const, taxCountry: 'US' }, null],
    [
      'the VAT the buyer pays on receipt',
      { taxRule: 'buyer_at_receipt' as const, taxCountry: 'GB' },
      null,
    ],
    ['no VAT in another country of the EU', { taxRule: 'none' as const, taxCountry: 'DE' }, null],
  ])(
    'registers a sale under %s',
    async (_name, rule, rate) => {
      const tax = rate === null ? 0 : 16.13;
      const answer = await registered(
        saleOf(seriesOf(), {
          ...rule,
          lines: [{ name: 'Lamp', quantity: 4, rate, net: 96.8 - tax, tax, gross: 96.8 }],
          gross: 96.8,
        }),
      );

      expect(answer.state).toBe('registered');
    },
    harness.wait,
  );

  it('refuses a receipt the tax authority refuses, as RECEIPT_PROVIDER_REFUSED', async () => {
    if (!harness.refuseNext) return;
    harness.refuseNext();

    const refusal = await rejectedBy(() => registered(saleOf(seriesOf())));

    expect(refusal).toMatchObject({ errorCode: 'RECEIPT_PROVIDER_REFUSED' });
  });

  it.each(['down' as const, 'unauthorized' as const])(
    'waits when the service is %s: RECEIPT_PROVIDER_UNAVAILABLE',
    async (kind) => {
      harness.outOfReach(kind);

      expect(await rejectedBy(() => provider.issue(saleOf(seriesOf())))).toMatchObject({
        errorCode: 'RECEIPT_PROVIDER_UNAVAILABLE',
      });
    },
  );
});
