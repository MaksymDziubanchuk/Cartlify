import { describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { deliveryProvider } from '@providers/delivery/index.js';

import { deliveryHarness } from '../../helpers/providers.js';
import { breakShippyPro, realRequestsMade, realShippyPro } from '../../helpers/shippyPro.js';

// Without service:shippypro the tests check only our code: every request to ShippyPro is answered by
// the mock, none reaches the service, and the key is a made-up one (tests/setup/integration.setup.ts)

const harness = deliveryHarness[deliveryProvider.name];
const quiet = { warn: () => undefined } as never;

(realShippyPro ? describe.skip : describe)('ShippyPro without service:shippypro', () => {
  it('answers the prices, a parcel, its search and its void from the mock, with a made-up key', async () => {
    const box = { weightGrams: 1000, lengthMm: 300, widthMm: 200, heightMm: 100 };
    const request = {
      from: harness.sender,
      to: harness.recipient,
      boxes: [box],
      contents: 'Mock test goods',
      declaredValue: 20,
    };
    const option = (await deliveryProvider.quote(request, quiet)).find(
      (one) => one.carrierName === harness.voidingCarrier,
    )!;
    const reference = `mock-${process.pid}-1`;
    const parcel = await deliveryProvider.createParcel(
      {
        ...request,
        reference,
        option: {
          carrierName: option.carrierName,
          carrierService: option.carrierService,
          connection: option.connection,
        },
        customs: null,
        taxNumber: null,
      },
      quiet,
    );
    expect(await deliveryProvider.findParcel(reference)).toMatchObject({
      parcelId: parcel.parcelId,
    });
    await expect(
      deliveryProvider.voidParcel({ parcelId: parcel.parcelId, carrierName: option.carrierName }),
    ).resolves.toBe('voided');

    expect(realRequestsMade()).toBe(0);
    // compared, not printed: a value of .env must never reach the output
    expect(env.SHIPPYPRO_API_KEY === 'cartlify-tests-shippypro-mock').toBe(true);
  });

  it.each([
    ['an error of the whole request', 'error'],
    ['a page that is no json', 'html'],
    ['json that is no object', 'list'],
  ] as const)('tells %s as the provider unavailable', async (_case, kind) => {
    breakShippyPro(kind);

    await expect(
      deliveryProvider.quote(
        {
          from: harness.sender,
          to: harness.recipient,
          boxes: [{ weightGrams: 1000, lengthMm: 300, widthMm: 200, heightMm: 100 }],
          contents: 'Mock test goods',
          declaredValue: 20,
        },
        quiet,
      ),
    ).rejects.toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
  });
});
