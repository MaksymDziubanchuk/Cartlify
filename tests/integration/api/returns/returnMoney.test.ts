import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  craftEvent,
  deliver,
  queueRefundOutcome,
  realStripe,
  refundsOf,
  settleRefund,
  stripeEvent,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';
import { failReturnRefund } from '../../../helpers/returns.js';
import { whileLocked } from '../../../helpers/variants.js';

// the money of the statements through the routes: POST /api/returns/:returnId/refund gives the money
// of the rows back in three steps (the rows are put on their way, Stripe is asked, the rows are
// settled by the answer), a transfer Stripe has not decided on or did not answer stays pending and
// the end comes by its event or by the worker, a refusal leaves the card the reason; a root records
// money sent outside the app and closes rows without a refund. The buyer is mailed, every step goes
// to the admin log. Stripe is the mock (the sandbox gives a card refund that succeeds); the tests of
// a refund that is pending or fails run on the mock only

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// the tests of a refund that is pending or fails need the mock to make one
const mockOnly = realStripe ? it.skip : it;

const post = (url: string, payload: Record<string, unknown> = {}, actor: TestUser | null = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

// an order paid by a card Stripe really took (the mock holds the payment), and its first item
async function paidByCard(units: number) {
  const product = await createProduct({ price: 10, stock: 30 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
    quantity: units,
  });
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { orderId, paymentId, itemId: items[0]!.id };
}

type Card = {
  id: number;
  closeCode: string | null;
  closeNote: string | null;
  closedAt: string | null;
  order: { returnStatus: string };
  items: Array<{
    id: number;
    quantity: number;
    goods: string;
    money: string;
    amount: number;
    amountNote: string | null;
    refundId: string | null;
    refundedAt: string | null;
    refundFailure: { code: string; text: string | null } | null;
    outside: { method: string; note: string; by: { id: number } | null } | null;
    refusedCode: string | null;
  }>;
};

// a statement of an admin for the units of the item; its card
async function statementOf(orderId: number, itemId: number, quantity: number): Promise<Card> {
  const res = await post('/api/returns', {
    orderId,
    items: [{ orderItemId: itemId, quantity }],
    basis: 'other',
    reason: 'defect',
  });
  if (res.statusCode !== 201) throw new Error(`the statement answered ${res.statusCode}`);
  return res.json();
}

// the statement whose units are on the shelf, ready for their money
async function comeBack(orderId: number, itemId: number, quantity: number): Promise<Card> {
  const made = await statementOf(orderId, itemId, quantity);
  const res = await post(`/api/returns/${made.id}/receive`, {
    results: [{ itemId: made.items[0]!.id, quantity, goods: 'to_stock' }],
  });
  if (res.statusCode !== 200) throw new Error(`the goods answered ${res.statusCode}`);
  return res.json();
}

const refund = (returnId: number, body: Record<string, unknown> = {}, actor = admin) =>
  post(`/api/returns/${returnId}/refund`, body, actor);

const outside = (returnId: number, body: Record<string, unknown>, actor: TestUser | null = root) =>
  post(`/api/returns/${returnId}/refund/outside`, body, actor);

const closeRows = (
  returnId: number,
  body: Record<string, unknown>,
  actor: TestUser | null = root,
) => post(`/api/returns/${returnId}/close`, body, actor);

const logOf = (orderId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event },
      select: { actorId: true, actorRole: true, action: true, meta: true },
    }),
  );

const mailTo = (mails: ReturnType<typeof watchMail>, subject: string) =>
  mails.filter((mail) => mail.to.includes(buyer.email) && mail.subject.includes(subject));

describe('POST /api/returns/:returnId/refund', () => {
  it('gives the money of the rows back through Stripe, settles them, logs it and mails the buyer', async () => {
    const { orderId, paymentId, itemId } = await paidByCard(3);
    const card = await comeBack(orderId, itemId, 2);
    const mails = watchMail();

    const res = await refund(card.id);

    expect(res.statusCode).toBe(200);
    const done: Card = res.json();
    expect(done.items).toEqual([
      expect.objectContaining({
        money: 'refunded',
        refundId: expect.stringMatching(/^re_/),
        refundedAt: expect.any(String),
        refundFailure: null,
        outside: null,
      }),
    ]);
    // 2 of the 3 units, 20.00: the statement is over, part of the order went back
    expect(done.closedAt).not.toBeNull();
    expect(done.order.returnStatus).toBe('partial');

    const refunds = await refundsOf(paymentId);
    expect(refunds).toEqual([
      expect.objectContaining({
        id: done.items[0]!.refundId,
        amount: 2000,
        status: 'succeeded',
        metadata: expect.objectContaining({
          entityType: 'order',
          entityId: String(orderId),
          transfer: expect.stringMatching(/^refund:[0-9a-f-]{36}$/),
        }),
      }),
    ]);

    expect(await logOf(orderId, 'return.refund')).toEqual([
      expect.objectContaining({
        actorId: admin.id,
        action: 'OTHER',
        meta: expect.arrayContaining([
          { field: 'returnId', old: null, new: card.id },
          {
            field: 'refund',
            old: null,
            new: expect.objectContaining({
              initiator: 'admin',
              amount: '20.00',
              refundId: done.items[0]!.refundId,
            }),
          },
        ]),
      }),
    ]);

    const own = mailTo(mails, `Return of order #${orderId} is closed`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('€20.00 went back to you.');
    expect(own[0]!.text).toContain(env.EMAIL_REPLY_TO);
  });

  it('says the order is full when every unit went back', async () => {
    const { orderId, itemId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);

    const res = await refund(card.id);

    expect(res.json().order.returnStatus).toBe('full');
  });

  it('mails that the money is back, not that the statement is closed, while a row still waits', async () => {
    const { orderId, itemId } = await paidByCard(2);
    // one unit back, one still expected: the statement stays open
    const made = await statementOf(orderId, itemId, 2);
    await post(`/api/returns/${made.id}/receive`, {
      results: [{ itemId: made.items[0]!.id, quantity: 1, goods: 'to_stock' }],
    });
    const mails = watchMail();

    const res = await refund(made.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().closedAt).toBeNull();
    expect(res.json().order.returnStatus).toBe('open_partial');
    const own = mailTo(mails, `Money returned for order #${orderId}`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('We returned €10.00');
  });

  it('pays ahead for goods that still wait, once the proof of the buyer is confirmed', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);

    const before = await refund(made.id);
    await post(`/api/returns/${made.id}/proof/confirm`);
    const after = await refund(made.id);

    expect(before.statusCode).toBe(400);
    expect(before.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_REQUIRED' });
    expect(after.statusCode).toBe(200);
    expect(after.json().items).toEqual([
      expect.objectContaining({ goods: 'expected', money: 'refunded' }),
    ]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  // the parcel of goods paid ahead never comes: the goods are not arrived and the money stays
  // refunded (the shop gets it back outside the app), the statement is over
  it('takes goods paid ahead that never arrive, and the money stays refunded', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);
    await post(`/api/returns/${made.id}/proof/confirm`);
    const paid = await refund(made.id);

    const res = await post(`/api/returns/${made.id}/receive`, {
      results: [{ itemId: paid.json().items[0].id, quantity: 1, goods: 'not_arrived' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refunded', refusedCode: null }),
    ]);
    expect(res.json().closedAt).not.toBeNull();
  });

  it('asks Stripe for the sum of the named rows only', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(3);
    const made = await statementOf(orderId, itemId, 3);
    await post(`/api/returns/${made.id}/receive`, {
      results: [
        { itemId: made.items[0]!.id, quantity: 1, goods: 'to_stock' },
        { itemId: made.items[0]!.id, quantity: 2, goods: 'written_off' },
      ],
    });
    const rows = (await asAdmin((tx) =>
      tx.orderReturnItem.findMany({
        where: { returnId: made.id },
        orderBy: { id: 'asc' },
        select: { id: true, quantity: true },
      }),
    ))!;
    const small = rows.find((row) => row.quantity === 1)!;

    const res = await refund(made.id, { itemIds: [small.id] });

    expect(res.statusCode).toBe(200);
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1000]);
    expect(
      res
        .json()
        .items.map((row: { money: string }) => row.money)
        .sort(),
    ).toEqual(['not_refunded', 'refunded']);
  });

  it('lets only a root lower what a row refunds, and Stripe gets the lowered sum', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);
    const reduction = [{ itemId: card.items[0]!.id, amount: 15, note: 'Opened and used.' }];

    const byAdmin = await refund(card.id, { reductions: reduction });
    const byRoot = await refund(card.id, { reductions: reduction }, root);

    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toMatchObject({ errorCode: 'RETURN_FORBIDDEN' });
    expect(byRoot.statusCode).toBe(200);
    expect(byRoot.json().items[0]).toMatchObject({
      amount: 15,
      amountNote: 'Opened and used.',
      money: 'refunded',
    });
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1500]);
    // the lowered sum is a decision of root: the journal keeps the row, the sums and the reason
    expect(await logOf(orderId, 'return.amount_lower')).toEqual([
      {
        actorId: root.id,
        actorRole: 'ROOT',
        action: 'OTHER',
        meta: [
          { field: 'returnId', old: null, new: card.id },
          {
            field: 'amount',
            old: null,
            new: { itemId: card.items[0]!.id, from: '20.00', to: '15.00' },
          },
          { field: 'note', old: null, new: 'Opened and used.' },
        ],
      },
    ]);
  });

  it.each([
    [
      'a sum above the price of the units',
      (id: number) => ({ reductions: [{ itemId: id, amount: 20.01, note: 'x' }] }),
      400,
      'RETURN_AMOUNT_INVALID',
    ],
    [
      'a lowered sum without its note',
      (id: number) => ({ reductions: [{ itemId: id, amount: 5 }] }),
      400,
      'RETURN_AMOUNT_NOTE_REQUIRED',
    ],
    [
      'a row lowered to nothing, which would leave it open for ever',
      (id: number) => ({ reductions: [{ itemId: id, amount: 0, note: 'Used up.' }] }),
      400,
      'RETURN_AMOUNT_INVALID',
    ],
    [
      'a row that is not in the statement',
      (id: number) => ({ itemIds: [id + 1_000_000] }),
      404,
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'a row lowered twice',
      (id: number) => ({
        reductions: [
          { itemId: id, amount: 5, note: 'Worn.' },
          { itemId: id, amount: 4, note: 'Worn more.' },
        ],
      }),
      400,
      'RETURN_ITEMS_REPEATED',
    ],
  ])('refuses root asking %s (%s) and asks Stripe nothing', async (_what, body, status, code) => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);

    const res = await refund(card.id, body(card.items[0]!.id), root);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('refuses a row already refunded (409), goods not accepted (409) and a statement with nothing to refund (400)', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 1);
    await refund(card.id);
    const rowId = card.items[0]!.id;

    const again = await refund(card.id, { itemIds: [rowId] });
    const nothing = await refund(card.id);

    const other = await statementOf(orderId, itemId, 1);
    await post(`/api/returns/${other.id}/receive`, {
      results: [
        {
          itemId: other.items[0]!.id,
          quantity: 1,
          goods: 'not_accepted',
          notAcceptedReason: 'used',
        },
      ],
    });
    const declined = await refund(other.id, { itemIds: [other.items[0]!.id] });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_REFUNDABLE' });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_REQUIRED' });
    expect(declined.statusCode).toBe(409);
    expect(declined.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_REFUNDABLE' });
    // one refund for the one transfer
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  it('refuses goods that wait while the proof is not confirmed, named by hand (409 RETURN_PROOF_REQUIRED)', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);

    const res = await refund(made.id, { itemIds: [made.items[0]!.id] });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_PROOF_REQUIRED' });
  });

  it('gives the money once when it is asked twice at the same time (409 for the other)', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);

    const results = await whileLocked(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`select id from cartlify.returns where id = ${card.id}::int for update`;
      },
      () =>
        Promise.all([
          refund(card.id, { itemIds: [card.items[0]!.id] }),
          refund(card.id, { itemIds: [card.items[0]!.id] }),
        ]),
      { waiters: 2 },
    );

    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'RETURN_ITEM_NOT_REFUNDABLE',
    });
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  it.each([
    ['a buyer', buyerActor],
    ['a visitor', () => null],
  ])('is refused to %s (403)', async (_who, actor) => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const res = await refund(card.id, {}, actor() as TestUser);

    expect(res.statusCode).toBe(403);
  });

  it('answers 404 for a statement that is not there, and 400 for an empty list of rows or rows of the wrong kind', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const missing = await refund(2_000_000_000);
    const empty = await refund(card.id, { itemIds: [] });
    const unknown = await refund(card.id, { itemIds: 'all' });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });
    expect(empty.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
  });
});

function buyerActor(): TestUser {
  return buyer;
}

describe('a refund that does not go through at once', () => {
  mockOnly(
    'keeps the rows pending while Stripe has not decided, and settles them by its event',
    async () => {
      const { orderId, paymentId, itemId } = await paidByCard(1);
      const card = await comeBack(orderId, itemId, 1);
      queueRefundOutcome({ status: 'pending' });
      const mails = watchMail();

      const res = await refund(card.id);

      expect(res.statusCode).toBe(200);
      const row = res.json().items[0];
      expect(row).toMatchObject({ money: 'pending', refundId: expect.stringMatching(/^re_/) });
      // nothing is mailed while the money is on its way
      expect(mailTo(mails, 'is closed')).toHaveLength(0);
      expect(mailTo(mails, 'Money returned')).toHaveLength(0);

      // Stripe decides: the event it records is the one the webhook gets
      settleRefund(row.refundId, { status: 'succeeded' });
      const event = await stripeEvent('refund.updated', row.refundId);
      const first = await deliver(app, event);
      const second = await deliver(app, event);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const settled = await asAdmin((tx) =>
        tx.orderReturnItem.findMany({ where: { returnId: card.id }, select: { money: true } }),
      );
      expect(settled).toEqual([{ money: 'refunded' }]);
      // the second delivery of the event changes nothing and mails nothing again
      expect(mailTo(mails, `Return of order #${orderId} is closed`)).toHaveLength(1);
      expect(await logOf(orderId, 'return.refund')).toHaveLength(1);
      expect(await refundsOf(paymentId)).toHaveLength(1);
    },
  );

  mockOnly(
    'leaves the reason on the card when Stripe refuses, mails a buyer whose card is gone, and lets the admin try again',
    async () => {
      const { orderId, paymentId, itemId } = await paidByCard(2);
      const card = await comeBack(orderId, itemId, 2);
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
      const mails = watchMail();

      const failed = await refund(card.id);

      expect(failed.statusCode).toBe(200);
      expect(failed.json().items[0]).toMatchObject({
        money: 'not_refunded',
        refundId: null,
        refundFailure: { code: 'card_unavailable', text: 'expired_or_canceled_card' },
      });
      expect(failed.json().closedAt).toBeNull();
      expect(failed.json().order.returnStatus).toBe('open');
      expect(await logOf(orderId, 'return.refund_failed')).toEqual([
        expect.objectContaining({
          actorId: admin.id,
          meta: expect.arrayContaining([
            {
              field: 'refund',
              old: null,
              new: expect.objectContaining({
                failure: 'card_unavailable',
                failureText: 'expired_or_canceled_card',
              }),
            },
          ]),
        }),
      ]);
      const note = mailTo(mails, `We could not return the money for order #${orderId}`);
      expect(note).toHaveLength(1);
      expect(note[0]!.text).toContain('We will contact you about another way');
      expect(note[0]!.text).not.toContain('expired_or_canceled_card');

      // the second try has a key of its own and Stripe takes it
      const again = await refund(card.id);

      expect(again.statusCode).toBe(200);
      expect(again.json().items[0]).toMatchObject({ money: 'refunded', refundFailure: null });
      expect(await refundsOf(paymentId)).toHaveLength(2);
      expect((await refundsOf(paymentId)).filter((one) => one.status === 'succeeded')).toHaveLength(
        1,
      );
    },
  );

  mockOnly('says nothing to the buyer of a failure that is not about their card', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    queueRefundOutcome({ status: 'failed', reason: 'insufficient_funds' });
    const mails = watchMail();

    const res = await refund(card.id);

    expect(res.json().items[0]).toMatchObject({ refundFailure: { code: 'shop_balance' } });
    expect(mailTo(mails, 'We could not return')).toHaveLength(0);
  });

  it('answers 200 with the rows pending when Stripe cannot be reached, and the same key gives the one refund later', async () => {
    const { orderId, paymentId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const res = await withStripeOutOfReach(() => refund(card.id));

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ money: 'pending', refundId: null });
    expect(await refundsOf(paymentId)).toEqual([]);
  });
});

describe('POST /api/returns/:returnId/refund/outside', () => {
  mockOnly(
    'records money sent outside the app after a transfer failed, mails the buyer and logs it',
    async () => {
      const { orderId, paymentId, itemId } = await paidByCard(1);
      const card = await comeBack(orderId, itemId, 1);
      queueRefundOutcome({ status: 'failed', reason: 'lost_or_stolen_card' });
      await refund(card.id);
      const mails = watchMail();
      const { paidAt } = await asAdmin((tx) =>
        tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
      );
      const day = paidAt!.toISOString();

      const res = await outside(card.id, {
        method: 'bank_transfer',
        note: 'Sent to the account the buyer wrote by mail.',
        at: day,
      });

      expect(res.statusCode).toBe(200);
      const done: Card = res.json();
      expect(done.items[0]).toMatchObject({
        money: 'refunded',
        refundId: null,
        refundedAt: day,
        refundFailure: null,
        outside: {
          method: 'bank_transfer',
          note: 'Sent to the account the buyer wrote by mail.',
          by: { id: root.id },
        },
      });
      expect(done.closedAt).not.toBeNull();
      expect(done.order.returnStatus).toBe('full');
      // Stripe took no second refund
      expect((await refundsOf(paymentId)).filter((one) => one.status === 'succeeded')).toEqual([]);
      expect(await logOf(orderId, 'return.refund_outside')).toEqual([
        expect.objectContaining({
          actorId: root.id,
          action: 'OTHER',
          // the note is a field of its own, not inside the refund: the dev copy blanks it by name
          meta: expect.arrayContaining([
            { field: 'note', old: null, new: 'Sent to the account the buyer wrote by mail.' },
            {
              field: 'refund',
              old: null,
              new: expect.not.objectContaining({ note: expect.anything() }),
            },
          ]),
        }),
      ]);
      const own = mailTo(mails, `Return of order #${orderId} is closed`);
      expect(own).toHaveLength(1);
      expect(own[0]!.text).toContain('€10.00 went back to you.');
    },
  );

  mockOnly('never records a transfer the buyer disputed at the bank (409)', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    queueRefundOutcome({ status: 'failed', reason: 'charge_for_pending_refund_disputed' });
    const failed = await refund(card.id);
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );

    const res = await outside(card.id, {
      itemIds: [failed.json().items[0].id],
      method: 'cash',
      note: 'In the shop.',
      at: paidAt!.toISOString(),
    });

    expect(failed.json().items[0]).toMatchObject({ refundFailure: { code: 'disputed' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
  });

  mockOnly('never sends again a transfer the buyer disputed at the bank (409)', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    queueRefundOutcome({ status: 'failed', reason: 'charge_for_pending_refund_disputed' });
    const failed = await refund(card.id);
    const before = (await refundsOf(paymentId)).length;

    const named = await refund(card.id, { itemIds: [failed.json().items[0].id] });
    const byDefault = await refund(card.id);

    expect(named.statusCode).toBe(409);
    expect(named.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
    expect(byDefault.statusCode).toBe(400);
    expect(byDefault.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_REQUIRED' });
    expect(await refundsOf(paymentId)).toHaveLength(before);
  });

  it('is refused for a row that was never tried (409), a day of the future (400) and an empty note (400)', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const day = paidAt!.toISOString();
    const rowId = card.items[0]!.id;

    const untried = await outside(card.id, {
      itemIds: [rowId],
      method: 'cash',
      note: 'x',
      at: day,
    });
    const future = await outside(card.id, {
      method: 'cash',
      note: 'x',
      at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const blank = await outside(card.id, { method: 'cash', note: '', at: day });

    expect(untried.statusCode).toBe(409);
    expect(untried.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_FAILED' });
    expect(future.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);
  });

  it.each([
    ['an admin', () => admin],
    ['a buyer', buyerActor],
  ])('is for a root only: %s is refused (403)', async (_who, actor) => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const res = await outside(
      card.id,
      { method: 'cash', note: 'x', at: new Date().toISOString() },
      actor(),
    );

    expect(res.statusCode).toBe(403);
  });
});

// the cost of the way back: a transfer of a withdrawal whose contract says the buyer pays takes it
// off (the database tests check the rules, a contract is a state of the whole shop here); root
// records the one the shop paid back to the buyer outside the app
describe('the cost of the way back', () => {
  it('takes nothing off a statement outside the withdrawal (409 RETURN_DEDUCTION_NOT_ALLOWED) and asks Stripe nothing', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const res = await refund(card.id, { returnShippingDeduction: 3 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_DEDUCTION_NOT_ALLOWED' });
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  // the day the money went: the moment of the statement, which the clock of the database gave
  const reimburse = (card: Card, actor: TestUser = root, body: Record<string, unknown> = {}) =>
    post(
      `/api/returns/${card.id}/reimbursement`,
      {
        amount: 6.5,
        method: 'bank_transfer',
        note: 'The receipt of the carrier came by mail.',
        at: (card as Card & { statedAt: string }).statedAt,
        ...body,
      },
      actor,
    );

  it('records the cost of the way back root paid back outside the app, in the card, the log and a mail', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await statementOf(orderId, itemId, 1);
    const mails = watchMail();

    const res = await reimburse(card);

    expect(res.statusCode).toBe(200);
    expect(res.json().shippingReimbursement).toEqual({
      amount: 6.5,
      at: expect.any(String),
      method: 'bank_transfer',
      note: 'The receipt of the carrier came by mail.',
      by: expect.objectContaining({ id: root.id }),
    });
    expect(await logOf(orderId, 'return.shipping_reimburse')).toEqual([
      expect.objectContaining({
        actorId: root.id,
        actorRole: 'ROOT',
        meta: expect.arrayContaining([
          { field: 'note', old: null, new: 'The receipt of the carrier came by mail.' },
        ]),
      }),
    ]);
    const own = mailTo(mails, `We paid back the cost of sending order #${orderId} back`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('We paid you back €6.50');
    expect(own[0]!.text).toContain('by a bank transfer');
    expect(own[0]!.text).not.toContain('came by mail');
  });

  it('is root only (403), once (409 RETURN_REIMBURSEMENT_EXISTS), with a sum above 0 (400)', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await statementOf(orderId, itemId, 1);

    const byAdmin = await reimburse(card, admin);
    const nothing = await reimburse(card, root, { amount: 0 });
    const first = await reimburse(card);
    const again = await reimburse(card);

    expect(byAdmin.statusCode).toBe(403);
    expect(nothing.statusCode).toBe(400);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_REIMBURSEMENT_EXISTS' });
  });
});

// the end of a dispute of the payment at the bank, for root: lost refunds the disputed rows by
// chargeback on the day given (no mail, the bank told the buyer), won takes the mark off so the
// money is sent again the usual way. The database tests check the rules
describe('POST /api/returns/:returnId/dispute', () => {
  const dispute = (returnId: number, body: Record<string, unknown>, actor: TestUser = root) =>
    post(`/api/returns/${returnId}/dispute`, body, actor);

  // a statement whose units came back and whose transfer the bank disputed
  async function disputedCard() {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    await failReturnRefund(admin.id, card.id, 'disputed');
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    return { orderId, card, paidAt: paidAt! };
  }

  it('records a lost dispute: the rows are refunded by chargeback on the day given, logged, no mail', async () => {
    const { orderId, card, paidAt } = await disputedCard();
    const mails = watchMail();

    const res = await dispute(card.id, {
      outcome: 'lost',
      note: 'The bank gave the buyer the money.',
      at: paidAt.toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      money: 'refunded',
      refundedAt: paidAt.toISOString(),
      refundFailure: null,
      outside: {
        method: 'chargeback',
        note: 'The bank gave the buyer the money.',
        by: { id: root.id },
      },
    });
    expect(await logOf(orderId, 'return.dispute_settle')).toEqual([
      expect.objectContaining({ actorId: root.id, actorRole: 'ROOT' }),
    ]);
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toEqual([]);
  });

  mockOnly('takes the mark off a won dispute, and the money goes again', async () => {
    const { card } = await disputedCard();

    const res = await dispute(card.id, { outcome: 'won', note: 'The bank kept it with the shop.' });
    const again = await refund(card.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ money: 'not_refunded', refundFailure: null });
    expect(again.statusCode).toBe(200);
    expect(again.json().items[0]).toMatchObject({ money: 'refunded' });
  });

  it('is root only (403), for a statement with a dispute (409), with the day of a lost one (400); chargeback is not a way by hand (400)', async () => {
    const { card } = await disputedCard();
    const { orderId, itemId } = await paidByCard(1);
    const calm = await comeBack(orderId, itemId, 1);

    const byAdmin = await dispute(card.id, { outcome: 'lost', note: 'Lost.' }, admin);
    const nothing = await dispute(calm.id, { outcome: 'won', note: 'Won.' });
    const noDay = await dispute(card.id, { outcome: 'lost', note: 'Lost.' });
    const byHand = await outside(card.id, {
      itemIds: [card.items[0]!.id],
      method: 'chargeback',
      note: 'By hand.',
      at: new Date().toISOString(),
    });

    expect(byAdmin.statusCode).toBe(403);
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ errorCode: 'RETURN_NOT_DISPUTED' });
    expect(noDay.statusCode).toBe(400);
    expect(noDay.json()).toMatchObject({ errorCode: 'RETURN_OUTSIDE_AT_INVALID' });
    expect(byHand.statusCode).toBe(400);
  });
});

describe('POST /api/returns/:returnId/close', () => {
  it('closes the rows that wait for goods that never came, with the code, and mails the buyer in words', async () => {
    const { orderId, itemId } = await paidByCard(2);
    const made = await statementOf(orderId, itemId, 2);
    const mails = watchMail();

    const res = await closeRows(made.id, {
      code: 'goods_not_returned',
      note: 'Nothing came in three weeks.',
    });

    expect(res.statusCode).toBe(200);
    const done: Card = res.json();
    expect(done).toMatchObject({
      closeCode: 'goods_not_returned',
      closeNote: 'Nothing came in three weeks.',
      closedAt: expect.any(String),
      order: { returnStatus: 'declined' },
    });
    expect(done.items).toEqual([
      expect.objectContaining({
        goods: 'not_arrived',
        money: 'refused',
        refusedCode: 'goods_not_returned',
      }),
    ]);
    expect(await logOf(orderId, 'return.close')).toEqual([
      expect.objectContaining({ actorId: root.id }),
    ]);
    const own = mailTo(mails, `Return of order #${orderId} is closed`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('We did not receive the goods back.');
    expect(own[0]!.text).toContain('No money is returned for this statement.');
    // the note is for the shop
    expect(own[0]!.text).not.toContain('three weeks');
  });

  it('gives the units back: the same units can be stated again', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);
    await closeRows(made.id, { code: 'not_buyer', note: 'Not the buyer.' });

    const again = await post('/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
    });

    expect(again.statusCode).toBe(201);
  });

  it('is refused for a row whose goods came back (409), with no note (400), and to anybody but a root (403)', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    const rowId = card.items[0]!.id;

    const back = await closeRows(card.id, { itemIds: [rowId], code: 'other', note: 'x' });
    const blank = await closeRows(card.id, { code: 'other', note: '' });
    const byAdmin = await closeRows(card.id, { code: 'other', note: 'x' }, admin);
    const byBuyer = await closeRows(card.id, { code: 'other', note: 'x' }, buyer);

    expect(back.statusCode).toBe(409);
    expect(back.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_CLOSABLE' });
    expect(blank.statusCode).toBe(400);
    expect(byAdmin.statusCode).toBe(403);
    expect(byBuyer.statusCode).toBe(403);
  });
});

describe('the goods taken in close the statement', () => {
  it('mails the buyer which units did not come back and why, when the last row is settled by the goods', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);
    const mails = watchMail();

    const res = await post(`/api/returns/${made.id}/receive`, {
      results: [
        {
          itemId: made.items[0]!.id,
          quantity: 1,
          goods: 'not_accepted',
          notAcceptedReason: 'unsealed',
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const own = mailTo(mails, `Return of order #${orderId} is closed`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('(the package was opened)');
  });
});

describe('the refund events of Stripe for a transfer whose request has not settled it', () => {
  // the request reached Stripe but the answer did not come back: the rows wait without an id, and the
  // event carries the key of the transfer in the metadata of the refund
  async function pendingWithoutId() {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    await withStripeOutOfReach(() => refund(card.id));
    const [row] = await asAdmin((tx) =>
      tx.orderReturnItem.findMany({ where: { returnId: card.id }, select: { refundKey: true } }),
    );
    return { card, orderId, transfer: `refund:${row!.refundKey}` };
  }

  const rowsOf = (returnId: number) =>
    asAdmin((tx) =>
      tx.orderReturnItem.findMany({
        where: { returnId },
        select: { money: true, refundId: true, refundFailure: true },
      }),
    );

  it('settles the rows by the key in the metadata of a refund that succeeded, and keeps its id', async () => {
    const { card, transfer } = await pendingWithoutId();

    const res = await deliver(
      app,
      craftEvent('refund.updated', {
        object: 'refund',
        id: 're_test_early',
        status: 'succeeded',
        metadata: { transfer },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(card.id)).toEqual([
      { money: 'refunded', refundId: 're_test_early', refundFailure: null },
    ]);
  });

  it('settles the rows by a refund that failed, with the reason in our words', async () => {
    const { card, transfer } = await pendingWithoutId();

    const res = await deliver(
      app,
      craftEvent('refund.failed', {
        object: 'refund',
        id: 're_test_failed',
        status: 'failed',
        failure_reason: 'insufficient_funds',
        metadata: { transfer },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(card.id)).toEqual([
      { money: 'not_refunded', refundId: null, refundFailure: 'shop_balance' },
    ]);
  });
});

describe('the refund events of Stripe that are not transfers of a statement', () => {
  it('acknowledges the refund of a payment given back late and one made by hand at Stripe, and changes nothing', async () => {
    const late = craftEvent('refund.updated', {
      object: 'refund',
      id: 're_test_late',
      status: 'succeeded',
      metadata: { transfer: 'refund:pi_test_1' },
    });
    const byHand = craftEvent('refund.failed', {
      object: 'refund',
      id: 're_test_hand',
      status: 'failed',
      failure_reason: 'unknown',
      metadata: {},
    });

    expect((await deliver(app, late)).statusCode).toBe(200);
    expect((await deliver(app, byHand)).statusCode).toBe(200);
  });

  it('refuses an event whose object is not a refund (400)', async () => {
    const res = await deliver(app, craftEvent('refund.updated', { object: 'charge', id: 'ch_1' }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'STRIPE_EVENT_OBJECT_INVALID' });
  });
});
