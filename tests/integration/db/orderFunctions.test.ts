import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type DbSession, type Actor } from '../../helpers/db.js';
import {
  cartOf,
  confirm,
  itemsTotalOf,
  orderDatesOf,
  orderStateOf,
  paidOrderOf,
  pay,
  stockOf,
  waitingOrderOf,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the steps of an order the database takes itself, each a function that acts as the owner and
// checks the actor first: confirm_order (the owner, reserves the stock), cancel_order_payment (the
// owner, gives the reserve back), unconfirm_order and expire_order_reservation (the system as an
// admin, give the reserve back), pay_order (the system as an admin, sells the reserved stock),
// cancel_paid_order (an admin, puts the stock back), refresh_order_prices (the owner, takes the
// prices of the catalog for an unconfirmed order)

let owner: TestUser;
let other: TestUser;
let admin: TestUser;
let product: TestProduct;
let cheap: TestProduct;
let scarce: TestProduct;
let removed: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10, stock: 10 });
  cheap = await createProduct({ price: 4, stock: 10 });
  scarce = await createProduct({ price: 5, stock: 2 });
  removed = await createProduct({ price: 7, stock: 10 });
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, other.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asOwner = (): Actor => ({ role: 'USER', userId: owner.id });
// the system: the admin context without a user id, the way setAdminContext sets it
const asSystem = (): Actor => ({ role: 'ADMIN' });

// a function called as the actor, the error text when it refuses
async function call(db: DbSession, actor: Actor, statement: string, ...values: unknown[]) {
  await db.as(actor);
  const outcome = await db.attempt<Record<string, unknown>>(statement, ...values);
  return outcome.ok ? { ok: true, row: outcome.rows[0] } : { ok: false, error: outcome.message };
}

// an order of the owner that lost its reservation: confirmed, then given back by the system
async function unconfirmedOrderOf(db: DbSession, items: [number, number][]) {
  const orderId = await waitingOrderOf(db, owner.id, items);
  await call(db, asSystem(), 'select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
  return orderId;
}

const setStatus = async (db: DbSession, orderId: number, status: string) => {
  await db.as(asAdmin());
  await db.rows(
    `update cartlify.orders set status = $2::cartlify."OrderStatus" where id = $1 returning id`,
    orderId,
    status,
  );
};

describe('an update of a product while a payment holds its row', () => {
  // the update waits for the row and then changes the version the payment left. A policy that
  // read the old row again saw the version from the start of the statement: the stock the payment
  // took looked changed by the update, and it failed with 42501. A view of the card and a cart
  // that counts the popularity again write the row with a single statement like that
  async function whilePaymentHoldsTheRow(update: (db: DbSession, productId: number) => Promise<unknown>) {
    const own = await createProduct({ price: 10, stock: 5 });
    const paying = await inCommittedTx((db) => waitingOrderOf(db, owner.id, [[own.id, 1]]));
    const amount = await inCommittedTx((db) => itemsTotalOf(db, admin.id, paying));

    let paid!: () => void;
    let release!: () => void;
    const paidNow = new Promise<void>((resolve) => (paid = resolve));
    const mayCommit = new Promise<void>((resolve) => (release = resolve));

    const payment = inCommittedTx(async (db) => {
      const result = await pay(db, admin.id, paying, { amount });
      paid();
      await mayCommit;
      return result;
    });
    await paidNow;

    const other = inCommittedTx((db) => update(db, own.id));

    for (let tries = 0; tries < 100; tries += 1) {
      const [waiting] = await prisma.$queryRaw<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%cartlify.%' and query not like '%pg_stat_activity%'
      `;
      if (waiting!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();

    return { payment: await payment, other: await other, productId: own.id };
  }

  it('counts the view of a buyer', async () => {
    const outcome = await whilePaymentHoldsTheRow(async (db, productId) => {
      await db.as({ role: 'GUEST', guestId: randomUUID() });
      return db.attempt(
        'update cartlify.products set views = views + 1 where id = $1 returning views',
        productId,
      );
    });

    expect(outcome.payment).toBe('PAID');
    expect(outcome.other).toMatchObject({ ok: true, rows: [{ views: 1 }] });
  });

  it('takes an item into a cart, counting the popularity again', async () => {
    const outcome = await whilePaymentHoldsTheRow(async (db, productId) => {
      await db.as({ role: 'USER', userId: other.id });
      const [order] = await db.rows<{ id: number }>(
        'insert into cartlify.orders ("userId", total) values ($1, 0) returning id',
        other.id,
      );
      return db.attempt(
        `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, 1, 0, 0) returning id`,
        order!.id,
        productId,
      );
    });

    expect(outcome.payment).toBe('PAID');
    expect(outcome.other).toMatchObject({ ok: true });
  });
});

describe('cartlify.confirm_order', () => {
  // a payment and a confirmation of the same product at the same moment: the confirmation waits
  // for the row of the product and then changes the version the payment left. A rule of the
  // policies that read the old row again saw the version from the start of the statement, the
  // popularity looked changed by the confirmation and it failed with 42501
  it('reserves a product while a payment of the same product holds its row', async () => {
    const own = await createProduct({ price: 10, stock: 5 });
    const paying = await inCommittedTx((db) => waitingOrderOf(db, owner.id, [[own.id, 1]]));
    const amount = await inCommittedTx((db) => itemsTotalOf(db, admin.id, paying));
    const cart = await inCommittedTx((db) => cartOf(db, other.id, [[own.id, 1]]));

    let paid!: () => void;
    let release!: () => void;
    const paidNow = new Promise<void>((resolve) => (paid = resolve));
    const mayCommit = new Promise<void>((resolve) => (release = resolve));

    const payment = inCommittedTx(async (db) => {
      const result = await pay(db, admin.id, paying, { amount });
      paid();
      await mayCommit;
      return result;
    });
    await paidNow;

    const confirmation = inCommittedTx((db) => confirm(db, other.id, cart));

    // the confirmation waits for the row of the product
    for (let tries = 0; tries < 100; tries += 1) {
      const [waiting] = await prisma.$queryRaw<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%confirm_order%'
      `;
      if (waiting!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();

    expect(await payment).toBe('PAID');
    expect(await confirmation).toMatchObject({ ok: true });
    expect(await inCommittedTx((db) => stockOf(db, admin.id, own.id))).toEqual({
      stock: 4,
      reserved: 1,
    });
  });

  it('confirms an own cart: it waits for its payment for the time asked, the stock is reserved', async () => {
    const { outcome, state, left, stock } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [
        [product.id, 2],
        [cheap.id, 1],
      ]);
      const outcome = await confirm(db, owner.id, orderId);
      const state = await orderStateOf(db, admin.id, orderId);
      const [left] = await db.rows<{ seconds: number }>(
        `select extract(epoch from ("reservationExpiresAt" - clock_timestamp()::timestamp))::float8 as seconds
         from cartlify.orders where id = $1`,
        orderId,
      );
      return {
        outcome,
        state,
        left: left!.seconds,
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome.ok).toBe(true);
    expect(state).toMatchObject({ status: 'waiting', confirmed: true, reserved: true, total: 24 });
    expect(left).toBeGreaterThan(14 * 60);
    expect(left).toBeLessThanOrEqual(15 * 60);
    expect(stock).toEqual({ stock: 10, reserved: 2 });
  });

  it('confirms again an order that lost its reservation', async () => {
    const { outcome, state } = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrderOf(db, [[product.id, 1]]);
      const outcome = await confirm(db, owner.id, orderId);
      return { outcome, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(outcome.ok).toBe(true);
    expect(state).toMatchObject({ status: 'waiting', reserved: true });
  });

  it('refuses the order of another user as not found, and reserves nothing', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, other.id, [[product.id, 2]]);
      const outcome = await confirm(db, owner.id, orderId);
      return { outcome, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_NOT_FOUND'),
    });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it.each([
    ['an admin', () => asAdmin()],
    ['a root', (): Actor => ({ role: 'ROOT', userId: admin.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        actor(),
        `select 1 as done from cartlify.confirm_order($1::int, interval '15 minutes')`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_CONFIRM_FORBIDDEN'),
    });
  });

  it('refuses an order without where it goes, and reserves nothing', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 2]], { delivery: false });
      const outcome = await confirm(db, owner.id, orderId);
      return { outcome, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_DELIVERY_REQUIRED'),
    });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it('refuses an empty order', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, []);
      return confirm(db, owner.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_ITEMS_REQUIRED'),
    });
  });

  it('refuses more than the free stock and reserves nothing of the other items', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [
        [product.id, 2],
        [scarce.id, 3],
      ]);
      const outcome = await confirm(db, owner.id, orderId);
      return { outcome, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('INSUFFICIENT_AVAILABLE_STOCK'),
    });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it('refuses an order whose prices changed since the items went in', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      await db.as(asAdmin());
      await db.rows(
        'update cartlify.products set price = 12 where id = $1 returning id',
        product.id,
      );
      return confirm(db, owner.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_PRICES_CHANGED'),
    });
  });

  it('refuses a product removed from the catalog since it went in', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[removed.id, 1]]);
      await db.as(asAdmin());
      await db.rows(
        'update cartlify.products set "deletedAt" = now() where id = $1 returning id',
        removed.id,
      );
      return confirm(db, owner.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRODUCT_NOT_FOUND'),
    });
  });

  it('refuses an order that is confirmed already', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return confirm(db, owner.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_ALREADY_CONFIRMED'),
    });
  });

  it.each(['0 seconds', '-1 minute'])('refuses a reservation of %s', async (reserveFor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      return confirm(db, owner.id, orderId, reserveFor);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_RESERVATION_DURATION_INVALID'),
    });
  });
});

describe('cartlify.cancel_order_payment', () => {
  it('lets the owner cancel the payment: the order is unconfirmed, its reserve goes back', async () => {
    const { outcome, state, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      const outcome = await call(
        db,
        asOwner(),
        'select 1 as done from cartlify.cancel_order_payment($1::int)',
        orderId,
      );
      return {
        outcome,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome.ok).toBe(true);
    expect(state).toMatchObject({ status: 'unconfirmed', confirmed: false, reserved: false });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it('refuses the order of another user as not found, and its reserve stays', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, other.id, [[product.id, 2]]);
      const outcome = await call(
        db,
        asOwner(),
        'select 1 as done from cartlify.cancel_order_payment($1::int)',
        orderId,
      );
      return { outcome, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('ORDER_NOT_FOUND') });
    expect(stock).toEqual({ stock: 10, reserved: 2 });
  });

  it('refuses a paid order', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      return call(
        db,
        asOwner(),
        'select 1 as done from cartlify.cancel_order_payment($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_ALREADY_PAID'),
    });
  });

  it('refuses an order that does not wait for a payment', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        asOwner(),
        'select 1 as done from cartlify.cancel_order_payment($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_STATUS_NOT_WAITING'),
    });
  });

  it.each(['ADMIN', 'ROOT'] as const)('refuses an %s', async (role) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        { role, userId: owner.id },
        'select 1 as done from cartlify.cancel_order_payment($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_CANCEL_PAYMENT_FORBIDDEN'),
    });
  });
});

describe('cartlify.unconfirm_order', () => {
  it('lets the system take back a reservation: the order is unconfirmed, its reserve goes back', async () => {
    const { outcome, state, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      const outcome = await call(
        db,
        asSystem(),
        'select 1 as done from cartlify.unconfirm_order($1::int)',
        orderId,
      );
      return {
        outcome,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome.ok).toBe(true);
    expect(state).toMatchObject({ status: 'unconfirmed', confirmed: false, reserved: false });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it('refuses a user, also the owner', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        asOwner(),
        'select 1 as done from cartlify.unconfirm_order($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_UNCONFIRM_FORBIDDEN'),
    });
  });

  // the system is the admin context without an id; a signed-in admin or root has one
  it.each(['ADMIN', 'ROOT'] as const)('refuses a signed-in %s', async (role) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        { role, userId: admin.id },
        'select 1 as done from cartlify.unconfirm_order($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_UNCONFIRM_FORBIDDEN'),
    });
  });

  it.each([
    ['a cart', 'ORDER_NOT_CONFIRMED'],
    ['a paid order', 'ORDER_STATUS_NOT_WAITING'],
  ])('refuses %s', async (stage, error) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId =
        stage === 'a cart'
          ? await cartOf(db, owner.id, [[product.id, 1]])
          : await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      return call(
        db,
        asSystem(),
        'select 1 as done from cartlify.unconfirm_order($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining(error) });
  });
});

describe('cartlify.expire_order_reservation', () => {
  it('releases a reservation whose time is over', async () => {
    const { outcome, state, stock } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 2]]);
      await confirm(db, owner.id, orderId, '1 millisecond');
      await db.rows('select 1 as done from pg_sleep(0.05)');
      const outcome = await call(
        db,
        asSystem(),
        'select cartlify.expire_order_reservation($1::int) as expired',
        orderId,
      );
      return {
        outcome,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome).toEqual({ ok: true, row: { expired: true } });
    expect(state).toMatchObject({ status: 'unconfirmed', reserved: false });
    expect(stock).toEqual({ stock: 10, reserved: 0 });
  });

  it('leaves a reservation whose time is not over', async () => {
    const { outcome, state, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      const outcome = await call(
        db,
        asSystem(),
        'select cartlify.expire_order_reservation($1::int) as expired',
        orderId,
      );
      return {
        outcome,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome).toEqual({ ok: true, row: { expired: false } });
    expect(state).toMatchObject({ status: 'waiting', reserved: true });
    expect(stock).toEqual({ stock: 10, reserved: 2 });
  });

  it('leaves a paid order', async () => {
    const { outcome, state } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      const outcome = await call(
        db,
        asSystem(),
        'select cartlify.expire_order_reservation($1::int) as expired',
        orderId,
      );
      return { outcome, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(outcome).toEqual({ ok: true, row: { expired: false } });
    expect(state).toMatchObject({ status: 'paid' });
  });

  // the timer of an order its owner deleted runs later: a stale job like any other, not an error
  // the worker would repeat
  it('answers false for an order that is gone', async () => {
    const outcome = await inRolledBackTx((db) =>
      call(db, asSystem(), 'select cartlify.expire_order_reservation($1::int) as expired', 2_147_483_647),
    );

    expect(outcome).toEqual({ ok: true, row: { expired: false } });
  });

  it('refuses a user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return call(db, asOwner(), 'select cartlify.expire_order_reservation($1::int)', orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_EXPIRE_FORBIDDEN'),
    });
  });

  it.each(['ADMIN', 'ROOT'] as const)('refuses a signed-in %s', async (role) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      await confirm(db, owner.id, orderId, '1 millisecond');
      await db.rows('select 1 as done from pg_sleep(0.05)');
      return call(
        db,
        { role, userId: admin.id },
        'select cartlify.expire_order_reservation($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_EXPIRE_FORBIDDEN'),
    });
  });
});

describe('cartlify.pay_order', () => {
  it('pays an order that waits: the payment is written, the reserved stock is sold', async () => {
    const { result, state, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      const result = await pay(db, admin.id, orderId, { paymentId: 'pi_db_paid' });
      return {
        result,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(result).toBe('PAID');
    expect(state).toEqual({
      status: 'paid',
      confirmed: true,
      reserved: false,
      total: 20,
      paymentProvider: 'stripe',
      paymentId: 'pi_db_paid',
    });
    expect(stock).toEqual({ stock: 8, reserved: 0 });
  });

  // the reports of a period count a sale from the time it was paid
  it('stamps the time of the payment, the time of its transaction in utc', async () => {
    const dates = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      const before = await orderDatesOf(db, admin.id, orderId);
      await pay(db, admin.id, orderId);
      return { before, after: await orderDatesOf(db, admin.id, orderId) };
    });

    expect(dates.before).toMatchObject({ paidAt: null, cancelledAt: null });
    expect(dates.after).toEqual({
      paidAt: dates.after.now,
      cancelledAt: null,
      now: dates.after.now,
    });
  });

  it('refuses an amount other than the one of the items, and changes nothing', async () => {
    const { result, state, dates, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      const result = await pay(db, admin.id, orderId, { amount: '19.99' });
      return {
        result,
        state: await orderStateOf(db, admin.id, orderId),
        dates: await orderDatesOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(result).toBe('AMOUNT_MISMATCH');
    expect(state).toMatchObject({ status: 'waiting', paymentId: null });
    expect(dates.paidAt).toBeNull();
    expect(stock).toEqual({ stock: 10, reserved: 2 });
  });

  it('takes a repeated delivery of the same payment once', async () => {
    const { again, stock } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      await pay(db, admin.id, orderId, { paymentId: 'pi_db_once' });
      const again = await pay(db, admin.id, orderId, { paymentId: 'pi_db_once', amount: '20' });
      return { again, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(again).toBe('ALREADY_PAID_SAME_PAYMENT');
    expect(stock).toEqual({ stock: 8, reserved: 0 });
  });

  it.each([
    ['another payment id', { paymentId: 'pi_db_second' }],
    ['the same id at another provider', { paymentId: 'pi_db_first', provider: 'liqpay' }],
  ])('tells %s of a paid order apart', async (_case, second) => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      await pay(db, admin.id, orderId, { paymentId: 'pi_db_first' });
      return pay(db, admin.id, orderId, { ...second, amount: '10' });
    });

    expect(result).toBe('ALREADY_PAID_OTHER_PAYMENT');
  });

  it('takes a late payment of an order that lost its reservation while the stock is there', async () => {
    const { result, state, dates, stock } = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrderOf(db, [[product.id, 2]]);
      const result = await pay(db, admin.id, orderId);
      return {
        result,
        state: await orderStateOf(db, admin.id, orderId),
        dates: await orderDatesOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(result).toBe('PAID');
    expect(state).toMatchObject({ status: 'paid', confirmed: true, reserved: false });
    expect(dates.paidAt).toBe(dates.now);
    expect(stock).toEqual({ stock: 8, reserved: 0 });
  });

  it('refuses a late payment when the stock is gone, and changes nothing', async () => {
    const { result, state, dates, stock } = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrderOf(db, [[scarce.id, 2]]);
      await waitingOrderOf(db, other.id, [[scarce.id, 2]]);
      const result = await pay(db, admin.id, orderId);
      return {
        result,
        state: await orderStateOf(db, admin.id, orderId),
        dates: await orderDatesOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, scarce.id),
      };
    });

    expect(result).toBe('OUT_OF_STOCK');
    expect(state).toMatchObject({ status: 'unconfirmed', paymentId: null });
    expect(dates.paidAt).toBeNull();
    expect(stock).toEqual({ stock: 2, reserved: 2 });
  });

  it('refuses a cart without where it goes', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { delivery: false });
      return pay(db, admin.id, orderId);
    });

    expect(result).toBe('ORDER_NOT_PAYABLE');
  });

  it('refuses a payment id that paid another order already', async () => {
    const result = await inRolledBackTx(async (db) => {
      const first = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      const second = await waitingOrderOf(db, owner.id, [[cheap.id, 1]]);
      await pay(db, admin.id, first, { paymentId: 'pi_db_shared' });
      return pay(db, admin.id, second, { paymentId: 'pi_db_shared' });
    });

    expect(result).not.toBe('PAID');
  });

  it.each([
    ['no payment id', { paymentId: '' }, 'ORDER_PAYMENT_ID_REQUIRED'],
    ['a payment id of spaces', { paymentId: '   ' }, 'ORDER_PAYMENT_ID_REQUIRED'],
  ])('refuses %s', async (_case, opts, error) => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return pay(db, admin.id, orderId, opts);
    });

    expect(result).toContain(error);
  });

  it('refuses a payment without its provider', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      return call(
        db,
        asSystem(),
        `select cartlify.pay_order($1::int, null, 'pi_db_none', 10)`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_PAYMENT_PROVIDER_REQUIRED'),
    });
  });

  it('answers ORDER_NOT_FOUND for an order that does not exist', async () => {
    const result = await inRolledBackTx((db) => pay(db, admin.id, 2_000_000_000, { amount: '10' }));

    expect(result).toBe('ORDER_NOT_FOUND');
  });

  // a provider delivers the same event twice at the same moment (stripe sends duplicates, the
  // callback of liqpay meets the status check of the return page): the second delivery waits for
  // the lock of the first and finds the order paid by the same payment. Taken as not payable, it
  // made the webhook refund a payment the order had just taken
  it('answers a delivery of the same payment at the same moment as a repeated one', async () => {
    // the payment is committed: a product of its own, the others of the file keep their stock
    const own = await createProduct({ price: 10, stock: 3 });
    const orderId = await inCommittedTx((db) => waitingOrderOf(db, owner.id, [[own.id, 1]]));
    const amount = await inCommittedTx((db) => itemsTotalOf(db, admin.id, orderId));
    const before = await inCommittedTx((db) => stockOf(db, admin.id, own.id));
    const paymentId = `pi_db_twice_${orderId}`;

    let paidFirst!: () => void;
    let releaseFirst!: () => void;
    const firstPaid = new Promise<void>((resolve) => (paidFirst = resolve));
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));

    // the first delivery pays and keeps its transaction open, the order row stays locked
    const first = inCommittedTx(async (db) => {
      const result = await pay(db, admin.id, orderId, { paymentId, amount });
      paidFirst();
      await firstMayCommit;
      return result;
    });
    await firstPaid;

    const second = inCommittedTx((db) => pay(db, admin.id, orderId, { paymentId, amount }));

    // the second one waits for the lock of the first before the first commits
    for (let tries = 0; tries < 100; tries += 1) {
      const [waiting] = await prisma.$queryRaw<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%pay_order%'
      `;
      if (waiting!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseFirst();

    expect(await first).toBe('PAID');
    expect(await second).toBe('ALREADY_PAID_SAME_PAYMENT');

    const after = await inCommittedTx(async (db) => ({
      state: await orderStateOf(db, admin.id, orderId),
      stock: await stockOf(db, admin.id, own.id),
    }));
    expect(after.state).toMatchObject({ status: 'paid', paymentId });
    // the unit is sold once
    expect(after.stock.stock).toBe(before.stock - 1);
  });

  // a payment comes only from a provider, through the webhook that acts as the system
  it.each([
    ['the owner', () => asOwner()],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
    ['a signed-in admin', () => asAdmin()],
    ['a signed-in root', (): Actor => ({ role: 'ROOT', userId: admin.id })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      const amount = await itemsTotalOf(db, admin.id, orderId);
      return call(
        db,
        actor(),
        `select cartlify.pay_order($1::int, 'stripe', 'pi_db_forged', $2::numeric)`,
        orderId,
        amount,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_PAY_FORBIDDEN'),
    });
  });
});

describe('cartlify.cancel_paid_order', () => {
  it.each(['paid', 'shipped'] as const)(
    'cancels a %s order and puts its stock back',
    async (stage) => {
      const { outcome, state, dates, stock } = await inRolledBackTx(async (db) => {
        const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 2]]);
        if (stage === 'shipped') await setStatus(db, orderId, 'shipped');
        const outcome = await call(
          db,
          asAdmin(),
          'select 1 as done from cartlify.cancel_paid_order($1::int)',
          orderId,
        );
        return {
          outcome,
          state: await orderStateOf(db, admin.id, orderId),
          dates: await orderDatesOf(db, admin.id, orderId),
          stock: await stockOf(db, admin.id, product.id),
        };
      });

      expect(outcome.ok).toBe(true);
      expect(state).toMatchObject({ status: 'cancelled', paymentId: expect.any(String) });
      // the time of the cancel next to the time of the payment, which stays
      expect(dates).toEqual({ paidAt: dates.now, cancelledAt: dates.now, now: dates.now });
      expect(stock).toEqual({ stock: 10, reserved: 0 });
    },
  );

  it.each([
    ['a delivered order', 'delivered', 'ORDER_ALREADY_DELIVERED'],
    ['a cancelled order', 'cancelled', 'ORDER_ALREADY_CANCELLED'],
    ['an order that waits for its payment', 'waiting', 'ORDER_NOT_PAID'],
  ])('refuses %s', async (_case, stage, error) => {
    const { outcome, stock, dates } = await inRolledBackTx(async (db) => {
      let orderId: number;
      if (stage === 'waiting') {
        orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      } else {
        orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 2]]);
        if (stage === 'delivered') {
          await setStatus(db, orderId, 'shipped');
          await setStatus(db, orderId, 'delivered');
        }
        if (stage === 'cancelled')
          await call(
            db,
            asAdmin(),
            'select 1 as done from cartlify.cancel_paid_order($1::int)',
            orderId,
          );
      }
      const before = await stockOf(db, admin.id, product.id);
      const datesBefore = await orderDatesOf(db, admin.id, orderId);
      const outcome = await call(
        db,
        asAdmin(),
        'select 1 as done from cartlify.cancel_paid_order($1::int)',
        orderId,
      );
      const after = await stockOf(db, admin.id, product.id);
      return {
        outcome,
        stock: { before, after },
        dates: { before: datesBefore, after: await orderDatesOf(db, admin.id, orderId) },
      };
    });

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    expect(stock.after).toEqual(stock.before);
    expect(dates.after).toEqual(dates.before);
  });

  it('refuses a user, also the owner', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      return call(
        db,
        asOwner(),
        'select 1 as done from cartlify.cancel_paid_order($1::int)',
        orderId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('ORDER_CANCEL_FORBIDDEN'),
    });
  });
});

describe('cartlify.refresh_order_prices', () => {
  it('takes the prices of the catalog for an own unconfirmed order and counts its total again', async () => {
    const { outcome, state } = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrderOf(db, [[product.id, 2]]);
      await db.as(asAdmin());
      await db.rows(
        'update cartlify.products set price = 12 where id = $1 returning id',
        product.id,
      );
      const outcome = await call(
        db,
        asOwner(),
        'select cartlify.refresh_order_prices($1::int) as refreshed',
        orderId,
      );
      return { outcome, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(outcome).toEqual({ ok: true, row: { refreshed: 1 } });
    expect(state).toMatchObject({ total: 24 });
  });

  it.each([
    ['an own order that waits for its payment', 'waiting'],
    ['the cart of another user', 'foreign'],
  ])('changes no price of %s', async (_case, stage) => {
    const { outcome, state } = await inRolledBackTx(async (db) => {
      const orderId =
        stage === 'waiting'
          ? await waitingOrderOf(db, owner.id, [[product.id, 2]])
          : await cartOf(db, other.id, [[product.id, 2]]);
      await db.as(asAdmin());
      await db.rows(
        'update cartlify.products set price = 12 where id = $1 returning id',
        product.id,
      );
      const outcome = await call(
        db,
        asOwner(),
        'select cartlify.refresh_order_prices($1::int) as refreshed',
        orderId,
      );
      return { outcome, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(outcome).toMatchObject({ row: { refreshed: 0 } });
    expect(state).toMatchObject({ total: 20 });
  });
});
