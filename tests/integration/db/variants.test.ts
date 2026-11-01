import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getPgCode, prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { cartOf, changedRows } from '../../helpers/dbOrders.js';
import {
  batchIdOf,
  checkDeferredNow,
  dayAfter,
  expiredUnitsOf,
  setShopDay,
  writeOff,
} from '../../helpers/dbStock.js';
import { rejectedBy } from '../../helpers/errors.js';
import {
  closeSessions,
  createProduct,
  createUser,
  defaultPartyId,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the variants of a product (db/03, db/05, db/06): the price, the sale, the stock, the article
// number, the barcode, the weight and the size belong to a variant, and the pictures a variant
// shows are pictures of the gallery of its product (variant_images). Every product here is made in
// the rolled-back transaction of its test, so the rows of one test meet no other, except the
// tests of the commit, which use a product of their own that stays

let user: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([user.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (): Actor => ({ role: 'USER', userId: user.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asGuest = (): Actor => ({ role: 'GUEST', guestId: randomUUID() });
// the system: the admin context without a user id, the way setAdminContext sets it
const asSystem = (): Actor => ({ role: 'ADMIN' });

// a product of its own in a category of its own, made by the admin: one variant at the first
// place and one picture in the gallery
async function freshProduct(db: DbSession) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Variants category ${tag}`,
    `variants-category-${tag}`,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, "categoryId", "manufacturerId")
     values ($1, $2, $3) returning id`,
    `Variants product ${tag}`,
    category!.id,
    await defaultPartyId(),
  );
  const imageId = await addImage(db, row!.id);
  const [variant] = await db.rows<{ id: number }>(
    `insert into cartlify.product_variants ("productId", position, price)
     values ($1, 1, 10) returning id`,
    row!.id,
  );
  return { productId: row!.id, variantId: variant!.id, imageId };
}

// one more picture in the gallery of the product
async function addImage(db: DbSession, productId: number) {
  const [image] = await db.rows<{ id: number }>(
    `insert into cartlify.product_images ("productId", url, position)
     values ($1, 'https://res.cloudinary.com/demo/image/upload/v1/test/v.jpg', 0) returning id`,
    productId,
  );
  return image!.id;
}

type Fields = Record<string, number | string | null>;

// the places the variants made here take, so that two never meet in one product unless the test
// names one
let places = 100;

// a variant by the admin with the columns given besides the product, a place and a price of 10
const insertVariant = (db: DbSession, productId: number, fields: Fields = {}) => {
  const row: Fields = { productId, position: (places += 1), price: 10, ...fields };
  const columns = Object.keys(row);

  return db.attempt<{ id: number }>(
    `insert into cartlify.product_variants (${columns.map((column) => `"${column}"`).join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
    ...Object.values(row),
  );
};

// takes a product out of the catalog (to = 'now()') or brings it back (to = 'null')
const setRemoval = (db: DbSession, productId: number, to: string) =>
  db.attempt(
    `update cartlify.products set "deletedAt" = ${to} where id = $1 returning id`,
    productId,
  );

// the id of a variant that has to be made
async function variantIn(db: DbSession, productId: number, fields: Fields = {}) {
  const made = await insertVariant(db, productId, fields);
  if (!made.ok) throw new Error(`the variant was refused: ${made.message}`);
  return made.rows[0]!.id;
}

const updateVariant = (db: DbSession, variantId: number, set: string, ...values: unknown[]) =>
  db.attempt(
    `update cartlify.product_variants set ${set} where id = $1 returning id`,
    variantId,
    ...values,
  );

// the end of a sale one day ahead, by the clock of the database in utc, the way prisma keeps dates
const IN_A_DAY = `(now() at time zone 'utc') + interval '1 day'`;

// a number of digits, the first one not 0, picked at random: the barcodes of the catalog are unique
// and the other files run at the same time
const digits = (count: number) => String(randomInt(10 ** (count - 1), 10 ** count));

// a refusal of the database with its code, naming the rule that refused
const refusal = (code: string, rule: string) => ({
  ok: false,
  code,
  message: expect.stringContaining(rule),
});

describe('the price and the sale of a variant', () => {
  it('takes a price of zero and refuses a negative one', async () => {
    const { free, negative, lowered } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      return {
        free: await insertVariant(db, productId, { price: 0 }),
        negative: await insertVariant(db, productId, { price: -0.01 }),
        lowered: await updateVariant(db, variantId, 'price = -1'),
      };
    });

    expect(free.ok).toBe(true);
    expect(negative).toMatchObject({ ok: false, code: '23514' });
    expect(lowered).toMatchObject({ ok: false, code: '23514' });
  });

  it.each([
    ['a free sale', '"salePrice" = 0'],
    ['a sale with the lowest price before it', '"salePrice" = 5, "salePriorPrice" = 9'],
  ])('takes %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      return updateVariant(db, variantId, `${set}, "saleEndsAt" = ${IN_A_DAY}`);
    });

    expect(outcome.ok).toBe(true);
  });

  // product_variants_sale_chk: a sale price and an end, or neither; the sale price is 0 or more and
  // below the price. product_variants_sale_prior_price_chk: the lowest price goes only with a sale
  it.each([
    ['an end without a sale price', `"saleEndsAt" = ${IN_A_DAY}`],
    ['a sale price equal to the price', `"salePrice" = 10, "saleEndsAt" = ${IN_A_DAY}`],
    ['a sale price above the price', `"salePrice" = 11, "saleEndsAt" = ${IN_A_DAY}`],
    ['a negative sale price', `"salePrice" = -1, "saleEndsAt" = ${IN_A_DAY}`],
    ['a lowest price before a sale without a sale', '"salePriorPrice" = 8'],
    [
      'a negative lowest price before a sale',
      `"salePrice" = 5, "saleEndsAt" = ${IN_A_DAY}, "salePriorPrice" = -1`,
    ],
  ])('refuses %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      return updateVariant(db, variantId, set);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses a sale price without an end', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      return updateVariant(db, variantId, '"salePrice" = 5');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('VARIANT_SALE_ENDS_AT_INVALID'),
    });
  });
});

describe('the article number of a variant', () => {
  it('is an optional text without a space at either end, and not empty', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      const tag = uniqueTag();
      return [
        await insertVariant(db, productId, { sku: `SKU-${tag}` }),
        await insertVariant(db, productId, { sku: null }),
        await insertVariant(db, productId, { sku: null }),
      ];
    });

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
  });

  it.each([
    ['a space at the start', ' A1'],
    ['a space at the end', 'A1 '],
    ['no signs', ''],
    ['spaces only', '   '],
  ])('refuses an article number with %s', async (_case, sku) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, { sku });
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('is held by one live variant of the catalog, whatever the case of the letters', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const first = await freshProduct(db);
      const second = await freshProduct(db);
      const sku = `Sku-${uniqueTag()}`;
      return [
        await insertVariant(db, first.productId, { sku }),
        await insertVariant(db, first.productId, { sku }),
        await insertVariant(db, first.productId, { sku: sku.toUpperCase() }),
        await insertVariant(db, second.productId, { sku: sku.toLowerCase() }),
      ];
    });

    expect(outcomes[0]!.ok).toBe(true);
    for (const refused of outcomes.slice(1)) {
      expect(refused).toMatchObject(refusal('23505', 'product_variants_sku_catalog_uidx'));
    }
  });

  it('is freed by a variant taken out of sale, and held again by one that comes back', async () => {
    const { whileLive, afterRemoval, twiceRemoved, comesBack } = await inRolledBackTx(
      async (db) => {
        const { productId, variantId } = await freshProduct(db);
        const sku = `Sku-${uniqueTag()}`;
        await updateVariant(db, variantId, 'sku = $2', sku);

        const whileLive = await insertVariant(db, productId, { sku });
        await updateVariant(db, variantId, '"deletedAt" = now()');
        const afterRemoval = await insertVariant(db, productId, { sku });
        // a number can sit on any count of variants that are out of sale
        const second = await variantIn(db, productId, { sku: `${sku}-x` });
        await updateVariant(db, second, 'sku = $2, "deletedAt" = now()', sku);
        return {
          whileLive,
          afterRemoval,
          twiceRemoved: await updateVariant(db, second, 'price = 11'),
          comesBack: await updateVariant(db, variantId, '"deletedAt" = null'),
        };
      },
    );

    expect(whileLive).toMatchObject(refusal('23505', 'product_variants_sku_catalog_uidx'));
    expect(afterRemoval.ok).toBe(true);
    expect(twiceRemoved.ok).toBe(true);
    expect(comesBack).toMatchObject(refusal('23505', 'product_variants_sku_catalog_uidx'));
  });
});

describe('the barcode of a variant', () => {
  it.each([8, 12, 13, 14])('takes a barcode of %i digits', async (count) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, { barcode: digits(count) });
    });

    expect(outcome.ok).toBe(true);
  });

  // the column holds 14 signs: a longer text does not get as far as the rule of the digits
  it.each([
    ['7 digits', '1234567', '23514'],
    ['9 digits', '123456789', '23514'],
    ['10 digits', '1234567890', '23514'],
    ['11 digits', '12345678901', '23514'],
    ['15 digits', '123456789012345', '22001'],
    ['a letter among the digits', '1234567a', '23514'],
    ['a space', ' 12345678', '23514'],
    ['no signs', '', '23514'],
  ])('refuses a barcode of %s', async (_case, barcode, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, { barcode });
    });

    expect(outcome).toMatchObject({ ok: false, code });
  });

  it('is held by one live variant of the catalog and freed by a variant taken out of sale', async () => {
    const { held, freed, comesBack } = await inRolledBackTx(async (db) => {
      const first = await freshProduct(db);
      const second = await freshProduct(db);
      const barcode = digits(13);
      const variantId = await variantIn(db, first.productId, { barcode });
      const held = await insertVariant(db, second.productId, { barcode });
      await updateVariant(db, variantId, '"deletedAt" = now()');
      const freed = await insertVariant(db, second.productId, { barcode });
      return { held, freed, comesBack: await updateVariant(db, variantId, '"deletedAt" = null') };
    });

    expect(held).toMatchObject(refusal('23505', 'product_variants_barcode_catalog_uidx'));
    expect(freed.ok).toBe(true);
    expect(comesBack).toMatchObject(refusal('23505', 'product_variants_barcode_catalog_uidx'));
  });
});

describe('the weight and the size of a variant', () => {
  const SIZES = { lengthMm: 200, widthMm: 100, heightMm: 50 };

  it.each([
    ['none of it', {}],
    ['a weight alone', { weightGrams: 350 }],
    ['a weight with the three sizes', { weightGrams: 350, ...SIZES }],
    ['the three sizes alone', SIZES],
    [
      'a ton and ten metres',
      { weightGrams: 1_000_000, lengthMm: 10_000, widthMm: 10_000, heightMm: 10_000 },
    ],
  ])('takes %s', async (_case, fields) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, fields);
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['a weight of zero', { weightGrams: 0 }],
    ['a weight over a ton', { weightGrams: 1_000_001 }],
    ['one size', { lengthMm: 200 }],
    ['two sizes', { lengthMm: 200, widthMm: 100 }],
    ['a size of zero', { lengthMm: 0, widthMm: 10, heightMm: 10 }],
    ['a size over ten metres', { lengthMm: 10_001, widthMm: 10, heightMm: 10 }],
  ])('refuses %s', async (_case, fields) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, fields);
    });

    expect(outcome).toMatchObject(refusal('23514', 'product_variants_shipping_data_chk'));
  });
});

describe('the place of a variant', () => {
  it.each([0, -1])('refuses the place %i', async (position) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      return insertVariant(db, productId, { position });
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  // the key is checked at the end of the transaction, so a reorder writes the places one by one
  it('is one among the variants of its product, checked when the transaction ends', async () => {
    const { twin, check } = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      const twin = await insertVariant(db, productId, { position: 1 });
      return { twin, check: await checkDeferredNow(db) };
    });

    expect(twin.ok).toBe(true);
    expect(check).toMatchObject(refusal('23505', 'product_variants_position_key'));
  });

  it('lets the variants of a product change places', async () => {
    const { check, order, first, second } = await inRolledBackTx(async (db) => {
      const { productId, variantId: first } = await freshProduct(db);
      const second = await variantIn(db, productId, { position: 2 });
      await updateVariant(db, first, 'position = 2');
      await updateVariant(db, second, 'position = 1');
      return {
        check: await checkDeferredNow(db),
        order: (
          await db.rows<{ id: number }>(
            'select id from cartlify.product_variants where "productId" = $1 order by position',
            productId,
          )
        ).map((row) => row.id),
        first,
        second,
      };
    });

    expect(check.ok).toBe(true);
    expect(order).toEqual([second, first]);
  });

  it('is no business of the other products', async () => {
    const check = await inRolledBackTx(async (db) => {
      await freshProduct(db);
      await freshProduct(db);
      return checkDeferredNow(db);
    });

    expect(check.ok).toBe(true);
  });

  it('stops a commit that leaves two variants of a product at one place', async () => {
    const own = await createProduct({ stock: 0 });

    const err = await rejectedBy(() =>
      inCommittedTx(async (db) => {
        await db.as(asAdmin());
        await insertVariant(db, own.id, { position: 1 });
      }),
    );
    const variants = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.rows(`select id from cartlify.product_variants where "productId" = $1`, own.id);
    });

    // prisma names the unique violation of the commit without the text of postgres
    expect(getPgCode(err) ?? String(err)).toMatch(/23505|UniqueConstraintViolation/);
    expect(variants).toEqual([{ id: own.variantId }]);
  });
});

describe('the stock and the reserve of a variant', () => {
  // the app cannot write a stock or a reserve that breaks them (a new variant has none and an
  // update of the numbers is refused by the guard), so the rules are read where the database keeps
  // them
  it('are never below zero, and the reserve is never above the stock', async () => {
    const rules = await inRolledBackTx((db) =>
      db.rows<{ name: string; definition: string; validated: boolean }>(
        `select conname::text as name, pg_get_constraintdef(oid) as definition,
                convalidated as validated
         from pg_constraint
         where conrelid = 'cartlify.product_variants'::regclass
           and conname in ('product_variants_stock_non_negative',
                           'product_variants_reserved_stock_within_stock')
         order by conname`,
      ),
    );

    expect(rules).toEqual([
      {
        name: 'product_variants_reserved_stock_within_stock',
        definition: 'CHECK ((("reservedStock" >= 0) AND ("reservedStock" <= stock)))',
        validated: true,
      },
      {
        name: 'product_variants_stock_non_negative',
        definition: 'CHECK ((stock >= 0))',
        validated: true,
      },
    ]);
  });
});

describe('who reads and writes the variants', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('shows %s every variant, one taken out of sale as well', async (_who, actor) => {
    const { seen, ids } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      const removed = await variantIn(db, productId, { position: 2 });
      await updateVariant(db, removed, '"deletedAt" = now()');
      await db.as(actor());
      return {
        ids: [variantId, removed],
        seen: await db.rows<{ id: number }>(
          'select id from cartlify.product_variants where id = any($1::int[]) order by id',
          [variantId, removed],
        ),
      };
    });

    expect(seen.map((row) => row.id)).toEqual(ids);
  });

  it.each([
    ['a user', asUser],
    ['a guest', asGuest],
  ])('lets %s create, change or delete none', async (_who, actor) => {
    const { outcomes, row } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.as(actor());
      const outcomes = [
        await insertVariant(db, productId),
        await updateVariant(db, variantId, 'price = 0.01'),
        await updateVariant(db, variantId, '"deletedAt" = now()'),
        await updateVariant(db, variantId, 'sku = $2', 'FORGED'),
        await db.attempt(
          'delete from cartlify.product_variants where id = $1 returning id',
          variantId,
        ),
      ];
      await db.as(asAdmin());
      const [row] = await db.rows<{ price: number; sku: string | null; removed: boolean }>(
        `select price::float8 as price, sku, "deletedAt" is not null as removed
         from cartlify.product_variants where id = $1`,
        variantId,
      );
      return { outcomes, row };
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false, false, false]);
    expect(row).toEqual({ price: 10, sku: null, removed: false });
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('lets %s create, change and delete a variant', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      await db.as(actor());
      const created = await insertVariant(db, productId);
      const id = created.ok ? created.rows[0]!.id : 0;
      return [
        created,
        await updateVariant(db, id, 'price = 12'),
        await db.attempt('delete from cartlify.product_variants where id = $1 returning id', id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });

  // the stock comes with the batches of a delivery, a sale starts on a variant that is in the
  // catalog: a variant starts with neither
  it.each([
    ['a stock', 'stock', '3'],
    ['a reserve', '"reservedStock"', '1'],
    ['a sale', '"salePrice", "saleEndsAt"', `5, ${IN_A_DAY}`],
    ['the end of a sale', '"saleEndsAt"', IN_A_DAY],
  ])(
    'does not let an admin create a variant that has %s already',
    async (_what, columns, values) => {
      const outcome = await inRolledBackTx(async (db) => {
        const { productId } = await freshProduct(db);
        return db.attempt(
          `insert into cartlify.product_variants ("productId", position, price, ${columns})
         values ($1, 2, 10, ${values}) returning id`,
          productId,
        );
      });

      expect(outcome).toMatchObject({ ok: false, code: '42501' });
    },
  );

  it('starts a variant without stock, reserve or sale', async () => {
    const row = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      const id = await variantIn(db, productId);
      const [created] = await db.rows<{
        stock: number;
        reservedStock: number;
        salePrice: string | null;
        saleEndsAt: Date | null;
        salePriorPrice: string | null;
        deletedAt: Date | null;
      }>(
        `select stock, "reservedStock", "salePrice", "saleEndsAt", "salePriorPrice", "deletedAt"
         from cartlify.product_variants where id = $1`,
        id,
      );
      return created;
    });

    expect(row).toEqual({
      stock: 0,
      reservedStock: 0,
      salePrice: null,
      saleEndsAt: null,
      salePriorPrice: null,
      deletedAt: null,
    });
  });

  // the stock is what the batches have left and the reserve is what the waiting orders hold: only
  // the steps of the database change them, and they change them one pair at a time
  it.each([
    ['the stock', 'stock = 5'],
    ['the reserve', '"reservedStock" = 1'],
    ['the stock with the reserve', 'stock = 5, "reservedStock" = 1'],
    ['the stock along with a price', 'stock = 5, price = 11'],
  ])('does not let an admin change %s of a variant', async (_what, set) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      const byAdmin = await updateVariant(db, variantId, set);
      await db.as(asRoot());
      const byRoot = await updateVariant(db, variantId, set);
      await db.as(asSystem());
      return [byAdmin, byRoot, await updateVariant(db, variantId, set)];
    });

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('VARIANT_UPDATE_FORBIDDEN'),
      });
    }
  });

  it('lets an admin change everything else of a variant in one statement', async () => {
    const { outcome, row } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      const outcome = await updateVariant(
        db,
        variantId,
        `price = 12, sku = $2, barcode = $3, position = 7, "weightGrams" = 350,
         "lengthMm" = 200, "widthMm" = 100, "heightMm" = 50, "deletedAt" = now()`,
        `Sku-${uniqueTag()}`,
        digits(13),
      );
      const [row] = await db.rows<{ price: number; position: number; removed: boolean }>(
        `select price::float8 as price, position, "deletedAt" is not null as removed
         from cartlify.product_variants where id = $1`,
        variantId,
      );
      return { outcome, row };
    });

    expect(outcome.ok).toBe(true);
    expect(row).toEqual({ price: 12, position: 7, removed: true });
  });

  it('lets an admin save a variant with the stock it has', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      await batchIdOf(db, asAdmin(), variantId, { quantity: 4 });
      await db.as(asAdmin());
      return updateVariant(db, variantId, 'stock = stock, "reservedStock" = 0, price = 13');
    });

    expect(outcome.ok).toBe(true);
  });

  // the items of an order keep their variant for good
  it('does not let an admin delete a variant that an order holds', async () => {
    const { outcome, left } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      await cartOf(db, user.id, [[variantId, 1]], { delivery: false });
      await db.as(asAdmin());
      const outcome = await db.attempt(
        'delete from cartlify.product_variants where id = $1 returning id',
        variantId,
      );
      return {
        outcome,
        left: await db.rows('select id from cartlify.product_variants where id = $1', variantId),
      };
    });

    expect(outcome).toMatchObject({ ok: false, code: '23503' });
    expect(left).toHaveLength(1);
  });

  it('takes the favorites and the pictures of a variant with it when an admin deletes it', async () => {
    const left = await inRolledBackTx(async (db) => {
      const { productId, variantId, imageId } = await freshProduct(db);
      await db.as(asAdmin());
      await db.rows(
        'insert into cartlify.variant_images ("variantId", "imageId", position) values ($1, $2, 1) returning id',
        variantId,
        imageId,
      );
      await db.as(asUser());
      await db.rows(
        'insert into cartlify.favorites ("userId", "productId", "variantId") values ($1, $2, $3) returning id',
        user.id,
        productId,
        variantId,
      );
      await db.as(asAdmin());
      await db.rows('delete from cartlify.product_variants where id = $1 returning id', variantId);
      const [row] = await db.rows<{ favorites: number; pictures: number; gallery: number }>(
        `select (select count(*)::int from cartlify.favorites where "variantId" = $1) as favorites,
                (select count(*)::int from cartlify.variant_images where "variantId" = $1) as pictures,
                (select count(*)::int from cartlify.product_images where id = $2) as gallery`,
        variantId,
        imageId,
      );
      return row;
    });

    // the picture stays in the gallery of the product
    expect(left).toEqual({ favorites: 0, pictures: 0, gallery: 1 });
  });
});

describe('the pictures of a variant', () => {
  const insertShown = (db: DbSession, variantId: number, imageId: number, position: number) =>
    db.attempt<{ id: number }>(
      `insert into cartlify.variant_images ("variantId", "imageId", position)
       values ($1, $2, $3) returning id`,
      variantId,
      imageId,
      position,
    );

  it('shows a picture of the gallery once in a variant, and in every variant that wants it', async () => {
    const { first, again, otherVariant } = await inRolledBackTx(async (db) => {
      const { productId, variantId, imageId } = await freshProduct(db);
      const second = await variantIn(db, productId, { position: 2 });
      await db.as(asAdmin());
      return {
        first: await insertShown(db, variantId, imageId, 1),
        again: await insertShown(db, variantId, imageId, 2),
        otherVariant: await insertShown(db, second, imageId, 1),
      };
    });

    expect(first.ok).toBe(true);
    expect(again).toMatchObject(refusal('23505', 'variant_images_variantId_imageId_key'));
    expect(otherVariant.ok).toBe(true);
  });

  it('is at one place among the pictures of its variant, checked when the transaction ends', async () => {
    const { second, check } = await inRolledBackTx(async (db) => {
      const { productId, variantId, imageId } = await freshProduct(db);
      const next = await addImage(db, productId);
      await db.as(asAdmin());
      await insertShown(db, variantId, imageId, 1);
      return {
        second: await insertShown(db, variantId, next, 1),
        check: await checkDeferredNow(db),
      };
    });

    expect(second.ok).toBe(true);
    expect(check).toMatchObject(refusal('23505', 'variant_images_position_key'));
  });

  it('lets the pictures of a variant change places, and two variants use the same places', async () => {
    const { check, order, imageId, next } = await inRolledBackTx(async (db) => {
      const { productId, variantId, imageId } = await freshProduct(db);
      const next = await addImage(db, productId);
      const other = await variantIn(db, productId, { position: 2 });
      await db.as(asAdmin());
      await insertShown(db, variantId, imageId, 1);
      await insertShown(db, variantId, next, 2);
      await insertShown(db, other, imageId, 1);
      await db.rows(
        'update cartlify.variant_images set position = 2 where "variantId" = $1 and "imageId" = $2 returning id',
        variantId,
        imageId,
      );
      await db.rows(
        'update cartlify.variant_images set position = 1 where "variantId" = $1 and "imageId" = $2 returning id',
        variantId,
        next,
      );
      return {
        check: await checkDeferredNow(db),
        order: (
          await db.rows<{ imageId: number }>(
            'select "imageId" from cartlify.variant_images where "variantId" = $1 order by position',
            variantId,
          )
        ).map((row) => row.imageId),
        imageId,
        next,
      };
    });

    expect(check.ok).toBe(true);
    expect(order).toEqual([next, imageId]);
  });

  it.each([0, -1])('refuses the place %i', async (position) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId, imageId } = await freshProduct(db);
      await db.as(asAdmin());
      return insertShown(db, variantId, imageId, position);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('leaves every variant that showed a picture when the picture leaves the gallery', async () => {
    const { before, after, gallery } = await inRolledBackTx(async (db) => {
      const { productId, variantId, imageId } = await freshProduct(db);
      const keep = await addImage(db, productId);
      const second = await variantIn(db, productId, { position: 2 });
      await db.as(asAdmin());
      for (const id of [variantId, second]) {
        await insertShown(db, id, imageId, 1);
        await insertShown(db, id, keep, 2);
      }
      const count = async () =>
        (
          await db.rows<{ variantId: number; imageId: number }>(
            `select "variantId", "imageId" from cartlify.variant_images
             where "variantId" = any($1::int[]) order by "variantId", position`,
            [variantId, second],
          )
        ).length;
      const before = await count();
      await db.rows('delete from cartlify.product_images where id = $1 returning id', imageId);
      return {
        before,
        after: await db.rows<{ imageId: number }>(
          `select "imageId" from cartlify.variant_images
           where "variantId" = any($1::int[]) order by "variantId"`,
          [variantId, second],
        ),
        gallery: keep,
      };
    });

    expect(before).toBe(4);
    expect(after).toEqual([{ imageId: gallery }, { imageId: gallery }]);
  });

  // the gallery belongs to the product: a variant shows its pictures, not those of another product
  it('refuses a picture of the gallery of another product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      const foreign = await freshProduct(db);
      await db.as(asAdmin());
      return insertShown(db, variantId, foreign.imageId, 1);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'VARIANT_IMAGE_NOT_FOUND' });
  });

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('shows %s the pictures of a variant and lets them change none', async (_who, actor) => {
    const { seen, outcomes } = await inRolledBackTx(async (db) => {
      const { variantId, imageId, productId } = await freshProduct(db);
      const next = await addImage(db, productId);
      await db.as(asAdmin());
      await insertShown(db, variantId, imageId, 1);
      await db.as(actor());
      return {
        seen: await db.rows(
          'select id from cartlify.variant_images where "variantId" = $1',
          variantId,
        ),
        outcomes: [
          await insertShown(db, variantId, next, 2),
          await db.attempt(
            'update cartlify.variant_images set position = 5 where "variantId" = $1 returning id',
            variantId,
          ),
          await db.attempt(
            'delete from cartlify.variant_images where "variantId" = $1 returning id',
            variantId,
          ),
        ],
      };
    });

    expect(seen).toHaveLength(1);
    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('lets %s add, move and remove the pictures of a variant', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { variantId, imageId } = await freshProduct(db);
      await db.as(actor());
      return [
        await insertShown(db, variantId, imageId, 1),
        await db.attempt(
          'update cartlify.variant_images set position = 2 where "variantId" = $1 returning id',
          variantId,
        ),
        await db.attempt(
          'delete from cartlify.variant_images where "variantId" = $1 returning id',
          variantId,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });
});

// a product that leaves the catalog takes its live variants with it, at the same time; a restore
// brings back the ones that went with it and leaves the ones an admin had taken out before
describe('a product removed from the catalog and its variants', () => {
  type Marks = { id: number; sameTime: boolean; removed: boolean };

  const marksOf = (db: DbSession, productId: number) =>
    db.rows<Marks>(
      `select v.id, v."deletedAt" = p."deletedAt" as "sameTime", v."deletedAt" is not null as removed
       from cartlify.product_variants as v
       join cartlify.products as p on p.id = v."productId"
       where p.id = $1 order by v.position`,
      productId,
    );

  it('takes the live variants with the product, at the time of the product', async () => {
    const marks = await inRolledBackTx(async (db) => {
      const { productId } = await freshProduct(db);
      await variantIn(db, productId, { position: 2 });
      await setRemoval(db, productId, 'now()');
      return marksOf(db, productId);
    });

    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.sameTime)).toBe(true);
  });

  it('leaves a variant taken out of sale earlier at its own time', async () => {
    const marks = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await variantIn(db, productId, { position: 2 });
      await updateVariant(db, variantId, `"deletedAt" = now() - interval '1 day'`);
      await setRemoval(db, productId, 'now()');
      return marksOf(db, productId);
    });

    expect(marks.map((mark) => [mark.removed, mark.sameTime])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('brings back the variants that went with the product and not the ones removed before', async () => {
    const { removed, restored } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await variantIn(db, productId, { position: 2 });
      await variantIn(db, productId, { position: 3 });
      await updateVariant(db, variantId, `"deletedAt" = now() - interval '1 day'`);
      await setRemoval(db, productId, 'now()');
      const removed = await marksOf(db, productId);
      await setRemoval(db, productId, 'null');
      return { removed, restored: await marksOf(db, productId) };
    });

    expect(removed.every((mark) => mark.removed)).toBe(true);
    expect(restored.map((mark) => mark.removed)).toEqual([true, false, false]);
  });

  it('does not let an admin move a variant to another product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      const other = await freshProduct(db);
      await db.as(asAdmin());
      return db.attempt(
        'update cartlify.product_variants set "productId" = $2 where id = $1 returning id',
        variantId,
        other.productId,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let an admin bring back a variant of a product that is removed', async () => {
    const { blocked, afterProductRestore } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await setRemoval(db, productId, 'now()');
      await db.as(asAdmin());
      const blocked = await db.attempt(
        'update cartlify.product_variants set "deletedAt" = null where id = $1 returning id',
        variantId,
      );
      await setRemoval(db, productId, 'null');
      return { blocked, afterProductRestore: await marksOf(db, productId) };
    });

    expect(blocked.ok).toBe(false);
    expect(afterProductRestore.map((mark) => mark.removed)).toEqual([false]);
  });

  it('leaves the variants of the other products alone', async () => {
    const marks = await inRolledBackTx(async (db) => {
      const own = await freshProduct(db);
      const other = await freshProduct(db);
      await setRemoval(db, own.productId, 'now()');
      return marksOf(db, other.productId);
    });

    expect(marks).toEqual([expect.objectContaining({ removed: false })]);
  });

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('does not let %s remove a product or its variants', async (_who, actor) => {
    const marks = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.as(actor());
      await setRemoval(db, productId, 'now()');
      await updateVariant(db, variantId, '"deletedAt" = now()');
      await db.as(asAdmin());
      return marksOf(db, productId);
    });

    expect(marks).toEqual([expect.objectContaining({ removed: false })]);
  });
});

describe('the favorites of a variant', () => {
  const insertFavorite = (
    db: DbSession,
    item: { productId: number; variantId: number },
    owner: { userId?: number; guestId?: string } = { userId: user.id },
  ) =>
    db.attempt(
      `insert into cartlify.favorites ("userId", "guestId", "productId", "variantId")
       values ($1, $2::uuid, $3, $4) returning id`,
      owner.userId ?? null,
      owner.guestId ?? null,
      item.productId,
      item.variantId,
    );

  it('are refused for a variant taken out of sale, and stay when the variant is taken out after', async () => {
    const { before, refused, guest, kept } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      const second = await variantIn(db, productId, { position: 2 });
      await db.as(asUser());
      const before = await insertFavorite(db, { productId, variantId: second });
      await db.as(asAdmin());
      await updateVariant(db, second, '"deletedAt" = now()');
      await updateVariant(db, variantId, '"deletedAt" = now()');
      await db.as(asUser());
      const refused = await insertFavorite(db, { productId, variantId });
      const guestId = randomUUID();
      await db.as({ role: 'GUEST', guestId });
      const guest = await insertFavorite(db, { productId, variantId }, { guestId });
      await db.as(asUser());
      const kept = await db.rows(
        'select id from cartlify.favorites where "variantId" = $1',
        second,
      );
      return { before, refused, guest, kept };
    });

    expect(before.ok).toBe(true);
    for (const outcome of [refused, guest]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('VARIANT_NOT_FOUND'),
      });
    }
    expect(kept).toHaveLength(1);
  });

  it('are refused for a variant of a product removed from the catalog', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.as(asAdmin());
      await setRemoval(db, productId, 'now()');
      await db.as(asUser());
      return insertFavorite(db, { productId, variantId });
    });

    // the product is gone, so the rule of the product answers first
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRODUCT_NOT_FOUND'),
    });
  });

  it('are kept once for a variant by a user, and kept for two variants of one product', async () => {
    const { first, again, second } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      const other = await variantIn(db, productId, { position: 2 });
      await db.as(asUser());
      return {
        first: await insertFavorite(db, { productId, variantId }),
        again: await insertFavorite(db, { productId, variantId }),
        second: await insertFavorite(db, { productId, variantId: other }),
      };
    });

    expect(first.ok).toBe(true);
    expect(again).toMatchObject(refusal('23505', 'favorites_userId_variantId_key'));
    expect(second.ok).toBe(true);
  });

  it('are kept once for a variant by a guest too', async () => {
    const guestId = randomUUID();

    const { first, again } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.as({ role: 'GUEST', guestId });
      return {
        first: await insertFavorite(db, { productId, variantId }, { guestId }),
        again: await insertFavorite(db, { productId, variantId }, { guestId }),
      };
    });

    expect(first.ok).toBe(true);
    expect(again).toMatchObject(refusal('23505', 'favorites_guestId_variantId_key'));
  });
});

// a row that names a variant names its product too, and the pair is one key: the product of the
// row is the product of the variant
describe('the rows that name a variant and a product', () => {
  it('refuse a favorite and an item of an order with a variant of another product', async () => {
    const { favorite, item } = await inRolledBackTx(async (db) => {
      const own = await freshProduct(db);
      const foreign = await freshProduct(db);
      const orderId = await cartOf(db, user.id, [], { delivery: false });
      await db.as(asUser());
      const favorite = await db.attempt(
        `insert into cartlify.favorites ("userId", "productId", "variantId") values ($1, $2, $3) returning id`,
        user.id,
        own.productId,
        foreign.variantId,
      );
      const item = await db.attempt(
        `insert into cartlify.order_items ("orderId", "productId", "variantId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, $3, 1, 0, 0) returning id`,
        orderId,
        own.productId,
        foreign.variantId,
      );
      return { favorite, item };
    });

    expect(favorite).toMatchObject({ ok: false, code: '23503' });
    expect(item).toMatchObject({ ok: false, code: '23503' });
  });

  it.each([
    ['favorites', 'CASCADE'],
    ['product_batches', 'CASCADE'],
    ['order_items', 'RESTRICT'],
    ['order_batch_allocations', 'RESTRICT'],
    ['product_price_change_logs', 'RESTRICT'],
  ])('are tied to the pair of the variant in %s, which goes %s', async (table, onDelete) => {
    const rules = await inRolledBackTx((db) =>
      db.rows<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
         from pg_constraint
         where contype = 'f' and conrelid = ('cartlify.' || $1)::regclass
           and confrelid = 'cartlify.product_variants'::regclass`,
        table,
      ),
    );

    expect(rules).toHaveLength(1);
    expect(rules[0]!.definition).toBe(
      `FOREIGN KEY ("variantId", "productId") REFERENCES product_variants(id, "productId") ON UPDATE CASCADE ON DELETE ${onDelete}`,
    );
  });

  // the functions that write a batch, what a sale took and a line of the log of prices find the
  // product of the variant themselves
  it('are written by the functions of the database with the product of the variant', async () => {
    const found = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.as(asAdmin());
      const batchId = await batchIdOf(db, asAdmin(), variantId, { quantity: 3 });
      await db.rows(
        `select 1 as done from cartlify.log_variant_price_change($1::int, 10, 12, 'fixed', 2, 'price.set')`,
        variantId,
      );
      const [row] = await db.rows<{ batch: number; log: number }>(
        `select
           (select count(*)::int from cartlify.product_batches
            where id = $1 and "variantId" = $2 and "productId" = $3) as batch,
           (select count(*)::int from cartlify.product_price_change_logs
            where "variantId" = $2 and "productId" = $3) as log`,
        batchId,
        variantId,
        productId,
      );
      return row;
    });

    expect(found).toEqual({ batch: 1, log: 1 });
  });
});

describe('cartlify.variant_display_name', () => {
  const nameOf = async (db: DbSession, variantId: number) => {
    const [row] = await db.rows<{ name: string | null }>(
      'select cartlify.variant_display_name($1::int) as name',
      variantId,
    );
    return row!.name;
  };

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
    ['an admin', asAdmin],
  ])('is the name of the product of the variant, read by %s', async (_who, actor) => {
    const { name, expected } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      const second = await variantIn(db, productId, { position: 2 });
      const [product] = await db.rows<{ name: string }>(
        'select name from cartlify.products where id = $1',
        productId,
      );
      await db.as(actor());
      return {
        name: [await nameOf(db, variantId), await nameOf(db, second)],
        expected: product!.name,
      };
    });

    expect(name).toEqual([expected, expected]);
  });

  it('follows a rename of the product, and names a variant taken out of sale too', async () => {
    const { renamed, removed } = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      await db.rows(
        `update cartlify.products set name = 'A new name' where id = $1 returning id`,
        productId,
      );
      const renamed = await nameOf(db, variantId);
      await updateVariant(db, variantId, '"deletedAt" = now()');
      return { renamed, removed: await nameOf(db, variantId) };
    });

    expect(renamed).toBe('A new name');
    expect(removed).toBe('A new name');
  });

  it('is empty for a variant that does not exist', async () => {
    const name = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return nameOf(db, 2_000_000_000);
    });

    expect(name).toBeNull();
  });
});

// the units that sit in batches whose last good day is over, counted for one variant
describe('cartlify.variant_expired_units', () => {
  const DAY = '2030-06-10';

  it('counts the units left in the batches of that variant that are over, and no other', async () => {
    const counted = await inRolledBackTx(async (db) => {
      const { productId, variantId } = await freshProduct(db);
      const sibling = await variantIn(db, productId, { position: 2 });
      const foreign = (await freshProduct(db)).variantId;
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), variantId, { quantity: 3, expiresAt: DAY });
      await batchIdOf(db, asAdmin(), variantId, { quantity: 2, expiresAt: dayAfter(DAY, 5) });
      await batchIdOf(db, asAdmin(), sibling, { quantity: 4, expiresAt: DAY });
      await batchIdOf(db, asAdmin(), foreign, { quantity: 7, expiresAt: DAY });
      await setShopDay(db, dayAfter(DAY));
      return [
        await expiredUnitsOf(db, variantId),
        await expiredUnitsOf(db, sibling),
        await expiredUnitsOf(db, foreign),
      ];
    });

    expect(counted).toEqual([3, 4, 7]);
  });

  it('counts what a batch has left and not what came in, and not a batch good until today', async () => {
    const counted = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), variantId, { quantity: 5, expiresAt: DAY });
      await writeOff(db, asAdmin(), variantId, { quantity: 2 });
      const onTheDay = await expiredUnitsOf(db, variantId);
      await setShopDay(db, dayAfter(DAY));
      return { onTheDay, dayAfter: await expiredUnitsOf(db, variantId) };
    });

    expect(counted).toEqual({ onTheDay: 0, dayAfter: 3 });
  });

  it('is zero for a variant without a batch and for one that does not exist', async () => {
    const counted = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      await setShopDay(db, DAY);
      return [await expiredUnitsOf(db, variantId), await expiredUnitsOf(db, 2_000_000_000)];
    });

    expect(counted).toEqual([0, 0]);
  });

  // a buyer reads no batch; the count is all that comes out to them
  it('can be asked by a user, who sees no batch', async () => {
    const { counted, batches } = await inRolledBackTx(async (db) => {
      const { variantId } = await freshProduct(db);
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), variantId, { quantity: 3, expiresAt: DAY });
      await setShopDay(db, dayAfter(DAY));
      await db.as(asUser());
      return {
        counted: await expiredUnitsOf(db, variantId),
        batches: await db.rows(
          'select id from cartlify.product_batches where "variantId" = $1',
          variantId,
        ),
      };
    });

    expect(counted).toBe(3);
    expect(batches).toEqual([]);
  });
});
