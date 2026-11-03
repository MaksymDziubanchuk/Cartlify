import type { FastifyInstance } from 'fastify';

import { withdrawalCodeOf } from '@helpers/withdrawalCode.js';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin } from './db.js';
import type { TestUser } from './factories.js';
import { placeOrder, type Buyable } from './orders.js';

// The steps of a statement of withdrawal or of return as the routes take them, for the tests that
// need statements in a state as their data (the list of the statements, the alerts about them):
// the order is sent, an admin states units of it, the buyer withdraws from their account or fills
// the public form, tells of the parcel, the admin confirms the proof and takes the goods in. The
// money goes back through the database functions (helpers/returns.ts). The test hands over the
// app, the token of the page and the admin as functions, because a test file makes them in beforeAll

export type ReturnCard = { id: number; items: Array<{ id: number }> };

export function returnFlows(context: {
  app: () => FastifyInstance;
  csrf: () => Csrf;
  admin: () => TestUser;
}) {
  const post = (
    url: string,
    payload: Record<string, unknown> = {},
    actor: TestUser | null | undefined = undefined,
  ) => {
    const who = actor === undefined ? context.admin() : actor;
    return context.app().inject({
      method: 'POST',
      url,
      headers: who ? withCsrf(context.csrf(), accessCookie(who)) : withCsrf(context.csrf()),
      payload,
    });
  };

  // a sent order of the user for the units of one item, with the id of that item
  async function shippedOrder(user: TestUser, item: Buyable, quantity: number) {
    const orderId = await placeOrder(
      context.app(),
      context.csrf(),
      user,
      item,
      'shipped',
      quantity,
    );
    const row = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
    );
    return { orderId, itemId: row.id, buyerId: user.id };
  }

  // the statement of an admin for units of the one item of an order; its card
  async function adminStatement(
    orderId: number,
    itemId: number,
    quantity: number,
    extra: Record<string, unknown> = {},
  ): Promise<ReturnCard> {
    const res = await post('/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity }],
      basis: 'other',
      reason: 'defect',
      ...extra,
    });
    if (res.statusCode !== 201) throw new Error(`the statement answered ${res.statusCode}`);
    return res.json();
  }

  // the admin sets the result of the first row of the card for the units
  async function setGoods(
    card: ReturnCard,
    quantity: number,
    goods: string,
    extra: Record<string, unknown> = {},
  ) {
    const res = await post(`/api/returns/${card.id}/receive`, {
      results: [{ itemId: card.items[0]!.id, quantity, goods, ...extra }],
    });
    if (res.statusCode !== 200) throw new Error(`the goods answered ${res.statusCode}`);
  }

  // the card of a statement as an admin reads it
  async function cardOf(returnId: number): Promise<ReturnCard> {
    const res = await context.app().inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(context.admin()) },
    });
    if (res.statusCode !== 200) throw new Error(`the card answered ${res.statusCode}`);
    return res.json();
  }

  async function confirmProof(returnId: number) {
    const res = await post(`/api/returns/${returnId}/proof/confirm`);
    if (res.statusCode !== 200) throw new Error(`the confirm answered ${res.statusCode}`);
  }

  // the admin accepts a statement of the form without the code as the buyer's
  async function acceptStatement(returnId: number) {
    const res = await post(`/api/returns/${returnId}/accept`);
    if (res.statusCode !== 200) throw new Error(`the accept answered ${res.statusCode}`);
  }

  // the buyer withdraws from the whole of a sent order from their account; the id of the statement
  async function withdrawFromAccount(user: TestUser, orderId: number): Promise<number> {
    const res = await post(`/api/orders/${orderId}/withdrawal`, {}, user);
    if (res.statusCode !== 201) throw new Error(`the withdrawal answered ${res.statusCode}`);
    return res.json().withdrawals[0].id;
  }

  // the buyer writes the carrier and the number of the parcel of a statement of their account
  async function tellOfParcel(user: TestUser, orderId: number, returnId: number) {
    const res = await post(
      `/api/orders/${orderId}/returns/${returnId}/proof`,
      { carrier: 'DHL', trackingNumber: 'JD0146000123' },
      user,
    );
    if (res.statusCode !== 200) throw new Error(`the proof answered ${res.statusCode}`);
  }

  // the public form of withdrawal, with the code of the order or without it, for the recipient of
  // the order (Anna Koval, the facts of helpers/orders.ts without the code); the id of the statement
  // it made
  async function formStatement(orderId: number, withCode: boolean, email: string): Promise<number> {
    const res = await post(
      '/api/withdrawals',
      {
        orderId,
        recipientName: 'Anna Koval',
        email,
        ...(withCode
          ? { code: withdrawalCodeOf(orderId) }
          : { phone: '+380501234567', country: 'UA', postalCode: '01001' }),
      },
      null,
    );
    if (res.statusCode !== 201) throw new Error(`the form answered ${res.statusCode}`);

    const row = await asAdmin((tx) =>
      tx.orderReturn.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
    );
    return row.id;
  }

  return {
    post,
    shippedOrder,
    adminStatement,
    setGoods,
    cardOf,
    confirmProof,
    acceptStatement,
    withdrawFromAccount,
    tellOfParcel,
    formStatement,
  };
}
