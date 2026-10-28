import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

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
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail } from '../../../helpers/mail.js';
import { deliveryAnswer, deliveryBody, placeOrder } from '../../../helpers/orders.js';

// PATCH /api/orders/:orderId/delivery: a buyer writes to the shop that the apartment is wrong; until
// the order is sent an admin corrects the person and the address. The method and the price stay: a
// buyer who wants another method cancels and orders again. The change goes to the admin log and the
// buyer is mailed

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const { address: _address, ...person } = deliveryBody;
const pickupBody = { ...person, method: 'pickup' };

const paidOrder = async (buyer?: TestUser, delivery: Record<string, unknown> = deliveryBody) =>
  placeOrder(
    app,
    csrf,
    buyer ?? (await newUser()),
    await createProduct({ price: 10, stock: 5 }),
    'paid',
    1,
    delivery,
  );

const edit = (
  orderId: number | string,
  payload: Record<string, unknown>,
  actor: TestUser = admin,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/delivery`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const deliveryOf = (orderId: number) =>
  asAdmin((tx) => tx.orderDelivery.findUniqueOrThrow({ where: { orderId } }));

const linesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, action: 'ORDER_DELIVERY_CHANGE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

describe('PATCH /api/orders/:orderId/delivery', () => {
  it('corrects the apartment and the note of a paid order and answers with the delivery', async () => {
    const orderId = await paidOrder();

    const res = await edit(orderId, {
      address: { ...deliveryBody.address, apartment: '12' },
      note: 'Ring twice.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'paid',
      delivery: {
        ...deliveryAnswer,
        address: { ...deliveryAnswer.address, apartment: '12' },
        note: 'Ring twice.',
      },
    });
    expect(await deliveryOf(orderId)).toMatchObject({ apartment: '12', note: 'Ring twice.' });
  });

  it('corrects the recipient alone and leaves the address as it was', async () => {
    const orderId = await paidOrder();

    const res = await edit(orderId, { recipientFirstName: 'Olha', recipientPhone: '+12025550123' });

    expect(res.statusCode).toBe(200);
    expect(await deliveryOf(orderId)).toMatchObject({
      recipientFirstName: 'Olha',
      recipientLastName: 'Koval',
      recipientPhone: '+12025550123',
      city: 'Kyiv',
      street: 'Test street',
    });
  });

  it('replaces the whole address when one is sent, the postal code in the form of its country', async () => {
    const orderId = await paidOrder();

    const res = await edit(orderId, {
      address: {
        country: 'PL',
        postalCode: '00950',
        city: 'Warsaw',
        street: 'Marszalkowska',
        house: '10',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await deliveryOf(orderId)).toMatchObject({
      country: 'PL',
      postalCode: '00-950',
      city: 'Warsaw',
      street: 'Marszalkowska',
      house: '10',
      apartment: null,
    });
  });

  it('removes the note with an empty one', async () => {
    const orderId = await paidOrder(undefined, { ...deliveryBody, note: 'Call first.' });

    const res = await edit(orderId, { note: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.note).toBeNull();
  });

  it('writes the change to the admin log with the old and the new value of each field', async () => {
    const orderId = await paidOrder();

    await edit(orderId, {
      recipientFirstName: 'Olha',
      address: { ...deliveryBody.address, house: '2' },
    });

    expect(await linesOf(orderId)).toEqual([
      {
        actorId: admin.id,
        actorRole: 'ADMIN',
        meta: [
          { field: 'recipientFirstName', old: 'Anna', new: 'Olha' },
          { field: 'house', old: '1', new: '2' },
        ],
      },
    ]);
  });

  it('mails the buyer that the delivery details were changed, with where and to whom now', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const orderId = await paidOrder(buyer);
    const mails = watchMail();

    await edit(orderId, {
      recipientLastName: 'Shevchenko',
      address: { ...deliveryBody.address, apartment: '7' },
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
    expect(mails[0]!.subject).toBe(`Cartlify — The delivery details of order #${orderId} changed`);
    expect(mails[0]!.text).toContain('Shipping to: Test street 1, apt 7, 01001 Kyiv, UA');
    expect(mails[0]!.text).toContain('Recipient: Anna Shevchenko, +380501234567');
  });

  it('changes nothing, writes no line and mails nobody when it is as it was', async () => {
    const orderId = await paidOrder();
    const mails = watchMail();

    const res = await edit(orderId, { recipientFirstName: 'Anna', address: deliveryBody.address });

    expect(res.statusCode).toBe(200);
    expect(await linesOf(orderId)).toEqual([]);
    expect(mails).toEqual([]);
  });

  it('keeps the change when its mail cannot be sent, and logs it with the order id only', async () => {
    const buyer = await newUser();
    const orderId = await paidOrder(buyer);
    refuseMail();

    const res = await edit(orderId, { recipientFirstName: 'Olha' });

    expect(res.statusCode).toBe(200);
    expect((await deliveryOf(orderId)).recipientFirstName).toBe('Olha');
    const logged = takeLogs({ msg: 'order delivery data changed mail was not sent' });
    expect(logged).toEqual([expect.objectContaining({ orderId })]);
    expect(JSON.stringify(logged)).not.toContain(buyer.email);
  });

  it('corrects the recipient of a pickup, and refuses an address for it', async () => {
    const orderId = await paidOrder(undefined, pickupBody);

    const ok = await edit(orderId, { recipientFirstName: 'Olha' });
    const refused = await edit(orderId, { address: deliveryBody.address });

    expect(ok.statusCode).toBe(200);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'DELIVERY_ADDRESS_NOT_ALLOWED' });
  });

  it.each([
    ['a first name with a digit', { recipientFirstName: 'Anna2' }, 'RECIPIENT_FIRST_NAME_INVALID'],
    ['a last name without a letter', { recipientLastName: '---' }, 'RECIPIENT_LAST_NAME_INVALID'],
    [
      'a country the shop does not deliver to',
      { address: { ...deliveryBody.address, country: 'FR', postalCode: '75001' } },
      'DELIVERY_COUNTRY_NOT_ALLOWED',
    ],
    [
      'a postal code with a typo',
      { address: { ...deliveryBody.address, postalCode: '0100' } },
      'DELIVERY_POSTAL_CODE_INVALID',
    ],
    [
      'a house of only spaces',
      { address: { ...deliveryBody.address, house: '   ' } },
      'DELIVERY_HOUSE_INVALID',
    ],
  ])('refuses %s', async (_case, payload, errorCode) => {
    const orderId = await paidOrder();

    const res = await edit(orderId, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await deliveryOf(orderId)).toMatchObject({ recipientFirstName: 'Anna', city: 'Kyiv' });
  });

  it.each([
    ['a phone without the plus sign', { recipientPhone: '0501234567' }],
    ['a note of 501 characters', { note: 'x'.repeat(501) }],
    ['a method, which stays', { method: 'pickup' }],
    ['nothing at all', {}],
  ])('refuses %s by the request schema', async (_case, payload) => {
    const orderId = await paidOrder();

    const res = await edit(orderId, payload);

    // fastify drops a field the schema does not name: a body of only such a field is empty
    expect(res.statusCode).toBe(400);
    expect(await deliveryOf(orderId)).toMatchObject({ method: 'manual' });
  });

  it.each([
    ['waiting for its payment', 'waiting'],
    ['shipped', 'shipped'],
  ] as const)('refuses an order that is %s', async (_case, stage) => {
    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10, stock: 5 }),
      stage,
    );

    const res = await edit(orderId, { recipientFirstName: 'Olha' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_DELIVERY_NOT_EDITABLE',
      details: { status: stage },
    });
    expect((await deliveryOf(orderId)).recipientFirstName).toBe('Anna');
  });

  it('answers 404 for an order that is not there', async () => {
    const res = await edit(2_000_000_000, { note: 'x' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a buyer, also the owner of the order', async () => {
    const owner = await newUser();
    const orderId = await paidOrder(owner);

    const res = await edit(orderId, { recipientFirstName: 'Olha' }, owner);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('keeps the price of the delivery as it was confirmed', async () => {
    const orderId = await paidOrder();
    const before = (await deliveryOf(orderId)).price;

    await edit(orderId, { address: { ...deliveryBody.address, house: '9' } });

    expect((await deliveryOf(orderId)).price).toEqual(before);
  });
});
