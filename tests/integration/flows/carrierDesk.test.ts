import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { CARRIER_SHOP, MADRID, SIZED, carrierOrder } from '../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';
import { MOCK_CARRIERS, useCarriers } from '../../helpers/shippyPro.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// The desk of an admin for the orders of a carrier, as the admin walks it: the parcels of several
// orders made at once, one made wrong voided and made again, a carrier that is gone replaced by one
// of the list of now, and the order moved by hand when no event of the carrier comes. Each step
// takes what the step before answered; the rules of each route are in api/orders/parcels.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterEach(resetShopSettings);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const as = (user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(user)),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

describe('the desk of the orders of a carrier', () => {
  it('makes the parcels of two orders at once, makes one again by another carrier, and moves it by hand to the buyer', async () => {
    setShopSettings(CARRIER_SHOP);
    const mug = await createProduct({ price: 10, stock: 10, ...SIZED });
    // an address of their own: the prices of the carriers are kept five minutes for an address
    const address = { ...MADRID, house: '57' };
    const first = await carrierOrder(app, csrf, [{ variantId: mug.variantId, quantity: 1 }], {
      address,
    });
    const second = await carrierOrder(app, csrf, [{ variantId: mug.variantId, quantity: 2 }], {
      address,
    });
    userIds.push(first.buyer.id, second.buyer.id);

    // both wait for their parcels on the desk
    const waiting = await as(admin, 'GET', '/api/orders?parcels=none&statuses=paid&limit=100');
    expect(waiting.statusCode).toBe(200);
    const ids = (waiting.json().items as { id: number }[]).map((one) => one.id);
    expect(ids).toEqual(expect.arrayContaining([first.orderId, second.orderId]));

    // the parcels of both by their drafts
    const made = await as(admin, 'POST', '/api/orders/parcels', {
      orderIds: [first.orderId, second.orderId],
    });
    expect(made.statusCode).toBe(200);
    expect((made.json().results as { ok: boolean }[]).every((one) => one.ok)).toBe(true);

    // the parcel of the second was made wrong: voided (its carrier voids at once), and the order
    // waits for its parcels again
    const voided = await as(admin, 'POST', `/api/orders/${second.orderId}/parcels/void`, {});
    expect(voided.statusCode).toBe(200);
    expect(voided.json().shipments[0]).toMatchObject({ state: 'voided' });

    // meanwhile the owner disconnected the carrier the buyer picked: the admin takes another one
    // of the list of now
    useCarriers(MOCK_CARRIERS.filter((one) => one.name !== 'MockExpress'));
    const carriers = await as(admin, 'GET', `/api/orders/${second.orderId}/carriers`);
    expect(carriers.statusCode).toBe(200);
    const [other] = carriers.json().carriers as { carrier: { name: string } }[];
    expect(other!.carrier.name).toBe('Generic');
    const picked = await as(admin, 'PATCH', `/api/orders/${second.orderId}/delivery`, {
      carrier: other!.carrier,
    });
    expect(picked.statusCode).toBe(200);

    const again = await as(admin, 'POST', `/api/orders/${second.orderId}/parcels`, {});
    expect(again.statusCode).toBe(200);
    const parcelId = again.json().made[0] as number;

    // no event of the carrier comes: the admin moves the order by hand
    const shipped = await as(admin, 'PATCH', `/api/orders/${second.orderId}/status`, {
      status: 'shipped',
    });
    expect(shipped.statusCode).toBe(200);
    const delivered = await as(admin, 'PATCH', `/api/orders/${second.orderId}/status`, {
      status: 'delivered',
    });
    expect(delivered.statusCode).toBe(200);

    // the buyer sees the order delivered by the carrier the admin picked, at the price they paid
    const seen = await as(second.buyer, 'GET', `/api/orders/${second.orderId}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      status: 'delivered',
      delivery: {
        method: 'carrier',
        price: 6.5,
        shipments: [expect.objectContaining({ carrier: 'Generic', state: 'delivered' })],
      },
    });

    // one live parcel of the order, the voided one kept as history
    const states = await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId: second.orderId },
        orderBy: { id: 'asc' },
        select: { id: true, state: true },
      }),
    );
    expect(states).toEqual([
      { id: expect.any(Number), state: 'voided' },
      { id: parcelId, state: 'delivered' },
    ]);
  });
});
