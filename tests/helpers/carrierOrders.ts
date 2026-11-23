import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { createUser, type TestUser } from './factories.js';
import { payOrder } from './orders.js';
import { steadyCarrierChoice } from './shippyPro.js';

import type { ShopSettingsValues } from '@config/shopSettings.js';

// An order of a carrier of the delivery provider, the way a buyer makes one: the cart, the prices of
// the carriers for the address (POST /api/orders/current/delivery-options), the confirmation with the
// carrier picked, the payment. The provider is the mock of the tests (tests/helpers/shippyPro.ts):
// Generic at 4 up to 5 kg and 10 up to 500, MockExpress at 6.5 up to 2 kg and 12 up to 30 (a number a
// box, a void)

export const SENDER = {
  name: 'Cartlify Shop',
  street: 'Calle de la Paz',
  house: '1',
  apartment: null,
  city: 'Valencia',
  postalCode: '46003',
  country: 'ES',
  phone: '+34960000000',
  email: 'shop@example.com',
};

// a shop that sends by hand and by carriers to Spain (5 by hand), the countries of the tests by
// hand for nothing; free of customs: the countries of its zones
export const CARRIER_SHOP: Partial<ShopSettingsValues> = {
  deliveryMethods: ['manual', 'pickup', 'carrier'],
  deliveryZones: [
    { name: 'Spain', countries: ['ES'], manualPrice: 5, freeFrom: null },
    { name: 'Test zone', countries: ['UA', 'PL', 'DE', 'GB'], manualPrice: 0, freeFrom: null },
  ],
  deliverySender: SENDER,
};

export const MADRID = {
  country: 'ES',
  postalCode: '28013',
  city: 'Madrid',
  street: 'Calle Mayor',
  house: '1',
};

// the carriers of the tests: Generic of the real account in the real mode (its id is the account's),
// MockExpress of the mock in both (tests/helpers/shippyPro.ts)
export const CARRIERS = {
  get Generic() {
    return steadyCarrierChoice();
  },
  MockExpress: { name: 'MockExpress', service: 'Express', connection: '7001' },
};

// what a carrier needs of a variant: its weight and its sizes
export const SIZED = { weightGrams: 400, sizesMm: { length: 300, width: 200, height: 50 } };

// an order of a new buyer by the carrier, taken to the stage: waiting for its payment, or paid
export async function carrierOrder(
  app: FastifyInstance,
  csrf: Csrf,
  items: { variantId: number; quantity: number }[],
  // an address of its own: the prices of the carriers are kept five minutes for an address and a
  // box, a test that changes the carriers of the mock keeps its prices away from the others
  opts: {
    carrier?: keyof typeof CARRIERS;
    stage?: 'waiting' | 'paid';
    address?: typeof MADRID;
  } = {},
): Promise<{ buyer: TestUser; orderId: number }> {
  const buyer = await createUser();
  const headers = withCsrf(csrf, accessCookie(buyer));

  let orderId = 0;
  for (const item of items) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers,
      payload: item,
    });
    if (res.statusCode !== 200) throw new Error(`adding to the cart answered ${res.statusCode}`);
    orderId = res.json().id;
  }

  const carrier = CARRIERS[opts.carrier ?? 'MockExpress'];
  const options = await app.inject({
    method: 'POST',
    url: '/api/orders/current/delivery-options',
    headers,
    payload: { address: opts.address ?? MADRID },
  });
  const line = (
    options.json().options as {
      carrier: { name: string; service: string; connection: string } | null;
      price: number;
    }[]
  ).find((one) => one.carrier?.name === carrier.name);
  if (!line) {
    // what the list gave instead: why it has no carrier, and the carriers it has
    const body = options.json() as {
      carriersUnavailable?: string | null;
      options?: { carrier: { name: string } | null }[];
    };
    throw new Error(
      `the prices have no ${carrier.name}: ${options.statusCode} ${JSON.stringify({
        unavailable: body.carriersUnavailable,
        carriers: body.options?.flatMap((one) => (one.carrier ? [one.carrier.name] : [])),
      })}`,
    );
  }

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers,
    payload: {
      orderId,
      expectedDeliveryPrice: line.price,
      delivery: {
        method: 'carrier',
        recipientFirstName: 'Ana',
        recipientLastName: 'Garcia',
        recipientPhone: '+34910000000',
        address: opts.address ?? MADRID,
        // the carrier as the list of the prices gave it to the buyer
        carrier: line.carrier,
      },
    },
  });
  if (confirmed.statusCode !== 200) {
    throw new Error(`confirming the order answered ${confirmed.statusCode}`);
  }

  if (opts.stage !== 'waiting') await payOrder(orderId);
  return { buyer, orderId };
}
