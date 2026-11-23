import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { cartOf, confirm, pay, type DeliveryRule } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The tax of an order as the confirmation keeps it (db/05, confirm_order with p_tax): every item
// its rule, country, group, rate and tax, with the unit price the rule leaves and the price of the
// catalog beside a lower one; the delivery its parts by rate. The database checks the arithmetic
// (the tax of a line half up to the cent, a price that only comes down and only for a rule without
// the tax of the seller, the parts that make the price of the delivery), takes the tax of an earlier
// confirmation away and gives a cart its prices of the catalog again. The sales of the period of a
// threshold (tax_threshold_sales): the paid orders by their payment in the journal and the confirmed
// ones that wait, with the tax or without, never a pickup

let buyer: TestUser;
let admin: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  // 10 a unit
  product = await createProduct({ stock: 50 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// a cart of two units sent by hand to Ukraine
const cart = (db: DbSession, opts: Parameters<typeof cartOf>[3] = {}) =>
  cartOf(db, buyer.id, [[product.variantId, 2]], opts);

const itemOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [item] = await db.rows<Record<string, unknown>>(
    `select id, "unitPrice"::float8 as "unitPrice", "totalPrice"::float8 as "totalPrice",
            "listUnitPrice"::float8 as "listUnitPrice", "taxRule"::text as "taxRule", "taxCountry",
            "taxRate"::float8 as "taxRate", "taxAmount"::float8 as "taxAmount"
     from cartlify.order_items where "orderId" = $1`,
    orderId,
  );
  return item!;
};

const itemIdOf = async (db: DbSession, orderId: number) => (await itemOf(db, orderId)).id as number;

// the tax of the seller at 20 %: 20 of goods hold 3.33, 5 of delivery 0.83
const sellerTax = (itemId: number, over: Record<string, unknown> = {}, delivery?: unknown) => ({
  items: [
    {
      id: itemId,
      rule: 'seller',
      country: 'UA',
      groupId: null,
      rate: 20,
      unitPrice: 10,
      tax: 3.33,
      ...over,
    },
  ],
  delivery:
    delivery === undefined
      ? { rule: 'seller', parts: [{ rate: 20, gross: 5, tax: 0.83 }] }
      : delivery,
});

const RULE: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

describe('confirm_order: the tax the server counted', () => {
  it('keeps the tax of each item and of the delivery, and the request of an invoice', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cart(db);
      const itemId = await itemIdOf(db, orderId);
      const confirmed = await confirm(db, buyer.id, orderId, '15 minutes', {
        ...RULE,
        tax: sellerTax(itemId),
        invoice: true,
      });

      await db.as({ role: 'ADMIN', userId: admin.id });
      const [order] = await db.rows<Record<string, unknown>>(
        `select o.total::float8 as total, o."invoiceRequested", d."taxRule"::text as "deliveryRule",
                d."taxLines" as "taxLines", d."taxAmount"::float8 as "deliveryTax"
         from cartlify.orders as o join cartlify.order_deliveries as d on d."orderId" = o.id
         where o.id = $1`,
        orderId,
      );
      return { confirmed, item: await itemOf(db, orderId), order };
    });

    expect(result.confirmed.ok).toBe(true);
    expect(result.item).toMatchObject({
      unitPrice: 10,
      totalPrice: 20,
      listUnitPrice: null,
      taxRule: 'seller',
      taxCountry: 'UA',
      taxRate: 20,
      taxAmount: 3.33,
    });
    expect(result.order).toEqual({
      total: 25,
      invoiceRequested: true,
      deliveryRule: 'seller',
      taxLines: [{ rate: 20, gross: 5, tax: 0.83 }],
      deliveryTax: 0.83,
    });
  });

  it('lowers the unit price for a rule without the tax of the seller, the price of the catalog beside it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cart(db);
      const itemId = await itemIdOf(db, orderId);
      const confirmed = await confirm(db, buyer.id, orderId, '15 minutes', {
        flat: 4.17,
        expected: 4.17,
        tax: {
          items: [
            {
              id: itemId,
              rule: 'buyer_at_receipt',
              country: 'UA',
              groupId: null,
              rate: null,
              unitPrice: 8.33,
              tax: 0,
            },
          ],
          delivery: { rule: 'buyer_at_receipt', parts: [] },
        },
      });
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [order] = await db.rows<{ total: number }>(
        `select total::float8 as total from cartlify.orders where id = $1`,
        orderId,
      );
      return { confirmed, item: await itemOf(db, orderId), order };
    });

    expect(result.confirmed.ok).toBe(true);
    expect(result.item).toMatchObject({
      unitPrice: 8.33,
      totalPrice: 16.66,
      listUnitPrice: 10,
      taxRule: 'buyer_at_receipt',
      taxRate: null,
      taxAmount: 0,
    });
    // the items at the price the rule leaves and the delivery the same way
    expect(result.order).toEqual({ total: 20.83 });
  });

  const wrong: [string, (itemId: number) => Record<string, unknown>][] = [
    ['a tax of a cent too much', (id) => sellerTax(id, { tax: 3.34 })],
    ['a unit price above the catalog', (id) => sellerTax(id, { unitPrice: 11, tax: 3.67 })],
    ['a lower price with the tax of the seller', (id) => sellerTax(id, { unitPrice: 9, tax: 3 })],
    ['no item', () => ({ items: [], delivery: null })],
    [
      'an item that is not of the order',
      (id) => ({
        ...sellerTax(id),
        items: [...sellerTax(id).items, { ...sellerTax(id).items[0], id: id + 100_000 }],
      }),
    ],
    [
      'parts of the delivery that do not make its price',
      (id) => sellerTax(id, {}, { rule: 'seller', parts: [{ rate: 20, gross: 4, tax: 0.67 }] }),
    ],
    [
      'a part of the delivery with a wrong tax',
      (id) => sellerTax(id, {}, { rule: 'seller', parts: [{ rate: 20, gross: 5, tax: 0.84 }] }),
    ],
  ];

  it.each(wrong)('refuses %s', async (_name, taxOf) => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cart(db);
      const itemId = await itemIdOf(db, orderId);
      return confirm(db, buyer.id, orderId, '15 minutes', { ...RULE, tax: taxOf(itemId) });
    });

    expect(result).toMatchObject({ ok: false, message: 'ORDER_TAX_INVALID' });
  });

  it('gives a cart again the prices of the catalog, with no change named, and confirms it anew', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await cart(db);
      const itemId = await itemIdOf(db, orderId);
      await confirm(db, buyer.id, orderId, '15 minutes', {
        flat: 4.17,
        expected: 4.17,
        tax: {
          items: [
            {
              id: itemId,
              rule: 'buyer_at_receipt',
              country: 'UA',
              groupId: null,
              rate: null,
              unitPrice: 8.33,
              tax: 0,
            },
          ],
          delivery: { rule: 'buyer_at_receipt', parts: [] },
        },
      });

      // the reservation ended: the order is a cart again
      await db.as({ role: 'ADMIN' });
      await db.rows(`select 1 as done from cartlify.unconfirm_order($1::int)`, orderId);
      await db.as({ role: 'USER', userId: buyer.id });
      const [{ changed }] = await db.rows<{ changed: number }>(
        `select cartlify.refresh_order_prices($1::int) as changed`,
        orderId,
      );
      const asCart = await itemOf(db, orderId);

      const again = await confirm(db, buyer.id, orderId, '15 minutes', {
        ...RULE,
        tax: sellerTax(itemId),
      });
      return { changed, asCart, again, item: await itemOf(db, orderId) };
    });

    expect(result.changed).toBe(0);
    expect(result.asCart).toMatchObject({
      unitPrice: 10,
      listUnitPrice: null,
      taxRule: null,
      taxAmount: null,
    });
    expect(result.again.ok).toBe(true);
    expect(result.item).toMatchObject({ unitPrice: 10, taxRule: 'seller', taxAmount: 3.33 });
  });
});

describe('tax_threshold_sales', () => {
  const salesOf = async (
    db: DbSession,
    countries: string[],
    from: string | null,
    withVat: boolean,
  ) => {
    const [row] = await db.rows<{ sales: string }>(
      `select cartlify.tax_threshold_sales($1::text[], $2::timestamp, null, $3)::text as sales`,
      countries,
      from,
      withVat,
    );
    return Number(row!.sales);
  };

  it('answers no call without an actor (TAX_THRESHOLD_FORBIDDEN)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(null);
      return db.attempt(
        `select cartlify.tax_threshold_sales($1::text[], null, null, false) as sales`,
        ['UA'],
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('TAX_THRESHOLD_FORBIDDEN'),
    });
  });

  it('counts the paid and the waiting orders to the countries, with the tax or without, never a pickup', async () => {
    const result = await inRolledBackTx(
      async (db) => {
        await db.as({ role: 'USER', userId: buyer.id });
        const before = {
          gross: await salesOf(db, ['UA'], null, true),
          net: await salesOf(db, ['UA'], null, false),
        };

        // a paid order of 25 holding 4.16 of tax, a waiting one of the same, a pickup paid
        const paid = await cart(db);
        await confirm(db, buyer.id, paid, '15 minutes', {
          ...RULE,
          tax: sellerTax(await itemIdOf(db, paid)),
        });
        expect(await pay(db, admin.id, paid)).toBe('PAID');
        const waiting = await cart(db);
        await confirm(db, buyer.id, waiting, '15 minutes', {
          ...RULE,
          tax: sellerTax(await itemIdOf(db, waiting)),
        });
        const pickup = await cart(db, {
          delivery: {
            method: 'pickup',
            country: null,
            postalCode: null,
            city: null,
            street: null,
            house: null,
          },
        });
        await confirm(db, buyer.id, pickup);
        expect(await pay(db, admin.id, pickup)).toBe('PAID');

        await db.as({ role: 'USER', userId: buyer.id });
        const after = {
          gross: await salesOf(db, ['UA'], null, true),
          net: await salesOf(db, ['UA'], null, false),
        };
        // a period that starts after the payment counts the waiting order only
        const later = await salesOf(db, ['UA'], '2999-01-01 00:00:00', true);
        const [{ role }] = await db.rows<{ role: string }>(
          `select current_setting('cartlify.role', true) as role`,
        );
        return { before, after, later, role };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    expect(Math.round((result.after.gross - result.before.gross) * 100) / 100).toBe(50);
    expect(Math.round((result.after.net - result.before.net) * 100) / 100).toBe(41.68);
    expect(result.later).toBeGreaterThanOrEqual(25);
    // the context of the caller is back after the call
    expect(result.role).toBe('USER');
  });
});
