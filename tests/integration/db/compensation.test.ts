import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  paidOrderOf,
  waitingOrderOf,
  type DeliveryRule,
  type Items,
} from '../../helpers/dbOrders.js';
import {
  SYSTEM,
  begun,
  call,
  handRefundOf,
  itemIdsOf,
  lineOf,
  linesWhere,
  newDisputeId,
  settledOf,
  shopCancelOf,
  synced,
  withdrawal,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The compensation root gives by the button of the app, and the
// money of a refund that failed sent another way. All in transactions that roll back.
//
// cartlify.begin_compensation(p_order_id integer, p_key text, p_amount numeric, p_currency text)
//   Root or an admin with the right of the money, with an account (COMPENSATION_FORBIDDEN, the
//   system too). The order has a payment of the provider (COMPENSATION_ORDER_INVALID otherwise); the
//   sum is above 0 to the cent (COMPENSATION_AMOUNT_INVALID) and at most what is left of the payment
//   (COMPENSATION_EXCEEDS_PAID: the provider gives back no more than it took); nothing while a dispute
//   of the payment is open at the bank that does not let it be refunded (COMPENSATION_DISPUTED). One
//   line money.refund of the purpose compensation, all of the sum below 0, in transit, with the key
//   of the request (the same key answers the line there, created false). Its end is the end of every
//   refund of the app (settle_money_refund). The answer is { id, created, state, refundId, orderId,
//   userId, provider, paymentId, currency, amount }.
//
// cartlify.mark_payment_refund_outside: the failure of a compensation goes another way as the one of
// a late payment or of a refund made by hand. The limit of the payment holds for the provider only:
// it refuses only when the buyer has the money already (the bank gave the payment back for a
// dispute, PAYMENT_REFUND_NOT_FAILED), not when other refunds used what is left of the payment.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });

// two units at 10 and a delivery of 5: an order of 25
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

async function soldOrder(db: DbSession) {
  const items: Items = [[product.variantId, 2]];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  return {
    orderId,
    paymentId: `pi_db_${orderId}`,
    itemIds: await itemIdsOf(db, admin.id, orderId),
  };
}

const BEGIN = `select cartlify.begin_compensation($1::int, $2, $3::numeric, 'eur') as result`;
const OUTSIDE = `select cartlify.mark_payment_refund_outside($1::int, $2::cartlify."OutsideMethod", $3, (now() at time zone 'UTC')::timestamp(3)) as result`;

const compensateAs = (
  db: DbSession,
  actor: Actor,
  orderId: number,
  amount: unknown,
  key = `compensation:${orderId}:${String(amount)}`,
) => call<{ result: Record<string, unknown> }>(db, actor, BEGIN, orderId, key, amount);

async function compensated(db: DbSession, orderId: number, amount: number, key?: string) {
  const outcome = await compensateAs(db, asRoot(), orderId, amount, key);
  if (!outcome.ok) throw new Error(`begin_compensation refused: ${outcome.message}`);
  return outcome.rows[0]!.result as { id: number; created: boolean; amount: string };
}

describe('begin_compensation', () => {
  it('writes one line of the compensation in transit with the key, and the same key answers it again', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db);
      const first = await compensated(db, orderId, 7.5, 'compensation:one');
      const again = await compensated(db, orderId, 7.5, 'compensation:one');
      return { orderId, paymentId, first, again, line: await lineOf(db, admin.id, first.id) };
    });

    expect(out.first).toMatchObject({
      created: true,
      state: 'in_transit',
      refundId: null,
      orderId: out.orderId,
      userId: buyer.id,
      provider: 'stripe',
      paymentId: out.paymentId,
      currency: 'eur',
      amount: '7.50',
    });
    expect(out.again).toMatchObject({ id: out.first.id, created: false, state: 'in_transit' });
    expect(out.line).toMatchObject({
      event: 'money.refund',
      purpose: 'compensation',
      part: 'whole',
      amount: '-7.50',
      state: 'in_transit',
      transferKey: 'compensation:one',
      returnId: null,
      actorId: root.id,
    });
  });

  it('is settled as every refund of the app: sent, or failed and sent another way', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db);
      const sent = await compensated(db, orderId, 5, 'compensation:sent');
      await settledOf(db, 'compensation:sent', 're_comp_sent', 'succeeded');
      const failing = await compensated(db, orderId, 3, 'compensation:failing');
      const failed = await settledOf(db, 'compensation:failing', 're_comp_failed', 'failed');
      const outside = await call(
        db,
        asRoot(),
        OUTSIDE,
        failing.id,
        'bank_transfer',
        'To the account of the buyer.',
      );
      return {
        sent: await lineOf(db, admin.id, sent.id),
        failed,
        outside,
        lines: await linesWhere(db, admin.id, '"coversId" = $1', failing.id),
      };
    });

    expect(out.sent).toMatchObject({ state: 'sent', refundId: 're_comp_sent' });
    expect(out.failed).toMatchObject({ changed: true, purpose: 'compensation' });
    expect(out.outside.ok).toBe(true);
    expect(out.lines.map((l) => [l.event, l.purpose, l.amount])).toEqual([
      ['money.refund_failed', 'compensation', '3.00'],
      ['money.outside', 'compensation', '-3.00'],
    ]);
  });

  it('gives back no more than is left of the payment', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db);
      const over = await compensateAs(db, asRoot(), orderId, 25.01);
      await handRefundOf(db, paymentId, 20);
      const afterHand = await compensateAs(db, asRoot(), orderId, 5.01);
      const all = await compensateAs(db, asRoot(), orderId, 5);
      return { over, afterHand, all };
    });

    expect(out.over).toMatchObject(refused('COMPENSATION_EXCEEDS_PAID'));
    expect(out.afterHand).toMatchObject(refused('COMPENSATION_EXCEEDS_PAID'));
    expect(out.all.ok).toBe(true);
  });

  it('waits while a dispute of the payment is open at the bank', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db);
      const snapshot = {
        stripeId: newDisputeId(),
        paymentId,
        status: 'needs_response' as const,
        transactions: [withdrawal(25)],
      };
      await synced(db, snapshot);
      const open = await compensateAs(db, asRoot(), orderId, 5);
      await synced(db, { ...snapshot, status: 'won' });
      return { open };
    });

    expect(out.open).toMatchObject(refused('COMPENSATION_DISPUTED'));
  });

  it.each([[0], [-1], [1.234], [null]])('refuses a sum %p', async (amount) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db);
      return compensateAs(db, asRoot(), orderId, amount);
    });

    expect(outcome).toMatchObject(refused('COMPENSATION_AMOUNT_INVALID'));
  });

  it('refuses an order that is not there, or one with no payment', async () => {
    const out = await inRolledBackTx(async (db) => {
      const unpaid = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]], DELIVERY);
      return {
        none: await compensateAs(db, asRoot(), 2_147_483_000, 5),
        unpaid: await compensateAs(db, asRoot(), unpaid, 5),
      };
    });

    expect(out.none).toMatchObject(refused('COMPENSATION_ORDER_INVALID'));
    expect(out.unpaid).toMatchObject(refused('COMPENSATION_ORDER_INVALID'));
  });

  // the one who gave it settles it with the answer of the provider; the webhook and the worker too
  it('is settled by root and by the system, not by an admin without the right of the money (MONEY_FORBIDDEN)', async () => {
    const SETTLE = `select cartlify.settle_money_refund(
      $1, $2, 'succeeded', null::cartlify."RefundFailure", null) as result`;
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db);
      const one = await compensated(db, orderId, 5, 'compensation:by-admin');
      const byAdmin = await call(
        db,
        { role: 'ADMIN', userId: admin.id },
        SETTLE,
        'compensation:by-admin',
        're_comp_admin',
      );
      const untouched = await lineOf(db, admin.id, one.id);
      const byRoot = await call(db, asRoot(), SETTLE, 'compensation:by-admin', 're_comp_admin');
      await compensated(db, orderId, 3, 'compensation:by-system');
      const bySystem = await call(db, SYSTEM, SETTLE, 'compensation:by-system', 're_comp_system');
      return { byAdmin, untouched, byRoot, bySystem };
    });

    expect(out.byAdmin).toMatchObject(refused('MONEY_FORBIDDEN'));
    expect(out.untouched).toMatchObject({ state: 'in_transit' });
    expect(out.byRoot.ok).toBe(true);
    expect(out.bySystem.ok).toBe(true);
  });

  it('is for root and a money admin: an admin without the right, a buyer and the system are refused', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db);
      const byAdmin = await compensateAs(db, { role: 'ADMIN', userId: admin.id }, orderId, 5);
      const byBuyer = await compensateAs(db, { role: 'USER', userId: buyer.id }, orderId, 5);
      const bySystem = await compensateAs(db, SYSTEM, orderId, 5);
      return { admin: byAdmin, buyer: byBuyer, system: bySystem };
    });

    expect(out.admin).toMatchObject(refused('COMPENSATION_FORBIDDEN'));
    expect(out.buyer).toMatchObject({ ok: false });
    expect(out.system).toMatchObject(refused('COMPENSATION_FORBIDDEN'));
  });
});

describe('the failure of a refund of the payment sent another way', () => {
  // the compensation failed, then the statement of the cancel took all that was left of the
  // payment: root may still send the compensation another way, the limit is the provider's only
  it('is taken when other refunds used what is left of the payment', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db);
      const failing = await compensated(db, orderId, 10, 'compensation:late');
      await settledOf(db, 'compensation:late', 're_comp_late', 'failed');
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, 're_cancel', 'succeeded');
      return call(
        db,
        asRoot(),
        OUTSIDE,
        failing.id,
        'bank_transfer',
        'To the account of the buyer.',
      );
    });

    expect(out.ok).toBe(true);
  });

  // the bank gave the buyer all of the payment for a dispute: the money is with the buyer already
  it('is refused when the bank gave the payment back for a dispute', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db);
      const failing = await compensated(db, orderId, 10, 'compensation:bank');
      await settledOf(db, 'compensation:bank', 're_comp_bank', 'failed');
      const snapshot = {
        stripeId: newDisputeId(),
        paymentId,
        status: 'needs_response' as const,
        transactions: [withdrawal(25)],
      };
      await synced(db, snapshot);
      await synced(db, { ...snapshot, status: 'lost' });
      return call(
        db,
        asRoot(),
        OUTSIDE,
        failing.id,
        'bank_transfer',
        'To the account of the buyer.',
      );
    });

    expect(out).toMatchObject(refused('PAYMENT_REFUND_NOT_FAILED'));
  });
});
