import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { cartOf, changedRows, confirm, orderStateOf } from '../../helpers/dbOrders.js';
import { batchIdOf } from '../../helpers/dbStock.js';
import {
  closeSessions,
  createUser,
  defaultPartyId,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the sale of a variant: a sale price and the end of the sale (db/05, db/06). While the end is
// ahead the variant sells at the sale price (cartlify.product_current_price): the items of an
// order, the check of a confirm and the catalog take it. A sale that is over keeps its fields and
// is no price any more. A price down to the sale price or below ends the sale. Every variant here
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

// a product of its own in a category of its own with one variant, made by the admin, 50 units of the
// variant in a batch
async function freshVariant(db: DbSession, price = 20) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Sale category ${tag}`,
    `sale-category-${tag}`,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, "categoryId", "manufacturerId")
     values ($1, $2, $3) returning id`,
    `Sale product ${tag}`,
    category!.id,
    await defaultPartyId(),
  );
  const variantId = await addVariant(db, row!.id, price, 1);
  return { productId: row!.id, variantId };
}

// one more variant of the product (or its first one), 50 units of it in a batch
async function addVariant(db: DbSession, productId: number, price: number, position: number) {
  await db.as(asAdmin());
  const [variant] = await db.rows<{ id: number }>(
    `insert into cartlify.product_variants ("productId", position, price)
     values ($1, $2, $3) returning id`,
    productId,
    position,
    price,
  );
  await batchIdOf(db, asAdmin(), variant!.id, { quantity: 50 });
  return variant!.id;
}

// a sale that ends after the interval from the time of the database (utc, the way prisma keeps
// dates), set by the admin unless another actor is named; a null interval leaves the end empty
async function setSale(
  db: DbSession,
  variantId: number,
  salePrice: number | null,
  endsIn: string | null,
  actor: Actor = asAdmin(),
) {
  await db.as(actor);
  return db.attempt(
    `update cartlify.product_variants
     set "salePrice" = $2::numeric, "saleEndsAt" = (now() at time zone 'utc') + $3::interval
     where id = $1 returning id`,
    variantId,
    salePrice,
    endsIn,
  );
}

async function setPrice(db: DbSession, variantId: number, price: number, actor = asAdmin()) {
  await db.as(actor);
  return db.attempt(
    'update cartlify.product_variants set price = $2 where id = $1 returning id',
    variantId,
    price,
  );
}

type SaleRow = { price: number; salePrice: number | null; hasEnd: boolean };

const saleOf = async (db: DbSession, variantId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<SaleRow>(
    `select price::float8 as price, "salePrice"::float8 as "salePrice",
            "saleEndsAt" is not null as "hasEnd"
     from cartlify.product_variants where id = $1`,
    variantId,
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

const priceLogOf = async (db: DbSession, variantId: number) => {
  await db.as(asAdmin());
  return db.rows<LogLine>(
    `select mode::text as mode, "oldPrice"::float8 as "oldPrice", "newPrice"::float8 as "newPrice",
            value::float8 as value, "endsAt" is not null as "hasEnd", "actorId"
     from cartlify.product_price_change_logs where "variantId" = $1 order by id`,
    variantId,
  );
};

// the end of the sale the way the app writes dates, iso in utc
const saleEndOf = async (db: DbSession, variantId: number) => {
  await db.as(asAdmin());
  const [row] = await db.rows<{ endsAt: string }>(
    `select to_char("saleEndsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt"
     from cartlify.product_variants where id = $1`,
    variantId,
  );
  return row!.endsAt;
};

// the lines of the variant besides the one of the batch it came with
const variantAuditOf = async (db: DbSession, variantId: number) => {
  await db.as(asAdmin());
  return db.rows<{ action: string; actorId: number; meta: unknown }>(
    `select action::text as action, "actorId", meta from cartlify.admin_audit_log
     where "entityType" = 'variant' and "entityId" = $1 and action <> 'STOCK_DELIVERY'
     order by id`,
    variantId,
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

describe('the price a variant sells at', () => {
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

describe('a sale of a variant', () => {
  it('lets an admin put a variant on sale and take the sale off', async () => {
    const { put, takenOff, row } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      const put = await setSale(db, variantId, 15, '1 day');
      const takenOff = await setSale(db, variantId, null, null);
      return { put, takenOff, row: await saleOf(db, variantId) };
    });

    expect(changedRows(put)).toBe(true);
    expect(changedRows(takenOff)).toBe(true);
    expect(row).toEqual({ price: 20, salePrice: null, hasEnd: false });
  });

  // the variants of a product are priced one by one: a sale belongs to the variant it is set on
  it('puts one variant of a product on sale and leaves the others at their price', async () => {
    const { first, second } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshVariant(db);
      const otherId = await addVariant(db, productId, 30, 2);
      await setSale(db, variantId, 15, '1 day');
      return { first: await saleOf(db, variantId), second: await saleOf(db, otherId) };
    });

    expect(first).toEqual({ price: 20, salePrice: 15, hasEnd: true });
    expect(second).toEqual({ price: 30, salePrice: null, hasEnd: false });
  });

  it('ends the sale of the variant whose price went down and keeps the sale of the other', async () => {
    const { first, second, firstAudit, secondAudit } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshVariant(db);
      const otherId = await addVariant(db, productId, 30, 2);
      await setSale(db, variantId, 15, '1 day');
      await setSale(db, otherId, 25, '1 day');
      await setPrice(db, variantId, 10);
      return {
        first: await saleOf(db, variantId),
        second: await saleOf(db, otherId),
        firstAudit: await variantAuditOf(db, variantId),
        secondAudit: await variantAuditOf(db, otherId),
      };
    });

    expect(first).toEqual({ price: 10, salePrice: null, hasEnd: false });
    expect(second).toEqual({ price: 30, salePrice: 25, hasEnd: true });
    expect(firstAudit).toHaveLength(1);
    expect(secondAudit).toEqual([]);
  });

  // a sale is set on a variant of the catalog; a variant starts without one
  it('does not let an admin create a variant that is on sale already', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshVariant(db);
      await db.as(asAdmin());
      return db.attempt(
        `insert into cartlify.product_variants ("productId", position, price, "salePrice", "saleEndsAt")
         values ($1, 2, 20, 15, (now() at time zone 'utc') + interval '1 day') returning id`,
        productId,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it.each([
    ['a user', (): Actor => asUser()],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('does not let %s put a variant on sale', async (_who, actor) => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      const outcome = await setSale(db, variantId, 1, '1 day', actor());
      return { outcome, row: await saleOf(db, variantId) };
    });

    expect(changedRows(outcome)).toBe(false);
    expect(row.salePrice).toBeNull();
  });

  it.each([
    ['without an end', 15, null, 'VARIANT_SALE_ENDS_AT_INVALID'],
    ['that ended already', 15, '-1 minute', 'VARIANT_SALE_ENDS_AT_INVALID'],
  ])('refuses a sale %s', async (_case, salePrice, endsIn, message) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      return setSale(db, variantId, salePrice, endsIn);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(message) });
  });

  // product_variants_sale_chk: a sale price and an end, or neither; the sale price is below the price
  it.each([
    ['an end without a sale price', null, '1 day'],
    ['a sale price equal to the price', 20, '1 day'],
    ['a sale price above the price', 25, '1 day'],
    ['a negative sale price', -1, '1 day'],
  ])('refuses %s', async (_case, salePrice, endsIn) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      return setSale(db, variantId, salePrice, endsIn);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses to move the end of a sale that is on into the past', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      return db.attempt(
        `update cartlify.product_variants set "saleEndsAt" = (now() at time zone 'utc') - interval '1 hour'
         where id = $1 returning id`,
        variantId,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('VARIANT_SALE_ENDS_AT_INVALID'),
    });
  });

  it.each([
    ['the product changes its name', 'products', `name = 'Renamed'`],
    ['another field of the variant changes', 'product_variants', '"weightGrams" = 300'],
    ['the price goes up', 'product_variants', 'price = 30'],
    ['the price goes down, still above the sale price', 'product_variants', 'price = 16'],
  ])('keeps a sale when %s, with no line in the logs', async (_case, table, set) => {
    const { changed, row, log, audit } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      const changed = await db.attempt(
        `update cartlify.${table} set ${set} where id = $1 returning id`,
        table === 'products' ? productId : variantId,
      );
      return {
        changed,
        row: await saleOf(db, variantId),
        log: await priceLogOf(db, variantId),
        audit: await variantAuditOf(db, variantId),
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
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15.5, '1 day');
      const endsAt = await saleEndOf(db, variantId);
      const changed = await setPrice(db, variantId, price);
      return {
        changed,
        endsAt,
        row: await saleOf(db, variantId),
        log: await priceLogOf(db, variantId),
        audit: await variantAuditOf(db, variantId),
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
  it('lets only an admin with an id take the price of a variant on sale down to its sale', async () => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      const outcome = await setPrice(db, variantId, 10, { role: 'ADMIN' });
      return { outcome, row: await saleOf(db, variantId) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('VARIANT_SALE_ACTOR_REQUIRED'),
    });
    expect(row).toEqual({ price: 20, salePrice: 15, hasEnd: true });
  });
});

// the lowest price of the 30 days before a sale (salePriorPrice) goes with the sale: the app writes
// it with the sale, a price down to the sale price takes it away with the sale
describe('the lowest price before a sale', () => {
  const priorOf = async (db: DbSession, variantId: number) => {
    await db.as(asAdmin());
    const [row] = await db.rows<{ prior: number | null }>(
      'select "salePriorPrice"::float8 as prior from cartlify.product_variants where id = $1',
      variantId,
    );
    return row!.prior;
  };

  const setPrior = async (db: DbSession, variantId: number, prior: number) => {
    await db.as(asAdmin());
    return db.attempt(
      'update cartlify.product_variants set "salePriorPrice" = $2 where id = $1 returning id',
      variantId,
      prior,
    );
  };

  it('goes with a sale a price down to the sale price ends', async () => {
    const prior = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      await setPrior(db, variantId, 20);
      await setPrice(db, variantId, 12);
      return priorOf(db, variantId);
    });

    expect(prior).toBeNull();
  });

  // product_variants_sale_prior_price_chk: only with a sale, never below 0
  it.each([
    ['without a sale', false, 10],
    ['below 0', true, -1],
  ])('is refused %s', async (_case, onSale, prior) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      if (onSale) await setSale(db, variantId, 15, '1 day');
      return setPrior(db, variantId, prior);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });
});

describe('the items of an order and a sale', () => {
  it('give an item the sale price while the sale lasts', async () => {
    const prices = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      const orderId = await cartOf(db, user.id, [[variantId, 2]]);
      return itemPricesOf(db, orderId);
    });

    expect(prices).toEqual([15]);
  });

  it('give the items of two variants of one product the price of each', async () => {
    const prices = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshVariant(db);
      const otherId = await addVariant(db, productId, 30, 2);
      await setSale(db, variantId, 15, '1 day');
      const orderId = await cartOf(db, user.id, [
        [variantId, 1],
        [otherId, 1],
      ]);
      return itemPricesOf(db, orderId);
    });

    expect(prices).toEqual([15, 30]);
  });

  it('give an item of a free sale nothing to pay', async () => {
    const prices = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 0, '1 day');
      const orderId = await cartOf(db, user.id, [[variantId, 1]]);
      return itemPricesOf(db, orderId);
    });

    expect(prices).toEqual([0]);
  });

  it('bring the items of an unconfirmed order to the sale price that started', async () => {
    const { changed, prices } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      const orderId = await cartOf(db, user.id, [[variantId, 1]]);
      await setSale(db, variantId, 15, '1 day');
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
      const { variantId } = await freshVariant(db);
      const orderId = await cartOf(db, user.id, [[variantId, 1]]);
      await setSale(db, variantId, 15, '1 day');
      return confirm(db, user.id, orderId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_PRICES_CHANGED'),
    });
  });

  it('are confirmed at the sale price', async () => {
    const { confirmed, state } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await setSale(db, variantId, 15, '1 day');
      const orderId = await cartOf(db, user.id, [[variantId, 2]]);
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
    variantId: number,
    line: [old: number, next: number, mode: string, value: number, endsIn: string | null],
  ) =>
    db.attempt(
      `select 1 as done from cartlify.log_variant_price_change(
         $1::int, $2::numeric, $3::numeric, $4::cartlify."PriceChangeMode", $5::numeric,
         'price.sale_start', (now() at time zone 'utc') + $6::interval
       )`,
      variantId,
      ...line,
    );

  it.each([
    ['a percent', 'percent', -25],
    ['an amount', 'fixed', -5],
  ])('writes the start of a sale by %s with its end', async (_case, mode, value) => {
    const { written, log } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      const written = await logLine(db, variantId, [20, 15, mode, value, '1 day']);
      return { written, log: await priceLogOf(db, variantId) };
    });

    expect(written.ok).toBe(true);
    expect(log).toEqual([
      { mode, oldPrice: 20, newPrice: 15, value, hasEnd: true, actorId: admin.id },
    ]);
  });

  it('keeps a change down with a negative value', async () => {
    const log = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      await logLine(db, variantId, [20, 18, 'fixed', -2, null]);
      return priceLogOf(db, variantId);
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
      const { variantId } = await freshVariant(db);
      await logLine(db, variantId, [20, 20, 'fixed', 0, endsIn]);
      return priceLogOf(db, variantId);
    });

    expect(log).toEqual([]);
  });

  // price_change_sale_below_price: a sale lowers the price
  it('refuses a line with an end that does not take the price down', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      return logLine(db, variantId, [20, 22, 'fixed', 2, '1 day']);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses a negative price', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshVariant(db);
      return logLine(db, variantId, [2, -1, 'fixed', -3, null]);
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
