import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  receiveBatch,
  writeOffStock,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { orderRowOf, placeOrder } from '../../../helpers/orders.js';
import {
  cancelAndRefund,
  failReturnRefund,
  refundReturn,
  stockLinesOf,
} from '../../../helpers/returns.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// GET /api/admin/reports/accounting: what the shop sold in a period and what it cost, the returns
// that took money back, what came in and what was written off, and the stock. The money is read
// from the money journal by the time of its lines: a sale counts from the time it was paid (the
// lines of the payment), its cost from the batches it took, cancelled later or not; a return counts
// from the time its transfer was written (the lines of the goods of the transfers and of the money
// sent outside the app), a failure of the transfer gives it back in the period the failure came,
// and the sales less the returns are the net: an event is in the period it happened in and a
// return never changes the period its order was paid in. The stock is read from the stock log
// (opening, received, left, closing). The money is the money of the variants: a report of a
// product is the sum of its variants, one of some variants (variantIds) is theirs only. Other test
// files make orders and batches at the same time, so each test reads only its own products
// (productIds) or variants

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product without stock: the test takes in its own batches at its own costs
const newProduct = async (price = 10) => {
  const product = await createProduct({ price, stock: 0 });
  products.push(product);
  return product;
};

const report = (query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/reports/accounting?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

// the report of the products from a minute before the test until a minute after now
const reportOf = (ofProducts: TestProduct[], startedAt: number) =>
  report({
    from: new Date(startedAt - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    productIds: ofProducts.map((p) => p.id).join(','),
  });

const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const NOTHING = { units: 0, value: 0 };
const NO_RETURNS = { units: 0, revenue: 0, cost: 0 };
const NO_KINDS = {
  withdrawal: NO_RETURNS,
  refused: NO_RETURNS,
  defect: NO_RETURNS,
  wrong_item: NO_RETURNS,
  damaged: NO_RETURNS,
  goodwill: NO_RETURNS,
  shop_cancel: NO_RETURNS,
  other: NO_RETURNS,
};
const NO_STOCK = {
  opening: NOTHING,
  received: NOTHING,
  left: NOTHING,
  closing: NOTHING,
  onTheWayBack: NOTHING,
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/admin/reports/accounting', () => {
  // the delivery and the money of the payments past the statements (the disputes, the refunds by
  // hand, the late payments) are of all orders and of no product: months long before the tests have
  // none of it
  it('gives the delivery and the payments of the whole shop, and none to a report of some products', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    const past = {
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-02-01T00:00:00.000Z',
    };

    const whole = await report(past);
    const some = await report({ ...past, productIds: String(product.id) });
    const variants = await report({ ...past, variantIds: String(product.variantId) });
    const category = await report({ ...past, categoryId: String(product.categoryId) });
    const ofProducts = await reportOf([product], startedAt);

    expect(whole.json().delivery).toEqual({
      income: { orders: 0, revenue: 0 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 0, cost: 0, withoutCost: 0 },
      returnShipping: { sends: 0, cost: 0, withoutCost: 0, deducted: 0, reimbursed: 0 },
      result: 0,
    });
    expect(whole.json().payments).toEqual({
      disputes: { withdrawn: 0, reinstated: 0, used: 0, undecided: 0, result: 0 },
      handRefunds: {
        refunded: 0,
        compensations: 0,
        coverage: 0,
        undecided: 0,
        used: 0,
        result: 0,
      },
      latePayments: { received: 0, refunded: 0, result: 0 },
      compensations: { given: 0, result: 0 },
      received: { buyers: 0, carriers: 0, result: 0 },
    });
    expect(whole.json().summary.expenses).toMatchObject({ otherRefunds: 0 });
    for (const res of [some, variants, category, ofProducts]) {
      expect(res.statusCode).toBe(200);
      expect(res.json().delivery).toBeNull();
      expect(res.json().payments).toBeNull();
      expect(res.json().summary.expenses.otherRefunds).toBeNull();
    }
  });

  it('counts the sales of the period, the cost of the batches they took and the margin', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    // a sale takes the batch that ends first: 3 at 2, then 1 of the batch at 3
    await receiveBatch(product.id, { quantity: 5, unitCost: 3 });
    await receiveBatch(product.id, { quantity: 3, unitCost: 2, expiresAt: utcDay(5) });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 4);

    const res = await reportOf([product], startedAt);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      currency: 'eur',
      sales: { orders: 1, units: 4, revenue: 40, cost: 9, margin: 31 },
      returns: { orders: 0, units: 0, revenue: 0, cost: 0, byKind: NO_KINDS },
      net: { units: 4, revenue: 40, cost: 9, margin: 31, marginPercent: 77.5 },
      // a report of some products: no delivery, the totals are of the items
      summary: {
        income: { items: 40, delivery: null, total: 40 },
        expenses: { costOfGoods: 9, writeOffs: 0, shipping: null, otherRefunds: null, total: 9 },
        margin: { items: 31, delivery: null, total: 31 },
      },
      // what is left: 4 of the batch at 3 (8 came in at 3 and 2 at 5, 4 went out)
      stock: {
        opening: NOTHING,
        received: { units: 8, value: 21 },
        left: { units: 4, value: 9 },
        closing: { units: 4, value: 12 },
        onTheWayBack: NOTHING,
      },
    });
  });

  it('counts an order of several products once, and only the products asked for', async () => {
    const startedAt = Date.now();
    const asked = await newProduct(10);
    const notAsked = await newProduct(20);
    await receiveBatch(asked.id, { quantity: 5, unitCost: 4 });
    await receiveBatch(notAsked.id, { quantity: 5, unitCost: 15 });
    const buyer = await newUser();
    // two items of one cart, paid together
    await placeOrder(app, csrf, buyer, notAsked, 'cart');
    await placeOrder(app, csrf, buyer, asked, 'paid', 2);

    const one = await reportOf([asked], startedAt);
    const both = await reportOf([asked, notAsked], startedAt);

    expect(one.json().sales).toEqual({ orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 });
    expect(both.json().sales).toEqual({ orders: 1, units: 3, revenue: 40, cost: 23, margin: 17 });
  });

  // the order keeps the time it was paid and its sale stays in that period whatever happens to it
  // later: the return is in the period its money went back, and the net is the two
  it('keeps a cancelled order in the period it was paid in, and counts the return in the period its money went back', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    const { paidAt } = await orderRowOf(orderId);
    // the period of the payment, before the cancel came
    const ofPayment = () =>
      report({
        from: new Date(startedAt - 60_000).toISOString(),
        to: new Date(paidAt!.getTime() + 1).toISOString(),
        productIds: String(product.id),
      });
    const beforeCancel = await ofPayment();

    const { bookedAt } = await cancelAndRefund(admin.id, orderId);
    const afterCancel = await ofPayment();
    const ofReturn = await report({
      from: new Date(bookedAt.getTime()).toISOString(),
      to: new Date(bookedAt.getTime() + 60_000).toISOString(),
      productIds: String(product.id),
    });
    const whole = await reportOf([product], startedAt);

    expect(beforeCancel.json()).toMatchObject({
      sales: { orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 },
      summary: { income: { items: 20, total: 20 }, margin: { total: 12 } },
    });
    // the period of the payment is the same after the cancel: nothing of it changed
    expect(afterCancel.json()).toEqual(beforeCancel.json());
    expect(paidAt!.getTime()).toBeLessThan(bookedAt.getTime());

    // the period of the return has the return and no sale
    expect(ofReturn.json()).toMatchObject({
      sales: { orders: 0, units: 0, revenue: 0, cost: 0, margin: 0 },
      returns: { orders: 1, units: 2, revenue: 20, cost: 8 },
      net: { units: -2, revenue: -20, cost: -8, margin: -12 },
      summary: { income: { items: -20, total: -20 }, margin: { total: -12 } },
    });

    // both together: the net is nothing, the units went back into their batch
    expect(whole.json()).toMatchObject({
      sales: { orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 },
      returns: { orders: 1, units: 2, revenue: 20, cost: 8 },
      net: { units: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null },
      summary: { income: { items: 0, total: 0 }, expenses: { costOfGoods: 0 } },
    });
    expect(whole.json().stock).toEqual({
      opening: NOTHING,
      received: { units: 7, value: 28 },
      left: { units: 2, value: 8 },
      closing: { units: 5, value: 20 },
      onTheWayBack: NOTHING,
    });
  });

  it('tells the right of withdrawal from the reasons an admin gave, in the returns', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 6, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 3);

    await cancelAndRefund(admin.id, orderId);
    const res = await reportOf([product], startedAt);

    // the cancel by the shop is a statement with the reason shop_cancel
    expect(res.json().returns).toEqual({
      orders: 1,
      units: 3,
      revenue: 30,
      cost: 12,
      byKind: { ...NO_KINDS, shop_cancel: { units: 3, revenue: 30, cost: 12 } },
    });
  });

  // the reason an admin gives a withdrawal (a call, a letter) is no other kind: it is a withdrawal
  it('counts a withdrawal an admin wrote down as a withdrawal, whatever reason the admin gave', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 6, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 1);
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );
    const send = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(admin)), payload });
    const made = (
      await send('/api/returns', {
        orderId,
        items: [{ orderItemId: item!.id, quantity: 1 }],
        basis: 'withdrawal',
        reason: 'other',
      })
    ).json();
    await send(`/api/returns/${made.id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: made.items[0].id, quantity: 1, goods: 'to_stock' }],
    });
    await refundReturn(admin.id, made.id);

    const res = await reportOf([product], startedAt);

    expect(res.json().returns.byKind).toEqual({
      ...NO_KINDS,
      withdrawal: { units: 1, revenue: 10, cost: 4 },
    });
  });

  it('does not count a return whose money did not go back: the sale stands whole, the units are on the shelf', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 4, unitCost: 2 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);

    // the goods are back and the order is cancelled, the money has not left yet
    await cancelPaidOrder(admin.id, orderId);
    const res = await reportOf([product], startedAt);

    expect(res.json()).toMatchObject({
      sales: { orders: 1, units: 2, revenue: 20, cost: 4 },
      returns: { orders: 0, units: 0, revenue: 0, cost: 0 },
      net: { units: 2, revenue: 20, cost: 4, margin: 16 },
    });
    expect(res.json().stock).toMatchObject({
      received: { units: 6, value: 12 },
      left: { units: 2, value: 4 },
      closing: { units: 4, value: 8 },
    });
  });

  it('takes the write-offs into the expenses and out of the total margin', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    const batch = await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    await writeOffStock(product.id, 1, { batchId: batch, reason: 'damaged' });

    const res = await reportOf([product], startedAt);

    expect(res.json().summary).toEqual({
      income: { items: 20, delivery: null, total: 20 },
      expenses: { costOfGoods: 8, writeOffs: 4, shipping: null, otherRefunds: null, total: 12 },
      margin: { items: 12, delivery: null, total: 8 },
    });
  });

  it('counts a sale from the time it was paid: the period starts there and ends before it', async () => {
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 2, unitCost: 1 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid');
    const { paidAt } = await orderRowOf(orderId);
    const query = (from: Date, to: Date) =>
      report({ from: from.toISOString(), to: to.toISOString(), productIds: String(product.id) });

    const fromPayment = await query(paidAt!, new Date(paidAt!.getTime() + 60_000));
    const untilPayment = await query(new Date(paidAt!.getTime() - 60_000), paidAt!);

    expect(fromPayment.json().sales).toMatchObject({ orders: 1, revenue: 10 });
    expect(untilPayment.json().sales).toMatchObject({ orders: 0, revenue: 0 });
  });

  it('counts what came in by source at its cost', async () => {
    const startedAt = Date.now();
    const product = await newProduct();
    await receiveBatch(product.id, { quantity: 4, unitCost: 2.5 });
    await receiveBatch(product.id, { quantity: 2, unitCost: 3, source: 'supplier' });
    await receiveBatch(product.id, { quantity: 1, unitCost: 1, source: 'surplus' });
    await receiveBatch(product.id, { quantity: 3, unitCost: 0.5, source: 'customer_return' });

    const res = await reportOf([product], startedAt);

    expect(res.json().purchases).toEqual({
      units: 10,
      value: 18.5,
      bySource: {
        supplier: { units: 6, value: 16 },
        surplus: { units: 1, value: 1 },
        customer_return: { units: 3, value: 1.5 },
      },
    });
  });

  it('counts what was written off by reason at the cost of its batches', async () => {
    const startedAt = Date.now();
    const product = await newProduct();
    const cheap = await receiveBatch(product.id, { quantity: 4, unitCost: 1 });
    const dear = await receiveBatch(product.id, { quantity: 4, unitCost: 5 });
    await writeOffStock(product.id, 2, { batchId: dear, reason: 'damaged' });
    await writeOffStock(product.id, 1, { batchId: cheap, reason: 'damaged' });
    await writeOffStock(product.id, 3, { batchId: cheap, reason: 'shortage' });

    const res = await reportOf([product], startedAt);

    expect(res.json().writeOffs).toEqual({
      units: 6,
      value: 14,
      byReason: {
        damaged: { units: 3, value: 11 },
        defective: NOTHING,
        expired: NOTHING,
        shortage: { units: 3, value: 3 },
        returned_to_supplier: NOTHING,
        other: NOTHING,
        customer_return: NOTHING,
      },
    });
    // what is left: 2 at 5
    expect(res.json().stock).toMatchObject({ closing: { units: 2, value: 10 } });
  });

  it('gives the period it counted and every section empty when nothing happened', async () => {
    const product = await newProduct();
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-02-01T00:00:00.000Z';

    const res = await report({ from, to, productIds: String(product.id) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      period: { from, to },
      currency: 'eur',
      sales: { orders: 0, units: 0, revenue: 0, cost: 0, margin: 0 },
      returns: { orders: 0, units: 0, revenue: 0, cost: 0, byKind: NO_KINDS },
      net: { units: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null },
      summary: {
        income: { items: 0, delivery: null, total: 0 },
        expenses: { costOfGoods: 0, writeOffs: 0, shipping: null, otherRefunds: null, total: 0 },
        margin: { items: 0, delivery: null, total: 0 },
      },
      purchases: {
        ...NOTHING,
        bySource: { supplier: NOTHING, surplus: NOTHING, customer_return: NOTHING },
      },
      writeOffs: {
        ...NOTHING,
        byReason: {
          damaged: NOTHING,
          defective: NOTHING,
          expired: NOTHING,
          shortage: NOTHING,
          returned_to_supplier: NOTHING,
          other: NOTHING,
          customer_return: NOTHING,
        },
      },
      stock: NO_STOCK,
      // the delivery and the payments past the statements are of no product
      delivery: null,
      payments: null,
    });
  });

  it('counts every product without the filter, ours among them', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 3, unitCost: 2 });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 1);

    const res = await report({
      from: new Date(startedAt - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sales.revenue).toBeGreaterThanOrEqual(10);
    expect(res.json().purchases.units).toBeGreaterThanOrEqual(3);
    expect(res.json().stock.closing.units).toBeGreaterThanOrEqual(2);
  });

  describe('with the variants of a product', () => {
    // the product has two variants: A (price 10) takes in 5 at 4 and sells 2; B (price 25) takes in 3
    // at 6, sells 1 and has 1 written off
    async function productWithTwoVariants() {
      const startedAt = Date.now();
      const product = await newProduct(10);
      const second = await createVariant(product.id, { price: 25, stock: 0 });
      const b = { ...product, variantId: second.id };
      await receiveBatch({ variantId: product.variantId }, { quantity: 5, unitCost: 4 });
      const batchB = await receiveBatch({ variantId: second.id }, { quantity: 3, unitCost: 6 });
      const buyer = await newUser();
      await placeOrder(app, csrf, buyer, product, 'paid', 2);
      await placeOrder(app, csrf, buyer, b, 'paid', 1);
      await writeOffStock({ variantId: second.id }, 1, { batchId: batchB, reason: 'damaged' });
      return { startedAt, product, second };
    }

    const ofVariants = (
      startedAt: number,
      variantIds: number[],
      extra: Record<string, string> = {},
    ) =>
      report({
        from: new Date(startedAt - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        variantIds: variantIds.join(','),
        ...extra,
      });

    it('sums the variants for the product and gives the money of one variant alone', async () => {
      const { startedAt, product, second } = await productWithTwoVariants();

      const whole = await reportOf([product], startedAt);
      const first = await ofVariants(startedAt, [product.variantId]);
      const other = await ofVariants(startedAt, [second.id]);

      expect(whole.json()).toMatchObject({
        sales: { orders: 2, units: 3, revenue: 45, cost: 14, margin: 31 },
        purchases: { units: 8, value: 38 },
        writeOffs: { units: 1, value: 6 },
        // what is left: 3 at 4 and 1 at 6
        stock: { closing: { units: 4, value: 18 } },
        delivery: null,
      });
      expect(first.json()).toMatchObject({
        sales: { orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 },
        purchases: { units: 5, value: 20 },
        writeOffs: { units: 0, value: 0 },
        stock: { closing: { units: 3, value: 12 } },
        delivery: null,
      });
      expect(other.json()).toMatchObject({
        sales: { orders: 1, units: 1, revenue: 25, cost: 6, margin: 19 },
        purchases: { units: 3, value: 18 },
        writeOffs: { units: 1, value: 6 },
        stock: { closing: { units: 1, value: 6 } },
      });
    });

    it('takes the variants of the products asked for that are among the variants asked for', async () => {
      const { startedAt, product, second } = await productWithTwoVariants();
      const stranger = await newProduct(10);
      await receiveBatch(stranger.id, { quantity: 2, unitCost: 1 });

      const both = await ofVariants(startedAt, [product.variantId, second.id]);
      const asked = await ofVariants(startedAt, [product.variantId, second.id], {
        productIds: String(product.id),
      });
      const justFirst = await ofVariants(startedAt, [product.variantId], {
        productIds: String(product.id),
      });
      const wrongProduct = await ofVariants(startedAt, [product.variantId], {
        productIds: String(stranger.id),
      });
      const strangers = await ofVariants(startedAt, [stranger.variantId, product.variantId]);

      for (const section of ['sales', 'purchases', 'writeOffs', 'stock', 'summary'] as const) {
        expect(asked.json()[section]).toEqual(both.json()[section]);
      }
      expect(both.json().sales).toMatchObject({ units: 3, revenue: 45 });
      expect(justFirst.json().sales).toMatchObject({ units: 2, revenue: 20 });
      // no variant of that product is among those asked for
      expect(wrongProduct.json().sales).toMatchObject({ orders: 0, units: 0, revenue: 0 });
      expect(wrongProduct.json().purchases).toMatchObject({ units: 0, value: 0 });
      expect(wrongProduct.json().stock).toEqual(NO_STOCK);
      expect(strangers.json().purchases).toMatchObject({ units: 7, value: 22 });
    });

    it('keeps the history of a variant taken out of sale in the report of its product', async () => {
      const { startedAt, product, second } = await productWithTwoVariants();
      await markVariantDeleted(second.id);

      const whole = await reportOf([product], startedAt);
      const other = await ofVariants(startedAt, [second.id]);

      expect(whole.json()).toMatchObject({
        sales: { units: 3, revenue: 45 },
        stock: { closing: { units: 4, value: 18 } },
      });
      expect(other.json().sales).toMatchObject({ units: 1, revenue: 25 });
    });

    it('counts the return of a sale of a variant in its own report', async () => {
      const startedAt = Date.now();
      const product = await newProduct(10);
      const second = await createVariant(product.id, { price: 25, stock: 0 });
      await receiveBatch({ variantId: product.variantId }, { quantity: 2, unitCost: 1 });
      await receiveBatch({ variantId: second.id }, { quantity: 2, unitCost: 3 });
      const orderId = await placeOrder(
        app,
        csrf,
        await newUser(),
        { ...product, variantId: second.id },
        'paid',
        2,
      );
      await cancelAndRefund(admin.id, orderId);

      const first = await ofVariants(startedAt, [product.variantId]);
      const other = await ofVariants(startedAt, [second.id]);

      expect(first.json().returns).toMatchObject({ orders: 0, units: 0, revenue: 0, cost: 0 });
      expect(other.json().returns).toMatchObject({ orders: 1, units: 2, revenue: 50, cost: 6 });
      expect(other.json().stock).toMatchObject({ closing: { units: 2, value: 6 } });
    });
  });

  it('counts from the start of all time until now when no period is given', async () => {
    const before = Date.now();

    const res = await report({ productIds: String((await newProduct()).id) });

    expect(res.statusCode).toBe(200);
    expect(res.json().period.from).toBe(new Date(0).toISOString());
    expect(Date.parse(res.json().period.to)).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await report({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });

  it.each([
    ['a date that is not a date', { from: 'yesterday' }],
    ['product ids that are not ids', { productIds: '1,abc' }],
    ['a product id of zero', { productIds: '0' }],
    ['an empty product id', { productIds: '1,,2' }],
    ['variant ids that are not ids', { variantIds: '1,abc' }],
    ['a variant id of zero', { variantIds: '0' }],
    ['an empty variant id', { variantIds: '1,,2' }],
  ])('refuses %s', async (_case, query) => {
    const res = await report(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a product id past the largest id', async () => {
    const res = await report({ productIds: '2147483648' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IDS_INVALID' });
  });

  it('refuses a variant id past the largest id, and more than 100 variant ids', async () => {
    const past = await report({ variantIds: '2147483648' });
    const many = await report({
      variantIds: Array.from({ length: 101 }, (_, n) => n + 1).join(','),
    });

    for (const res of [past, many]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_IDS_INVALID' });
    }
  });

  it('refuses more than 100 product ids', async () => {
    const res = await report({
      productIds: Array.from({ length: 101 }, (_, n) => n + 1).join(','),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IDS_INVALID' });
  });

  it('lets root read the report too', async () => {
    const res = await report({}, await newUser({ role: 'ROOT' }));

    expect(res.statusCode).toBe(200);
  });

  it('refuses a user and a guest', async () => {
    const user = await report({}, await newUser());
    const guest = await app.inject({ method: 'GET', url: '/api/admin/reports/accounting' });

    expect(user.statusCode).toBe(403);
    expect(user.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(guest.statusCode).toBe(403);
  });
});

// The stock is read from the stock log, so a period that is over is the same whatever happens
// after it. These tests cut the periods at the times the database gave the events
describe('GET /api/admin/reports/accounting: the periods of the stock, the goods on their way back and the returns', () => {
  const ofProduct = (product: TestProduct, from: Date, to: Date) =>
    report({
      from: from.toISOString(),
      to: to.toISOString(),
      productIds: String(product.id),
    });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload,
    });

  // a shipped order of units, and a statement of the admin for some of them (goods not in yet)
  async function shippedWithStatement(product: TestProduct, sold: number, stated: number) {
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'shipped', sold);
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    const made = await post('/api/returns', {
      orderId,
      items: [{ orderItemId: item!.id, quantity: stated }],
      basis: 'other',
      reason: 'defect',
    });
    expect(made.statusCode).toBe(201);
    return {
      orderId,
      returnId: made.json().id as number,
      rowId: made.json().items[0].id as number,
    };
  }

  const receive = (returnId: number, rowId: number, quantity: number) =>
    post(`/api/returns/${returnId}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: rowId, quantity, goods: 'to_stock' }],
    });

  it('gives the stock at the start of the period from the history: what was there, what went out in it, what is left', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    const sale = (await stockLinesOf(product.variantId)).find(
      (line) => line.event === 'stock.sale',
    )!;
    const start = new Date(startedAt - 60_000);
    const end = new Date(Date.now() + 60_000);

    const before = await ofProduct(product, start, sale.createdAt);
    const during = await ofProduct(product, sale.createdAt, end);

    // up to the sale: the batch came in, nothing went out
    expect(before.json().stock).toEqual({
      opening: NOTHING,
      received: { units: 5, value: 20 },
      left: NOTHING,
      closing: { units: 5, value: 20 },
      onTheWayBack: NOTHING,
    });
    // from the sale: the batch is the opening, the sale is what went out
    expect(during.json().stock).toEqual({
      opening: { units: 5, value: 20 },
      received: NOTHING,
      left: { units: 2, value: 8 },
      closing: { units: 3, value: 12 },
      onTheWayBack: NOTHING,
    });
  });

  it('counts the units that wait for their goods as on their way back, and a period that is over keeps them when part of the goods comes in', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 10, unitCost: 4 });
    const { returnId, rowId } = await shippedWithStatement(product, 6, 5);
    const start = new Date(startedAt - 60_000);
    // a moment between the statement and the goods
    const between = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const waiting = await ofProduct(product, start, between);
    expect((await receive(returnId, rowId, 2)).statusCode).toBe(200);
    const end = new Date(Date.now() + 60_000);
    const sameAfter = await ofProduct(product, start, between);
    const whole = await ofProduct(product, start, end);

    // five units wait, at the cost of the order that sold them; they are not in the stock
    expect(waiting.json().stock).toMatchObject({
      closing: { units: 4, value: 16 },
      onTheWayBack: { units: 5, value: 20 },
    });
    // the period before the goods came is the same after they came: nothing of it moved
    expect(sameAfter.json().stock).toEqual(waiting.json().stock);
    // now: two units are back in the stock, three still wait
    expect(whole.json().stock).toMatchObject({
      received: { units: 12, value: 48 },
      closing: { units: 6, value: 24 },
      onTheWayBack: { units: 3, value: 12 },
    });
  });

  it('books the cost of the units that came back when the money has gone back and the units are in, the later of the two', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const { returnId, rowId } = await shippedWithStatement(product, 3, 2);
    const start = new Date(startedAt - 60_000);

    // the money goes back first, once the admin vouches for the proof of the parcel
    expect(
      (await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 })).statusCode,
    ).toBe(200);
    const { bookedAt: refundedAt } = await refundReturn(admin.id, returnId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await receive(returnId, rowId, 2)).statusCode).toBe(200);
    const goodsAt = (await stockLinesOf(product.variantId)).find(
      (line) => line.event === 'stock.return',
    )!.createdAt;
    const end = new Date(Date.now() + 60_000);

    const sold = await ofProduct(product, start, refundedAt);
    const refunded = await ofProduct(product, refundedAt, goodsAt);
    const inGoods = await ofProduct(product, goodsAt, end);
    const whole = await ofProduct(product, start, end);

    expect(refundedAt.getTime()).toBeLessThan(goodsAt.getTime());
    // the sale: three units at 10, cost 4 each
    expect(sold.json()).toMatchObject({
      sales: { units: 3, revenue: 30, cost: 12 },
      returns: { units: 0, revenue: 0, cost: 0 },
    });
    // the money went back: 20 less, and the units are not in yet, so no cost comes back
    expect(refunded.json()).toMatchObject({
      sales: { units: 0, revenue: 0, cost: 0 },
      returns: { units: 2, revenue: 20, cost: 0 },
      net: { units: -2, revenue: -20, cost: 0, margin: -20 },
    });
    // the units came in: the cost comes back, with no money in this period
    expect(inGoods.json()).toMatchObject({
      returns: { units: 0, revenue: 0, cost: 8 },
      net: { units: 0, revenue: 0, cost: -8, margin: 8 },
      stock: { received: { units: 2, value: 8 } },
    });
    // all of it: 1 unit kept, 10 earned, 4 spent
    expect(whole.json()).toMatchObject({
      returns: { units: 2, revenue: 20, cost: 8 },
      net: { units: 1, revenue: 10, cost: 4, margin: 6 },
    });
  });

  // the money of the row went back before its goods, and the goods came in two parcels: the row is
  // parted when the first one comes, and the cost of every unit that came back is booked
  it('books the cost of every unit of a row refunded before its goods came in parts', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const { returnId, rowId } = await shippedWithStatement(product, 3, 2);
    const start = new Date(startedAt - 60_000);

    expect(
      (await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 })).statusCode,
    ).toBe(200);
    const { bookedAt } = await refundReturn(admin.id, returnId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await receive(returnId, rowId, 1)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await receive(returnId, rowId, 1)).statusCode).toBe(200);
    const end = new Date(Date.now() + 60_000);

    const money = await ofProduct(product, bookedAt, firstAt);
    const later = await ofProduct(product, firstAt, end);
    const whole = await ofProduct(product, start, end);

    // the money of both units and the cost of the first one that came in
    expect(money.json().returns).toMatchObject({ units: 2, revenue: 20, cost: 4 });
    // the second unit came in later: its cost, no money
    expect(later.json().returns).toMatchObject({ units: 0, revenue: 0, cost: 4 });
    expect(whole.json()).toMatchObject({
      returns: { units: 2, revenue: 20, cost: 8 },
      net: { units: 1, revenue: 10, cost: 4, margin: 6 },
      stock: { closing: { units: 4, value: 16 } },
    });
  });

  // a failure of a transfer gives its money and the cost of its units back in the period the
  // failure came: the period of the transfer stays as it was, and money sent outside the app later
  // is a return of its own period
  it('gives a failed transfer back in the period of the failure, and counts the money sent outside the app in its own', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    // the goods of a cancel are back on the shelf at once, before the transfer
    const returnId = await cancelPaidOrder(admin.id, orderId);
    const { bookedAt, failedAt } = await failReturnRefund(admin.id, returnId, 'card_unavailable');
    const start = new Date(startedAt - 60_000);
    const ofTransfer = () => ofProduct(product, bookedAt, failedAt);
    const beforeOutside = await ofTransfer();

    const root = await newUser({ role: 'ROOT' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outsideFrom = new Date();
    const sent = await app.inject({
      method: 'POST',
      url: `/api/returns/${returnId}/refund/outside`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: {
        method: 'bank_transfer',
        note: 'Sent to the account.',
        at: bookedAt.toISOString(),
      },
    });
    expect(sent.statusCode).toBe(200);
    const end = new Date(Date.now() + 60_000);

    const ofFailure = await ofProduct(product, failedAt, outsideFrom);
    const ofOutside = await ofProduct(product, outsideFrom, end);
    const whole = await ofProduct(product, start, end);

    expect(bookedAt.getTime()).toBeLessThan(failedAt.getTime());
    expect(beforeOutside.json().returns).toMatchObject({
      orders: 1,
      units: 2,
      revenue: 20,
      cost: 8,
      byKind: { shop_cancel: { units: 2, revenue: 20, cost: 8 } },
    });
    // the period of the transfer is the same after the money went another way
    expect((await ofTransfer()).json()).toEqual(beforeOutside.json());
    expect(ofFailure.json()).toMatchObject({
      returns: {
        orders: 0,
        units: -2,
        revenue: -20,
        cost: -8,
        byKind: { shop_cancel: { units: -2, revenue: -20, cost: -8 } },
      },
      net: { units: 2, revenue: 20, cost: 8, margin: 12 },
    });
    expect(ofOutside.json().returns).toMatchObject({ orders: 1, units: 2, revenue: 20, cost: 8 });
    expect(whole.json()).toMatchObject({
      sales: { units: 2, revenue: 20, cost: 8 },
      returns: { orders: 1, units: 2, revenue: 20, cost: 8 },
      net: { units: 0, revenue: 0, cost: 0, margin: 0 },
    });
  });
});
