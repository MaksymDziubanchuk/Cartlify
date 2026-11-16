import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrderOf, shippingCostOf } from '../../../helpers/orders.js';

// the parcels and the boxes of a manual order (decisions 19, 22, 23 of the delivery): the step to
// shipped takes several parcels, each with its boxes and what is in them, all the units that travel
// laid out; the one parcel of an order may come without boxes (one box of every unit). The buyer sees
// every parcel on its way and the mail names each; a step back takes every parcel back

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

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const SIZED = { weightGrams: 400, sizesMm: { length: 300, width: 200, height: 50 } };

// a paid order of a buyer: two mugs and a lamp; the items of the order
async function paidOrder(opts: { sized?: boolean } = {}) {
  const buyer = await createUser();
  userIds.push(buyer.id);
  const mug = await createProduct({ price: 10, stock: 5, ...(opts.sized === false ? {} : SIZED) });
  const lamp = await createProduct({ price: 30, stock: 5, ...SIZED });
  const orderId = await placeOrderOf(
    app,
    csrf,
    buyer,
    [
      { item: mug, quantity: 2 },
      { item: lamp, quantity: 1 },
    ],
    'paid',
  );
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, quantity: true },
    }),
  );
  return { buyer, orderId, mugItem: items[0]!.id, lampItem: items[1]!.id };
}

const setStatus = (orderId: number, status: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status, ...extra },
  });

const box = (items: { orderItemId: number; quantity: number }[], sized = true) => ({
  ...(sized ? { weightGrams: 900, lengthMm: 310, widthMm: 210, heightMm: 120 } : {}),
  items,
});

describe('the parcels of a manual order', () => {
  it('ships an order in two parcels with their boxes, the buyer and the mail see both', async () => {
    const { buyer, orderId, mugItem, lampItem } = await paidOrder();
    const mails = watchMail();

    const res = await setStatus(orderId, 'shipped', {
      shipments: [
        {
          carrier: 'DHL',
          trackingNumber: 'DHL-1',
          trackingUrl: 'https://track.example.com/DHL-1',
          cost: 6,
          boxes: [
            box([{ orderItemId: mugItem, quantity: 1 }]),
            box([{ orderItemId: mugItem, quantity: 1 }]),
          ],
        },
        {
          carrier: 'UPS',
          trackingNumber: 'UPS-2',
          cost: 9,
          boxes: [box([{ orderItemId: lampItem, quantity: 1 }], false)],
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const shipments = res.json().shipments as {
      id: number;
      carrier: string;
      state: string;
      boxes: { number: number; weightGrams: number | null; items: unknown[] }[];
    }[];
    expect(shipments.map((one) => [one.carrier, one.state, one.boxes.length])).toEqual([
      ['UPS', 'sent', 1],
      ['DHL', 'sent', 2],
    ]);
    expect(shipments[1]!.boxes.map((one) => one.number)).toEqual([1, 2]);
    expect(shipments[0]!.boxes[0]).toMatchObject({
      weightGrams: null,
      items: [{ orderItemId: lampItem, quantity: 1 }],
    });
    expect(await shippingCostOf(shipments[1]!.id)).toBe(6);
    expect(await shippingCostOf(shipments[0]!.id)).toBe(9);

    const asBuyer = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });
    expect(asBuyer.json().delivery.shipments).toEqual([
      {
        carrier: 'DHL',
        trackingNumber: 'DHL-1',
        trackingUrl: 'https://track.example.com/DHL-1',
        state: 'sent',
      },
      { carrier: 'UPS', trackingNumber: 'UPS-2', trackingUrl: null, state: 'sent' },
    ]);
    // the buyer never sees how the shop packed
    expect(asBuyer.json()).not.toHaveProperty('shipments');

    const [mail] = mails;
    expect(mail!.text).toContain('Parcel 1');
    expect(mail!.text).toContain('DHL-1');
    expect(mail!.text).toContain('Parcel 2');
    expect(mail!.text).toContain('UPS-2');
  });

  it('puts every unit of the one parcel given without boxes in one box, with the weight and sizes', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await setStatus(orderId, 'shipped', { shipments: [{ carrier: 'DHL' }] });

    expect(res.statusCode).toBe(200);
    // the weights summed, the biggest length and width, the heights stacked
    expect(res.json().shipments[0].boxes).toEqual([
      {
        number: 1,
        weightGrams: 1200,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 150,
        trackingNumber: null,
        labelUrl: null,
        items: [
          { orderItemId: mugItem, quantity: 2 },
          { orderItemId: lampItem, quantity: 1 },
        ],
      },
    ]);
  });

  it('gives the one box no weight or sizes when a variant has none, and makes one parcel of no body', async () => {
    const { orderId } = await paidOrder({ sized: false });

    const res = await setStatus(orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments).toHaveLength(1);
    expect(res.json().shipments[0].boxes[0]).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it.each([
    [
      'two parcels without their boxes',
      (() => [{ carrier: 'DHL' }, { carrier: 'UPS' }]) as (mug: number, lamp: number) => unknown[],
    ],
    [
      'boxes that leave a unit out',
      (mug: number, lamp: number) => [
        {
          boxes: [
            box([
              { orderItemId: mug, quantity: 1 },
              { orderItemId: lamp, quantity: 1 },
            ]),
          ],
        },
      ],
    ],
    [
      'boxes that hold a unit more',
      (mug: number, lamp: number) => [
        {
          boxes: [
            box([
              { orderItemId: mug, quantity: 3 },
              { orderItemId: lamp, quantity: 1 },
            ]),
          ],
        },
      ],
    ],
  ])('refuses %s and ships nothing', async (_case, shipmentsOf) => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await setStatus(orderId, 'shipped', { shipments: shipmentsOf(mugItem, lampItem) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PARCEL_ITEMS_MISMATCH' });
    const order = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    );
    expect(order.status).toBe('paid');
  });

  it('names the item that does not add up', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await setStatus(orderId, 'shipped', {
      shipments: [{ boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] }],
    });

    expect(res.json().details).toEqual({ items: [{ orderItemId: mugItem, units: 2, packed: 0 }] });
  });

  it('refuses a box with some of its sizes only', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await setStatus(orderId, 'shipped', {
      shipments: [
        {
          boxes: [
            {
              weightGrams: 900,
              items: [
                { orderItemId: mugItem, quantity: 2 },
                { orderItemId: lampItem, quantity: 1 },
              ],
            },
          ],
        },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_BOX_SIZES_INVALID' });
  });

  it('takes every parcel back with the step back, their costs to nothing', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    const shipped = await setStatus(orderId, 'shipped', {
      shipments: [
        { carrier: 'DHL', cost: 6, boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { carrier: 'UPS', cost: 9, boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    });
    const ids = (shipped.json().shipments as { id: number }[]).map((one) => one.id);

    const back = await setStatus(orderId, 'paid', { keepShippingCost: false });

    expect(back.statusCode).toBe(200);
    expect(
      (back.json().shipments as { rolledBackAt: string | null; expense: boolean }[]).map((one) => [
        one.rolledBackAt !== null,
        one.expense,
      ]),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
    for (const id of ids) expect(await shippingCostOf(id)).toBe(0);
    expect(back.json().delivery.shipments).toEqual([]);
  });
});
