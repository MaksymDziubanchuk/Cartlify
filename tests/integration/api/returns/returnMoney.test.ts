import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { shopSettings } from '@config/shopSettings.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, inCommittedTx } from '../../../helpers/db.js';
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
  DISPUTED_CARD,
  REFUND_FAIL_CARD,
  PENDING_REFUND_CARD,
  queueRefundOutcome,
  refundBecomes,
  stripeWait,
  realStripe,
  refundsOf,
  stripeEvent,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';
import {
  handRefundOf,
  newDisputeId,
  reinstatement,
  synced,
  withdrawal,
  type Snapshot,
} from '../../../helpers/dbMoney.js';
import { whileLocked } from '../../../helpers/variants.js';

// the money of the statements through the routes: POST /api/returns/:returnId/refund gives the money
// of the rows back in three steps (the transfer is written into the money journal in parts, in
// transit, under a key; Stripe is asked; its answer settles the lines and the rows), a transfer
// Stripe has not decided on or did not answer stays in transit and the end comes by its event or by
// the worker, a refusal leaves the card the reason; a root records money sent outside the app and
// closes rows without a refund. The card shows the movements of the money (`money`) and what went
// back in all (`refundedTotal`). The buyer is mailed, every step of a person goes to the admin log
// with the lines of the money journal. Stripe is the mock (the sandbox gives a card refund that
// succeeds); the tests of a refund that is pending or fails run on the mock only

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root allowed to handle the money the way root does
let manager: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  manager = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id, manager.id);
  await giveMoneyRight(root.id, manager.id);
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

const get = (url: string, actor: TestUser = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

// an order paid by a card Stripe really took (the mock holds the payment), and its first item
async function paidByCard(units: number, card?: string, owner: TestUser = buyer) {
  const product = await createProduct({ price: 10, stock: 30 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, owner, product, {
    quantity: units,
    ...(card ? { card } : {}),
  });
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { orderId, paymentId, itemId: items[0]!.id };
}

type Move = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: number;
  state: string | null;
  refundId: string | null;
  failure: string | null;
  method: string | null;
  note: string | null;
  happenedAt: string | null;
  coversId: number | null;
  by: { id: number } | null;
};

type Card = {
  id: number;
  closeCode: string | null;
  closeNote: string | null;
  closedAt: string | null;
  refundedTotal: number;
  disputeOpen: boolean;
  handRefundPending: boolean;
  order: { returnStatus: string };
  money: Move[];
  items: Array<{
    id: number;
    quantity: number;
    goods: string;
    money: string;
    amount: number;
    amountNote: string | null;
    moneyLogId: number | null;
    refundFailure: { code: string; text: string | null } | null;
    refusedCode: string | null;
  }>;
};

// the line of the money journal the money of a row stands on, as the card shows it
const lineOfRow = (card: Card, index = 0) =>
  card.money.find((move) => move.id === card.items[index]!.moneyLogId);

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
    parcel: { buyerPaid: 0 },
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
        moneyLogId: expect.any(Number),
        refundFailure: null,
      }),
    ]);
    // the transfer is one line of the goods, sent, with the id Stripe gave
    const goods = lineOfRow(done)!;
    expect(done.money).toEqual([goods]);
    expect(goods).toMatchObject({
      event: 'money.refund',
      purpose: 'return',
      part: 'goods',
      amount: -20,
      state: 'sent',
      refundId: expect.stringMatching(/^re_/),
      by: { id: admin.id },
    });
    // 2 of the 3 units, 20.00: the statement is over, part of the order went back
    expect(done.refundedTotal).toBe(20);
    expect(done.closedAt).not.toBeNull();
    expect(done.order.returnStatus).toBe('partial');

    const refunds = await refundsOf(paymentId);
    expect(refunds).toEqual([
      expect.objectContaining({
        id: goods.refundId,
        amount: 2000,
        status: 'succeeded',
        metadata: expect.objectContaining({
          entityType: 'order',
          entityId: String(orderId),
          transfer: expect.stringMatching(/^refund:[0-9a-f-]{36}$/),
        }),
      }),
    ]);

    // the admin started it: the line names the lines of the money journal it wrote
    expect(await logOf(orderId, 'return.refund')).toEqual([
      {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action: 'OTHER',
        meta: [
          { field: 'returnId', old: null, new: card.id },
          { field: 'moneyLogIds', old: null, new: [goods.id] },
          {
            field: 'refund',
            old: null,
            new: { amount: '20.00', itemIds: [done.items[0]!.id] },
          },
        ],
      },
    ]);

    const own = mailTo(mails, `Return of order #${orderId} is closed`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('We sent you €20.00.');
    expect(own[0]!.text).toContain(shopSettings().emailReplyTo);
  });

  // the language of the buyer's account (mailLocaleOf): the words and the money
  it("mails the money back in the language of the buyer's account", async () => {
    const owner = await createUser({ name: 'Ana', locale: 'es' });
    userIds.push(owner.id);
    const { orderId, itemId } = await paidByCard(3, undefined, owner);
    const card = await comeBack(orderId, itemId, 2);
    const mails = watchMail();

    const res = await refund(card.id);

    expect(res.statusCode).toBe(200);
    const own = mails.filter((mail) => mail.to.includes(owner.email));
    expect(own).toHaveLength(1);
    expect(own[0]!.subject).toContain(`Se cerró la devolución del pedido #${orderId}`);
    expect(own[0]!.text).toContain('Hola, Ana:');
    expect(own[0]!.text).toContain('20,00');
  });

  it('says the order is full when every unit went back', async () => {
    const { orderId, itemId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);

    const res = await refund(card.id);

    expect(res.json().order.returnStatus).toBe('full');
  });

  it('mails that the money is back, not that the statement is closed, while a row still waits', async () => {
    const { orderId, itemId } = await paidByCard(2);
    // one unit back, one still expected: the statement stays open; the admin sends the money of
    // the unit that came
    const made = await statementOf(orderId, itemId, 2);
    const taken = await post(`/api/returns/${made.id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: made.items[0]!.id, quantity: 1, goods: 'to_stock' }],
    });
    const came = taken.json().items.find((row: { goods: string }) => row.goods === 'to_stock');
    const mails = watchMail();

    const res = await refund(made.id, { itemIds: [came.id] });

    expect(res.statusCode).toBe(200);
    expect(res.json().closedAt).toBeNull();
    expect(res.json().order.returnStatus).toBe('open_partial');
    const own = mailTo(mails, `Money sent for order #${orderId}`);
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain('We sent you €10.00');
  });

  it('pays ahead for goods that still wait, once the proof of the buyer is confirmed', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);

    const before = await refund(made.id);
    await post(`/api/returns/${made.id}/proof/confirm`, { buyerPaid: 0 });
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
    await post(`/api/returns/${made.id}/proof/confirm`, { buyerPaid: 0 });
    const paid = await refund(made.id);

    const res = await post(`/api/returns/${made.id}/receive`, {
      parcel: { buyerPaid: 0 },
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
      parcel: { buyerPaid: 0 },
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

  it('lets an admin root allowed to handle the money lower what a row refunds too', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 2);
    const reduction = [{ itemId: card.items[0]!.id, amount: 15, note: 'Opened and used.' }];

    const res = await refund(card.id, { reductions: reduction }, manager);

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ amount: 15, money: 'refunded' });
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1500]);
    expect((await logOf(orderId, 'return.amount_lower'))[0]).toMatchObject({
      actorId: manager.id,
      actorRole: 'ADMIN',
    });
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
      parcel: { buyerPaid: 0 },
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
  it('keeps the rows pending while Stripe has not decided, and mails nothing', async () => {
    const { orderId, itemId } = await paidByCard(1, PENDING_REFUND_CARD);
    const card = await comeBack(orderId, itemId, 1);
    const mails = watchMail();

    const res = await refund(card.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ money: 'pending' });
    expect(lineOfRow(res.json())).toMatchObject({
      state: 'in_transit',
      refundId: expect.stringMatching(/^re_/),
    });
    // the money left the shop when Stripe took the refund: on its way, it counts
    expect(res.json().refundedTotal).toBe(10);
    expect(mailTo(mails, 'is closed')).toHaveLength(0);
    expect(mailTo(mails, 'Money sent')).toHaveLength(0);
  });

  // the bank of a card that is gone sends the money back after the refund went (the sandbox: the
  // card of a refund that fails, about 130 s later): the rows wait for their money again, the buyer
  // is told, the admin finds the statement among the failed transfers; the journal keeps the
  // transfer sent and the failure as new lines with the sum back
  it(
    'takes the money back to failed when the bank of a card that is gone sends it back',
    async () => {
      const { orderId, paymentId, itemId } = await paidByCard(1, REFUND_FAIL_CARD);
      const card = await comeBack(orderId, itemId, 1);
      const mails = watchMail();
      const went = await refund(card.id);
      expect(went.json().items[0]).toMatchObject({ money: 'refunded' });
      expect(went.json().closedAt).not.toBeNull();
      const refundId = lineOfRow(went.json())!.refundId!;

      await refundBecomes(refundId, { status: 'failed', reason: 'expired_or_canceled_card' });
      const event = await stripeEvent('refund.failed', refundId);
      expect((await deliver(app, event)).statusCode).toBe(200);
      expect((await deliver(app, event)).statusCode).toBe(200);

      const after = (await get(`/api/returns/${card.id}`)).json();
      expect(after.closedAt).toBeNull();
      expect(after.items).toEqual([
        expect.objectContaining({
          money: 'failed',
          refundFailure: expect.objectContaining({ code: 'card_unavailable' }),
        }),
      ]);
      expect(
        (after.money as Move[]).map((move) => [move.event, move.part, move.amount, move.state]),
      ).toEqual([
        ['money.refund', 'goods', -10, 'sent'],
        ['money.refund_failed', 'goods', 10, null],
      ]);
      expect(after.refundedTotal).toBe(0);
      const failedList = (await get(`/api/returns?money=failed&q=${after.code}`)).json().items;
      expect(failedList).toHaveLength(1);
      const told = mailTo(mails, 'We could not return the money');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('sent back to us by the bank of the card');
      // the work of the system is in the money journal only
      expect(await logOf(orderId, 'return.refund_failed')).toEqual([]);
      expect((await refundsOf(paymentId)).map((one) => one.status)).toEqual(['failed']);
    },
    stripeWait,
  );

  // the sandbox ends a refund of the pending card about two minutes later with one refund.updated
  // (seen 04.11.2026): the test waits for it; the mock ends it at once
  it(
    'settles the pending rows by the event of Stripe, once',
    async () => {
      const { orderId, paymentId, itemId } = await paidByCard(1, PENDING_REFUND_CARD);
      const card = await comeBack(orderId, itemId, 1);
      const mails = watchMail();
      const row = lineOfRow((await refund(card.id)).json())!;

      // Stripe decides: the event it records is the one the webhook gets
      await refundBecomes(row.refundId!, { status: 'succeeded' });
      const event = await stripeEvent('refund.updated', row.refundId!);
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
    stripeWait,
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
        money: 'failed',
        refundFailure: { code: 'card_unavailable', text: 'expired_or_canceled_card' },
      });
      expect(lineOfRow(failed.json())).toMatchObject({
        event: 'money.refund_failed',
        amount: 20,
        failure: 'card_unavailable',
        by: { id: admin.id },
      });
      expect(failed.json().closedAt).toBeNull();
      expect(failed.json().order.returnStatus).toBe('open');
      expect(failed.json().refundedTotal).toBe(0);
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
    expect(res.json().items[0]).toMatchObject({ money: 'pending' });
    expect(lineOfRow(res.json())).toMatchObject({ state: 'in_transit', refundId: null });
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
      expect(done.items[0]).toMatchObject({ money: 'refunded', refundFailure: null });
      const sent = lineOfRow(done)!;
      expect(sent).toMatchObject({
        event: 'money.outside',
        purpose: 'return',
        part: 'goods',
        amount: -10,
        refundId: null,
        method: 'bank_transfer',
        note: 'Sent to the account the buyer wrote by mail.',
        happenedAt: day,
        by: { id: root.id },
      });
      // the transfer, its failure, the money sent another way: the buyer got 10 in all
      expect(done.money.map((move) => move.event)).toEqual([
        'money.refund',
        'money.refund_failed',
        'money.outside',
      ]);
      expect(done.refundedTotal).toBe(10);
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
            { field: 'moneyLogIds', old: null, new: [sent.id] },
            { field: 'note', old: null, new: 'Sent to the account the buyer wrote by mail.' },
            {
              field: 'refund',
              old: null,
              new: expect.not.objectContaining({ note: expect.anything() }),
            },
          ]),
        }),
      ]);
      // the mail of the end tells how and on which day root sent it, not the way of the card
      const own = mailTo(mails, `Return of order #${orderId} is closed`);
      expect(own).toHaveLength(1);
      expect(own[0]!.text).toMatch(/We sent you €10\.00 by a bank transfer on \d{1,2} \w+ \d{4}\./);
      expect(own[0]!.text).not.toContain('It goes back the way you paid.');
    },
  );

  it('refuses a day of the future (400) and an empty note (400), and records a row never tried too', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const day = paidAt!.toISOString();
    const rowId = card.items[0]!.id;

    const future = await outside(card.id, {
      method: 'cash',
      note: 'x',
      at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const blank = await outside(card.id, { method: 'cash', note: '', at: day });
    // the money of a row no transfer tried: a transfer the payment could not hold goes this way
    const untried = await outside(card.id, {
      itemIds: [rowId],
      method: 'cash',
      note: 'x',
      at: day,
    });

    expect(future.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);
    expect(untried.statusCode).toBe(200);
    expect(untried.json().items[0]).toMatchObject({ money: 'refunded' });
  });

  it('is recorded by an admin root allowed to handle the money too', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);

    const res = await outside(
      card.id,
      { method: 'cash', note: 'Paid at the counter.', at: new Date().toISOString() },
      manager,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ money: 'refunded' });
  });

  it.each([
    ['an admin without the right of the money', () => admin],
    ['a buyer', buyerActor],
  ])('is for root and an admin root allowed only: %s is refused (403)', async (_who, actor) => {
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
});

// while the bank or root has the last word on the money of the payment, no transfer goes: a dispute
// of the payment open at the bank (the bank gives the money back, the shop would pay twice), unless
// Stripe says the payment can still be refunded; a refund made by hand in the dashboard root has not
// said what it was (it may be this money). The card says so. The dispute and the refund made by hand
// are written by the database functions the webhook calls (their own tests: db/disputes,
// db/handRefunds); here only what the routes of the statement do with them
describe('while the bank or root has the last word on the money', () => {
  // the bank opens a dispute and takes the money (one transaction of the balance, which every
  // later look at the dispute shows again)
  const openDispute = (paymentId: string, opening: Partial<Snapshot> = {}) =>
    inCommittedTx(async (db) => {
      const stripeId = newDisputeId();
      const taken = withdrawal(10);
      await synced(db, {
        stripeId,
        paymentId,
        status: 'needs_response',
        transactions: [taken],
        ...opening,
      });
      return { stripeId, taken };
    });

  it('refuses a transfer while a dispute of the payment is open, and lets it go when the shop wins', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    const { stripeId, taken } = await openDispute(paymentId);

    const refused = await refund(card.id);
    const seen: Card = (await get(`/api/returns/${card.id}`)).json();

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
    expect(seen).toMatchObject({ disputeOpen: true, handRefundPending: false });
    expect(await refundsOf(paymentId)).toEqual([]);

    // the bank decides for the shop and gives the money back to it
    await inCommittedTx((db) =>
      synced(db, {
        stripeId,
        paymentId,
        status: 'won',
        transactions: [taken, reinstatement(10)],
      }),
    );
    const sent = await refund(card.id);

    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ disputeOpen: false, refundedTotal: 10 });
    expect(sent.json().items[0]).toMatchObject({ money: 'refunded' });
  });

  it('lets a transfer go while the provider says the disputed payment can still be refunded', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    await openDispute(paymentId, {
      status: 'warning_needs_response',
      refundable: true,
      transactions: [],
    });

    const res = await refund(card.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ disputeOpen: true });
    expect(res.json().items[0]).toMatchObject({ money: 'refunded' });
  });

  mockOnly(
    'refuses money sent outside the app while a dispute of the payment is open',
    async () => {
      const { orderId, itemId, paymentId } = await paidByCard(1);
      const card = await comeBack(orderId, itemId, 1);
      queueRefundOutcome({ status: 'failed', reason: 'lost_or_stolen_card' });
      await refund(card.id);
      await openDispute(paymentId);
      const { paidAt } = await asAdmin((tx) =>
        tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
      );

      const res = await outside(card.id, {
        method: 'cash',
        note: 'In the shop.',
        at: paidAt!.toISOString(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
    },
  );

  it('refuses a transfer and money sent outside while a refund made by hand waits for root', async () => {
    const { orderId, itemId, paymentId } = await paidByCard(2);
    const card = await comeBack(orderId, itemId, 1);
    await inCommittedTx((db) => handRefundOf(db, paymentId, 5));
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );

    const refused = await refund(card.id);
    const seen: Card = (await get(`/api/returns/${card.id}`)).json();

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_HAND_REFUND_PENDING' });
    expect(seen).toMatchObject({ disputeOpen: false, handRefundPending: true });
    // nothing was asked of Stripe (the refund made by hand is written in the database only here)
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(
      (
        await outside(card.id, {
          itemIds: [card.items[0]!.id],
          method: 'cash',
          note: 'In the shop.',
          at: paidAt!.toISOString(),
        })
      ).json(),
    ).toMatchObject({ errorCode: 'RETURN_HAND_REFUND_PENDING' });
  });

  // Stripe refuses a refund of a payment the buyer disputed at the bank (the card of a dispute): the
  // rows wait with the reason, the dispute settles it; the buyer is not told the shop cannot send it
  it('leaves the rows failed with the dispute as the reason, and mails nothing', async () => {
    const { orderId, itemId } = await paidByCard(1, DISPUTED_CARD);
    const card = await comeBack(orderId, itemId, 1);
    const mails = watchMail();

    const failed = await refund(card.id);

    expect(failed.statusCode).toBe(200);
    expect(failed.json().items[0]).toMatchObject({
      money: 'failed',
      refundFailure: { code: 'disputed' },
    });
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toEqual([]);
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
    expect(byAdmin.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(byBuyer.statusCode).toBe(403);
  });

  it('is done by an admin root allowed to handle the money too', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const card = await statementOf(orderId, itemId, 1);

    const res = await closeRows(
      card.id,
      { code: 'goods_not_returned', note: 'Never sent.' },
      manager,
    );

    expect(res.statusCode).toBe(200);
  });
});

describe('the goods taken in close the statement', () => {
  it('mails the buyer which units did not come back and why, when the last row is settled by the goods', async () => {
    const { orderId, itemId } = await paidByCard(1);
    const made = await statementOf(orderId, itemId, 1);
    const mails = watchMail();

    const res = await post(`/api/returns/${made.id}/receive`, {
      parcel: { buyerPaid: 0 },
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
  // the request reached Stripe but the answer did not come back: the lines wait in transit without
  // an id, and the event carries the key of the transfer in the metadata of the refund
  async function pendingWithoutId() {
    const { orderId, itemId } = await paidByCard(1);
    const card = await comeBack(orderId, itemId, 1);
    await withStripeOutOfReach(() => refund(card.id));
    const line = await asAdmin((tx) =>
      tx.moneyLog.findFirstOrThrow({
        where: { returnId: card.id, event: 'money.refund', part: 'goods' },
        select: { transferKey: true },
      }),
    );
    return { card, orderId, transfer: line.transferKey! };
  }

  // the money of the rows and the line it stands on
  const rowsOf = async (returnId: number) => {
    const card: Card = (await get(`/api/returns/${returnId}`)).json();
    return card.items.map((row, index) => {
      const line = lineOfRow(card, index);
      return {
        money: row.money,
        event: line?.event ?? null,
        refundId: line?.refundId ?? null,
        failure: line?.failure ?? null,
      };
    });
  };

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
      { money: 'refunded', event: 'money.refund', refundId: 're_test_early', failure: null },
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
      {
        money: 'failed',
        event: 'money.refund_failed',
        refundId: 're_test_failed',
        failure: 'shop_balance',
      },
    ]);
  });
});
