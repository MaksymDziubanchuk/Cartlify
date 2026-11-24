import { beforeAll, describe, expect, it } from '@jest/globals';

import { deliveryProvider } from '@providers/delivery/index.js';
import { isAppError } from '@utils/errors.js';

import { rejectedBy, statusOf } from '../../helpers/errors.js';
import { deliveryHarness } from '../../helpers/providers.js';

import type {
  DeliveryBox,
  DeliveryCarrierChoice,
  DeliveryEventKind,
  DeliveryOption,
  DeliveryParcel,
  DeliveryQuoteRequest,
} from '@providers/delivery/index.js';

// The contract of a delivery provider: what the rest of the app counts on, whoever carries the
// parcels (src/providers/delivery/types.ts). The provider of the server goes through these tests,
// made to answer by its entry in tests/helpers/providers.ts (its mock, or the real service when the
// run takes it: npm test -- service:shippypro). The real service has no sandbox: a parcel is never
// made there (each takes a label of the account), the mock makes it in both modes and every other
// case reads or is refused for free; what the real account cannot be made to do (a carrier that voids, a refusal, another
// currency) is answered by the mock in both modes

const harness = deliveryHarness[deliveryProvider.name];

// a log that keeps what the provider warns about
function watchLog() {
  const warnings: Record<string, unknown>[] = [];
  return {
    log: { warn: (obj: unknown) => void warnings.push(obj as Record<string, unknown>) } as never,
    warnings,
  };
}

const quiet = watchLog().log;

const box = (weightGrams: number): DeliveryBox => ({
  weightGrams,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 100,
});

const request = (over: Partial<DeliveryQuoteRequest> = {}): DeliveryQuoteRequest => ({
  from: harness.sender,
  to: harness.recipient,
  boxes: [box(1000)],
  contents: 'Contract test goods',
  declaredValue: 50,
  ...over,
});

const choiceOf = (option: DeliveryOption): DeliveryCarrierChoice => ({
  carrierName: option.carrierName,
  carrierService: option.carrierService,
  connection: option.connection,
});

async function optionNamed(name: string, over: Partial<DeliveryQuoteRequest> = {}) {
  const options = await deliveryProvider.quote(request(over), quiet);
  const option = options.find((candidate) => candidate.carrierName === name);
  if (!option) throw new Error(`the account of the tests has no carrier ${name} for this parcel`);
  return option;
}

const detailsOf = (err: unknown) =>
  isAppError(err) ? { code: err.errorCode, details: err.details } : { thrown: String(err) };

// a reference no other run has: the parcels of the real account stay there
const reference = (n: number) => `contract-${process.pid}-${n}`;

// the declaration of a parcel abroad: two shirts that hold 8.33 of the tax of the seller together
const CUSTOMS = [
  {
    description: 'Cotton shirt',
    quantity: 2,
    unitValue: 25,
    weightGrams: 400,
    hsCode: '610510',
    originCountry: 'PT',
    sku: 'SHIRT-1',
    tax: 8.33,
  },
];

// a number of the shop that is not of the import scheme (a VAT number of the country of the
// recipient), on the commercial invoice of the order's invoice
const OTHER_NUMBER = { kind: 'other' as const, number: 'GB123456789' };
const INVOICE = { number: 'FV-2026-7', date: new Date('2026-11-20T10:00:00Z') };

const isPdf = (file: Buffer) => file.subarray(0, 5).toString('latin1') === '%PDF-';

describe(`the delivery provider ${deliveryProvider.name}`, () => {
  it('is configured with its key, and is not without it', async () => {
    expect(deliveryProvider.isConfigured()).toBe(true);
    await harness.withoutKey(async () => {
      expect(deliveryProvider.isConfigured()).toBe(false);
      const err = await rejectedBy(() => deliveryProvider.quote(request(), quiet));
      expect(detailsOf(err)).toEqual({
        code: 'INTERNAL_ERROR',
        details: { reason: 'DELIVERY_PROVIDER_NOT_CONFIGURED' },
      });
    });
  });

  describe('prices', () => {
    it('gives the carriers that take the parcel, the cheapest first, in our words', async () => {
      const { log, warnings } = watchLog();

      const options = await deliveryProvider.quote(request(), log);

      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(option).toEqual({
          carrierName: expect.any(String),
          carrierService: expect.any(String),
          connection: expect.stringMatching(/^\S+$/),
          price: expect.any(Number),
          days: option.days === null ? null : expect.any(String),
          label: expect.any(String),
        });
        expect(option.price).toBeGreaterThanOrEqual(0);
      }
      const prices = options.map((option) => option.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      expect(options.map((option) => option.carrierName)).toContain(harness.steadyCarrier);
      // the request had every field the provider checks: no suggestions came back
      expect(warnings).toEqual([]);
    });

    it('leaves out a carrier that has no price for the weight', async () => {
      const options = await deliveryProvider.quote(request({ boxes: [box(600_000)] }), quiet);

      expect(options.map((option) => option.carrierName)).not.toContain(harness.steadyCarrier);
    });

    (harness.pricesInOtherCurrency ? it : it.skip)(
      'leaves out a carrier that prices in another currency than the shop, and warns',
      async () => {
        const before = await deliveryProvider.quote(request(), quiet);
        harness.pricesInOtherCurrency!();
        const { log, warnings } = watchLog();

        const options = await deliveryProvider.quote(request(), log);

        expect(options.length).toBe(before.length - 1);
        expect(warnings).toHaveLength(1);
        // the warning names the carrier and the currency, nothing of the parcel or its people
        expect(JSON.stringify(warnings[0])).not.toMatch(/Madrid|Recipient|Mayor/);
      },
    );

    it('tells a provider that does not answer as unavailable', async () => {
      const err = await harness.outOfReach(() =>
        rejectedBy(() => deliveryProvider.quote(request(), quiet)),
      );

      expect(statusOf(err)).toBe(503);
      expect(detailsOf(err)).toMatchObject({ code: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    });
  });

  describe('parcels', () => {
    let made: DeliveryParcel;
    let carrier: DeliveryOption;
    const ref = reference(1);

    // the one parcel of a run: two boxes abroad, with the lines of the declaration
    beforeAll(async () => {
      carrier = await optionNamed(harness.steadyCarrier, {
        to: harness.abroad,
        boxes: [box(1000), box(500)],
      });
      made = await deliveryProvider.createParcel(
        {
          ...request({ to: harness.abroad, boxes: [box(1000), box(500)] }),
          reference: ref,
          option: choiceOf(carrier),
          customs: CUSTOMS,
          taxNumber: null,
        },
        quiet,
      );
    });

    it('makes a parcel with a label, a box for each box given, and its price as the cost', () => {
      expect(made.parcelId).toMatch(/^\d+$/);
      expect(made.labelUrl).toMatch(/^https:\/\//);
      expect(made.boxes).toHaveLength(2);
      expect(made.cost).toBe(carrier.price);
      if (made.trackingUrl !== null) expect(made.trackingUrl).toMatch(/^https:\/\//);
      if (made.trackingNumber === null) expect(made.trackingUrl).toBeNull();
    });

    it('finds the parcel made for our number, and none for another number', async () => {
      const found = await deliveryProvider.findParcel(ref);

      expect(found).toMatchObject({
        parcelId: made.parcelId,
        trackingNumber: made.trackingNumber,
        cost: made.cost,
      });
      expect(found!.labelUrl).toMatch(/^https:\/\//);
      expect(await deliveryProvider.findParcel(reference(999))).toBeNull();
    });

    it('does not void a parcel of a carrier that cannot be asked to', async () => {
      await expect(
        deliveryProvider.voidParcel({
          parcelId: made.parcelId,
          carrierName: carrier.carrierName,
        }),
      ).resolves.toBe('unsupported');
    });

    (harness.voidingCarrier ? it : it.skip)(
      'voids a parcel of a carrier that can, and no longer finds it',
      async () => {
        const voiding = await optionNamed(harness.voidingCarrier!);
        const parcel = await deliveryProvider.createParcel(
          {
            ...request(),
            reference: reference(2),
            option: choiceOf(voiding),
            customs: null,
            taxNumber: null,
          },
          quiet,
        );
        // a number a box when the carrier gives one
        expect(parcel.boxes).toHaveLength(1);

        await expect(
          deliveryProvider.voidParcel({
            parcelId: parcel.parcelId,
            carrierName: voiding.carrierName,
          }),
        ).resolves.toBe('voided');

        await expect(harness.keepsLive(parcel.parcelId)).resolves.toBe(false);
        expect(await deliveryProvider.findParcel(reference(2))).toBeNull();
      },
    );

    (harness.refuseNext ? it : it.skip)(
      'tells a refusal of the carrier in its words, and makes nothing',
      async () => {
        harness.refuseNext!('No street found');
        const option = await optionNamed(harness.steadyCarrier);

        const err = await rejectedBy(() =>
          deliveryProvider.createParcel(
            {
              ...request(),
              reference: reference(3),
              option: choiceOf(option),
              customs: null,
              taxNumber: null,
            },
            quiet,
          ),
        );

        expect(statusOf(err)).toBe(409);
        expect(detailsOf(err)).toEqual({
          code: 'DELIVERY_PARCEL_REFUSED',
          details: { message: 'No street found' },
        });
        expect(await deliveryProvider.findParcel(reference(3))).toBeNull();
      },
    );

    it('refuses a parcel the carrier has no price for, before asking for a label', async () => {
      const option = await optionNamed(harness.steadyCarrier);

      const err = await rejectedBy(() =>
        deliveryProvider.createParcel(
          {
            ...request({ boxes: [box(600_000)] }),
            reference: reference(4),
            option: choiceOf(option),
            customs: null,
            taxNumber: null,
          },
          quiet,
        ),
      );

      expect(detailsOf(err)).toEqual({
        code: 'DELIVERY_PARCEL_REFUSED',
        details: { message: expect.any(String) },
      });
    });

    it('makes a parcel with the number of the import scheme of the shop, and one without', async () => {
      const option = await optionNamed(harness.steadyCarrier, { to: harness.abroad });
      const parcel = await deliveryProvider.createParcel(
        {
          ...request({ to: harness.abroad }),
          reference: reference(6),
          option: choiceOf(option),
          customs: CUSTOMS,
          taxNumber: { kind: 'ioss', number: 'IM2500000001' },
        },
        quiet,
      );

      expect(parcel.parcelId).toMatch(/^\d+$/);
      const papers = harness.parcelPapers(parcel.parcelId);
      if (papers) expect(papers.ioss).toBe('IM2500000001');
      const without = harness.parcelPapers(made.parcelId);
      if (without) expect(without.ioss).toBeNull();
    });

    it('tells which carriers take the customs papers electronically', async () => {
      await expect(deliveryProvider.takesDocuments(harness.steadyCarrier)).resolves.toBe(false);
      await expect(deliveryProvider.takesDocuments('No such carrier')).resolves.toBe(false);
      if (harness.documentsCarrier) {
        await expect(deliveryProvider.takesDocuments(harness.documentsCarrier)).resolves.toBe(true);
      }
    });

    it('draws the commercial invoice of a parcel with the tax number of the shop, a pdf', async () => {
      const file = await deliveryProvider.customsInvoice(
        {
          ...request({ to: harness.abroad, boxes: [box(1000), box(500)] }),
          reference: ref,
          option: choiceOf(carrier),
          customs: CUSTOMS,
          taxNumber: OTHER_NUMBER,
          parcelId: made.parcelId,
          invoice: INVOICE,
        },
        false,
        quiet,
      );

      expect(isPdf(file)).toBe(true);
      const papers = harness.parcelPapers(made.parcelId);
      if (papers) expect(papers.invoices.at(-1)).toEqual({ electronic: false });
    });

    it('refuses to send the invoice electronically with a carrier that does not take it', async () => {
      const err = await rejectedBy(() =>
        deliveryProvider.customsInvoice(
          {
            ...request({ to: harness.abroad, boxes: [box(1000), box(500)] }),
            reference: ref,
            option: choiceOf(carrier),
            customs: CUSTOMS,
            taxNumber: OTHER_NUMBER,
            parcelId: made.parcelId,
            invoice: INVOICE,
          },
          true,
          quiet,
        ),
      );

      expect(statusOf(err)).toBe(409);
      expect(detailsOf(err)).toEqual({
        code: 'DELIVERY_PARCEL_REFUSED',
        details: { message: expect.any(String) },
      });
    });

    (harness.documentsCarrier ? it : it.skip)(
      'sends the invoice electronically with a carrier that takes it',
      async () => {
        const option = await optionNamed(harness.documentsCarrier!, { to: harness.abroad });
        const parcelRequest = {
          ...request({ to: harness.abroad }),
          reference: reference(7),
          option: choiceOf(option),
          customs: CUSTOMS,
          taxNumber: OTHER_NUMBER,
        };
        const parcel = await deliveryProvider.createParcel(parcelRequest, quiet);

        const file = await deliveryProvider.customsInvoice(
          { ...parcelRequest, parcelId: parcel.parcelId, invoice: INVOICE },
          true,
          quiet,
        );

        expect(isPdf(file)).toBe(true);
        const papers = harness.parcelPapers(parcel.parcelId);
        if (papers) expect(papers).toEqual({ ioss: null, invoices: [{ electronic: true }] });
      },
    );

    it('tells a provider that does not answer an invoice as unavailable', async () => {
      const err = await harness.outOfReach(() =>
        rejectedBy(() =>
          deliveryProvider.customsInvoice(
            {
              ...request({ to: harness.abroad }),
              reference: ref,
              option: choiceOf(carrier),
              customs: CUSTOMS,
              taxNumber: OTHER_NUMBER,
              parcelId: made.parcelId,
              invoice: INVOICE,
            },
            false,
            quiet,
          ),
        ),
      );

      expect(detailsOf(err)).toMatchObject({ code: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    });

    it('tells a provider that does not answer a creation as unavailable', async () => {
      const option = await optionNamed(harness.steadyCarrier);

      const err = await harness.outOfReach(() =>
        rejectedBy(() =>
          deliveryProvider.createParcel(
            {
              ...request(),
              reference: reference(5),
              option: choiceOf(option),
              customs: null,
              taxNumber: null,
            },
            quiet,
          ),
        ),
      );

      expect(detailsOf(err)).toMatchObject({ code: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    });
  });

  describe('the webhook', () => {
    const { webhook } = deliveryProvider;
    const parcel = { parcelId: '383400123', reference: '42-1', trackingNumber: 'MX383400123' };

    it('takes a request of the provider, and tells one without or with another secret', () => {
      expect(webhook.check({ headers: harness.webhookHeaders('own') })).toEqual({
        verdict: 'valid',
      });
      expect(webhook.check({ headers: harness.webhookHeaders('none') })).toEqual({
        verdict: 'missing',
      });
      expect(webhook.check({ headers: harness.webhookHeaders('other') })).toMatchObject({
        verdict: 'invalid',
      });
    });

    it('takes nothing while the server has no secret to check with', () => {
      const verdict = harness.withoutWebhookSecret(() =>
        webhook.check({ headers: harness.webhookHeaders('own') }),
      );

      expect(verdict).toMatchObject({ verdict: 'unavailable' });
    });

    it.each([
      'created',
      'failed',
      'collected',
      'delivered',
      'returning',
      'returned',
      'lost',
    ] as DeliveryEventKind[])('reads the event %s in our words', (kind) => {
      const at = new Date('2026-11-14T10:00:00Z');

      const events = webhook.readEvents(harness.eventBody(kind, parcel, at));

      expect(events).toEqual([
        {
          parcelId: parcel.parcelId,
          reference: parcel.reference,
          kind,
          at: expect.any(Date),
          trackingNumber: kind === 'failed' ? null : parcel.trackingNumber,
          refused: false,
        },
      ]);
      if (!['created', 'failed'].includes(kind)) expect(events![0]!.at).toEqual(at);
    });

    it('drops an event the shop does not act on, and tells a body that is no event', () => {
      expect(webhook.readEvents(harness.eventBody('dropped', parcel))).toEqual([]);
      expect(webhook.readEvents({ hello: 'world' })).toBeNull();
      expect(webhook.readEvents([])).toBeNull();
    });

    it('answers with a json object', () => {
      expect(webhook.answer).toEqual(expect.any(Object));
      expect(JSON.parse(JSON.stringify(webhook.answer))).toEqual(webhook.answer);
    });
  });
});
