import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { cartOf, changedRows, confirm, orderStateOf } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../helpers/factories.js';

// the sale of a product: a sale price and the end of the sale (db/05, db/06). While the end is
// ahead the product sells at the sale price (cartlify.product_current_price): the items of an
// order, the check of a confirm and the catalog take it. A sale that is over keeps its fields and
// is no price any more. A price down to the sale price or below ends the sale. Every product here
// is made in the rolled-back transaction of its test, so the sales of one test meet no other

let user: TestUser;
let admin: TestUser;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([user.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (): Actor => ({ role: 'USER', userId: user.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });

// a product of its own in a category of its own, made by the admin
async function freshProduct(db: DbSession, price = 20) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Sale category ${tag}`,
    `sale-category-${tag}`,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, price, stock, "categoryId") values ($1, $2, 50, $3) returning id`,
    `Sale product ${tag}`,
    price,
    category!.id,
  );
  return row!.id;
}

// a sale that ends after the interval from the time of the database (utc, the way prisma keeps
// dates), set by the admin unless another actor is named; a null interval leaves the end empty
async function setSale(
  db: DbSession,
  productId: number,
  salePrice: number | null,
  endsIn: string | null,
  actor: Actor = asAdmin(),
) {
  await db.as(actor);
  return db.attempt(
    `update cartlify.products
     set "salePrice" = $2::numeric, "saleEndsAt" = (now() at time zone 'utc') + $3::interval
     where id = $1 returning id`,
    productId,
    salePrice,
    endsIn,
  );
}

async function setPrice(db: DbSession, productId: number, price: number, actor = asAdmin()) {
  await db.as(actor);
  return db.attempt(
    'update cartlify.products set price = $2 where id = $1 returning id',
    productId,
    price,
  );
}

type SaleRow = { price: number; salePrice: number | null; hasEnd: boolean };

const saleOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<SaleRow>(
    `select price::float8 as price, "salePrice"::float8 as "salePrice",
            "saleEndsAt" is not null as "hasEnd"
     from cartlify.products where id = $1`,
    productId,
  );
  return row!;
};

type LogLine = {
  mode: string;
  oldPrice: number;
  newPrice: number;
  value: number;
  hasEnd: boolean;
  actorId: number;
};

const priceLogOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  return db.rows<LogLine>(
    `select mode::text as mode, "oldPrice"::float8 as "oldPrice", "newPrice"::float8 as "newPrice",
            value::float8 as value, "endsAt" is not null as "hasEnd", "actorId"
     from cartlify.product_price_change_logs where "productId" = $1 order by id`,
    productId,
  );
};

// the end of the sale the way the app writes dates, iso in utc
const saleEndOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<{ endsAt: string }>(
    `select to_char("saleEndsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt"
     from cartlify.products where id = $1`,
    productId,
  );
  return row!.endsAt;
};

const productAuditOf = async (db: DbSession, productId: number) => {
  await db.as(asAdmin());
  return db.rows<{ action: string; actorId: number; meta: unknown }>(
    `select action::text as action, "actorId", meta from cartlify.admin_audit_log
     where "entityType" = 'product' and "entityId" = $1 order by id`,
    productId,
  );
};

const itemPricesOf = async (db: DbSession, orderId: number) => {
  await db.as(asAdmin());
  const rows = await db.rows<{ unitPrice: number }>(
    'select "unitPrice"::float8 as "unitPrice" from cartlify.order_items where "orderId" = $1 order by id',
    orderId,
  );
  return rows.map((row) => row.unitPrice);
};

describe('the price a product sells at', () => {
  const currentPrice = async (salePrice: number | null, endsIn: string | null) =>
    inRolledBackTx(async (db) => {
      await db.as(asUser());
      const [row] = await db.rows<{ price: number }>(
        `select cartlify.product_current_price(
           20, $1::numeric, (now() at time zone 'utc') + $2::interval
         )::float8 as price`,
        salePrice,
        endsIn,
      );
      return row!.price;
    });

  it.each([
    ['the sale price while the end of the sale is ahead', 15, '1 day', 15],
    ['nothing, for a free product, while its sale lasts', 0, '1 minute', 0],
    ['the price once the end of the sale is past', 15, '-1 second', 20],
    ['the price at the very end of the sale', 15, '0 seconds', 20],
    ['the price without a sale', null, null, 20],
  ])('is %s', async (_case, salePrice, endsIn, price) => {
    expect(await currentPrice(salePrice, endsIn)).toBe(price);
  });
});

describe('a sale of a product', () => {
  it('lets an admin put a product on sale and take the sale off', async () => {
    const { put, takenOff, row } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const put = await setSale(db, productId, 15, '1 day');
      const takenOff = await setSale(db, productId, null, null);
      return { put, takenOff, row: await saleOf(db, productId) };
    });

    expect(changedRows(put)).toBe(true);
    expect(changedRows(takenOff)).toBe(true);
    expect(row).toEqual({ price: 20, salePrice: null, hasEnd: false });
  });

  // a sale is set on a product of the catalog; a product starts without one
  it('does not let an admin create a product that is on sale already', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const tag = uniqueTag();
      const [category] = await db.rows<{ id: number }>(
        'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
        `Sale category ${tag}`,
        `sale-category-${tag}`,
      );
      return db.attempt(
        `insert into cartlify.products (name, price, stock, "categoryId", "salePrice", "saleEndsAt")
         values ('Forged', 20, 5, $1, 15, (now() at time zone 'utc') + interval '1 day') returning id`,
        category!.id,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it.each([
    ['a user', (): Actor => asUser()],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('does not let %s put a product on sale', async (_who, actor) => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const outcome = await setSale(db, productId, 1, '1 day', actor());
      return { outcome, row: await saleOf(db, productId) };
    });

    expect(changedRows(outcome)).toBe(false);
    expect(row.salePrice).toBeNull();
  });

  it.each([
    ['without an end', 15, null, 'PRODUCT_SALE_ENDS_AT_INVALID'],
    ['that ended already', 15, '-1 minute', 'PRODUCT_SALE_ENDS_AT_INVALID'],
  ])('refuses a sale %s', async (_case, salePrice, endsIn, message) => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      return setSale(db, productId, salePrice, endsIn);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(message) });
  });

  // products_sale_chk: a sale price and an end, or neither; the sale price is below the price
  it.each([
    ['an end without a sale price', null, '1 day'],
    ['a sale price equal to the price', 20, '1 day'],
    ['a sale price above the price', 25, '1 day'],
    ['a negative sale price', -1, '1 day'],
  ])('refuses %s', async (_case, salePrice, endsIn) => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      return setSale(db, productId, salePrice, endsIn);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses to move the end of a sale that is on into the past', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15, '1 day');
      return db.attempt(
        `update cartlify.products set "saleEndsAt" = (now() at time zone 'utc') - interval '1 hour'
         where id = $1 returning id`,
        productId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRODUCT_SALE_ENDS_AT_INVALID'),
    });
  });

  it.each([
    ['another field of the product changes', `name = 'Renamed'`],
    ['the price goes up', 'price = 30'],
    ['the price goes down, still above the sale price', 'price = 16'],
  ])('keeps a sale when %s, with no line in the logs', async (_case, set) => {
    const { changed, row, log, audit } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15, '1 day');
      const changed = await db.attempt(
        `update cartlify.products set ${set} where id = $1 returning id`,
        productId,
      );
      return {
        changed,
        row: await saleOf(db, productId),
        log: await priceLogOf(db, productId),
        audit: await productAuditOf(db, productId),
      };
    });

    expect(changedRows(changed)).toBe(true);
    expect(row).toMatchObject({ salePrice: 15, hasEnd: true });
    expect(log).toEqual([]);
    expect(audit).toEqual([]);
  });

  // the end goes to the admin log in the name of the admin who changed the price, the way the app
  // writes prices (15.50 is 15.5) and dates (iso utc); the log of prices gets the change of the
  // price from the app, an update straight in the database writes none
  it.each([
    ['to the sale price', 15.5, '15.5'],
    ['below the sale price', 12, '12'],
    ['to nothing', 0, '0'],
  ])('ends a sale when the price goes down %s', async (_case, price, shown) => {
    const { changed, row, log, audit, endsAt } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15.5, '1 day');
      const endsAt = await saleEndOf(db, productId);
      const changed = await setPrice(db, productId, price);
      return {
        changed,
        endsAt,
        row: await saleOf(db, productId),
        log: await priceLogOf(db, productId),
        audit: await productAuditOf(db, productId),
      };
    });

    expect(changedRows(changed)).toBe(true);
    expect(row).toEqual({ price, salePrice: null, hasEnd: false });
    expect(log).toEqual([]);
    expect(audit).toEqual([
      {
        action: 'PRODUCT_SALE',
        actorId: admin.id,
        meta: [
          { field: 'event', old: null, new: 'ended_by_price' },
          { field: 'price', old: '20', new: shown },
          { field: 'salePrice', old: '15.5', new: null },
          { field: 'saleEndsAt', old: endsAt, new: null },
        ],
      },
    ]);
  });

  // the line of the end names the admin who changed the price: the system has no id
  it('lets only an admin with an id take the price of a product on sale down to its sale', async () => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15, '1 day');
      const outcome = await setPrice(db, productId, 10, { role: 'ADMIN' });
      return { outcome, row: await saleOf(db, productId) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRODUCT_SALE_ACTOR_REQUIRED'),
    });
    expect(row).toEqual({ price: 20, salePrice: 15, hasEnd: true });
  });
});

describe('the items of an order and a sale', () => {
  it('give an item the sale price while the sale lasts', async () => {
    const prices = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15, '1 day');
      const orderId = await cartOf(db, user.id, [[productId, 2]]);
      return itemPricesOf(db, orderId);
    });

    expect(prices).toEqual([15]);
  });

  it('give an item of a free sale nothing to pay', async () => {
    const prices = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 0, '1 day');
      const orderId = await cartOf(db, user.id, [[productId, 1]]);
      return itemPricesOf(db, orderId);
    });

    expect(prices).toEqual([0]);
  });

  it('bring the items of an unconfirmed order to the sale price that started', async () => {
    const { changed, prices } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const orderId = await cartOf(db, user.id, [[productId, 1]]);
      await setSale(db, productId, 15, '1 day');
      await db.as(asUser());
      const [row] = await db.rows<{ changed: number }>(
        'select cartlify.refresh_order_prices($1::int) as changed',
        orderId,
      );
      return { changed: row!.changed, prices: await itemPricesOf(db, orderId) };
    });

    expect(changed).toBe(1);
    expect(prices).toEqual([15]);
  });

  // the buyer confirms the amount they see: an item at the price before the sale is not it
  it('refuse a confirm of an item at the price from before the sale', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const orderId = await cartOf(db, user.id, [[productId, 1]]);
      await setSale(db, productId, 15, '1 day');
      return confirm(db, user.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_PRICES_CHANGED'),
    });
  });

  it('are confirmed at the sale price', async () => {
    const { confirmed, state } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await setSale(db, productId, 15, '1 day');
      const orderId = await cartOf(db, user.id, [[productId, 2]]);
      const confirmed = await confirm(db, user.id, orderId);
      return { confirmed, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(confirmed.ok).toBe(true);
    expect(state).toMatchObject({ status: 'waiting', total: 30 });
  });
});

// a line names how a change was given (percent or fixed) and its size in that mode, negative for
// a change down; a line with an end is the start of a sale, from the price down to the sale price
describe('the log of prices and a sale', () => {
  const logLine = (
    db: DbSession,
    productId: number,
    line: [old: number, next: number, mode: string, value: number, endsIn: string | null],
  ) =>
    db.attempt(
      `select 1 as done from cartlify.log_product_price_change(
         $1::int, $2::numeric, $3::numeric, $4::cartlify."PriceChangeMode", $5::numeric,
         (now() at time zone 'utc') + $6::interval
       )`,
      productId,
      ...line,
    );

  it.each([
    ['a percent', 'percent', -25],
    ['an amount', 'fixed', -5],
  ])('writes the start of a sale by %s with its end', async (_case, mode, value) => {
    const { written, log } = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      const written = await logLine(db, productId, [20, 15, mode, value, '1 day']);
      return { written, log: await priceLogOf(db, productId) };
    });

    expect(written.ok).toBe(true);
    expect(log).toEqual([
      { mode, oldPrice: 20, newPrice: 15, value, hasEnd: true, actorId: admin.id },
    ]);
  });

  it('keeps a change down with a negative value', async () => {
    const log = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await logLine(db, productId, [20, 18, 'fixed', -2, null]);
      return priceLogOf(db, productId);
    });

    expect(log).toEqual([
      { mode: 'fixed', oldPrice: 20, newPrice: 18, value: -2, hasEnd: false, actorId: admin.id },
    ]);
  });

  it.each([
    ['a change', null],
    ['a sale', '1 day'],
  ])('writes no line of %s that changes nothing', async (_case, endsIn) => {
    const log = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      await logLine(db, productId, [20, 20, 'fixed', 0, endsIn]);
      return priceLogOf(db, productId);
    });

    expect(log).toEqual([]);
  });

  // price_change_sale_below_price: a sale lowers the price
  it('refuses a line with an end that does not take the price down', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      return logLine(db, productId, [20, 22, 'fixed', 2, '1 day']);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses a negative price', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const productId = await freshProduct(db);
      return logLine(db, productId, [2, -1, 'fixed', -3, null]);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('has no mode of its own for a sale', async () => {
    const modes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.rows<{ modes: string }>(
        `select enum_range(null::cartlify."PriceChangeMode")::text as modes`,
      );
    });

    expect(modes).toEqual([{ modes: '{percent,fixed}' }]);
  });
});
