import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { cartOf, confirm } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the name an order item copies is the one cartlify.variant_names gives the card: the database
// writes it when the item goes into a cart and again at the confirmation, and then it stays. The
// product here is made for good (it has stock, the items need it); its characteristics and its
// orders live in the rolled-back transaction of each test

let owner: TestUser;
let admin: TestUser;
let product: Awaited<ReturnType<typeof createProduct>>;
let imageId: number;

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ stock: 10 });
  const gallery = await prisma.productImage.findFirstOrThrow({
    where: { productId: product.id },
    select: { id: true },
  });
  imageId = gallery.id;
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// a text characteristic and a second variant of the product that shows a picture, so the two tell
// each other apart; the first variant is the one with stock. Gives the id of the characteristic
async function twoVariants(db: DbSession, values: [string, string]): Promise<number> {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [group] = await db.rows<{ id: number }>(
    'insert into cartlify.attribute_groups (name, position) values ($1, $2) returning id',
    `Names group ${uniqueTag()}`,
    4_000_000 + Math.floor(Math.random() * 1_000_000),
  );
  const [attribute] = await db.rows<{ id: number }>(
    `insert into cartlify.attributes (name, type, "groupId", position)
     values ($1, 'text', $2, 1) returning id`,
    `Names text ${uniqueTag()}`,
    group!.id,
  );
  const [second] = await db.rows<{ id: number }>(
    `insert into cartlify.product_variants ("productId", position, price) values ($1, 99, 10) returning id`,
    product.id,
  );
  await db.rows(
    'insert into cartlify.variant_images ("variantId", "imageId", position) values ($1, $2, 1) returning id',
    second!.id,
    imageId,
  );
  for (const [variantId, text] of [
    [product.variantId, values[0]],
    [second!.id, values[1]],
  ] as const) {
    await db.rows(
      `insert into cartlify.variant_attribute_values ("variantId", "attributeId", "textValue")
       values ($1, $2, $3) returning id`,
      variantId,
      attribute!.id,
      text,
    );
  }
  return attribute!.id;
}

const nameFromCard = async (db: DbSession, variantId: number) => {
  const [row] = await db.rows<{ name: string }>(
    'select name from cartlify.variant_names(array[$1::int])',
    variantId,
  );
  return row!.name;
};

const itemName = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ name: string | null }>(
    'select "productName" as name from cartlify.order_items where "orderId" = $1',
    orderId,
  );
  return row!.name;
};

const setText = async (db: DbSession, variantId: number, attributeId: number, text: string) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  await db.rows(
    `update cartlify.variant_attribute_values set "textValue" = $3
     where "variantId" = $1 and "attributeId" = $2 returning id`,
    variantId,
    attributeId,
    text,
  );
};

describe('the name an order item keeps', () => {
  it('is the one of the card when the item goes into a cart', async () => {
    const found = await inRolledBackTx(async (db) => {
      await twoVariants(db, ['black', 'white']);
      const orderId = await cartOf(db, owner.id, [[product.variantId, 1]]);
      return { item: await itemName(db, orderId), card: await nameFromCard(db, product.variantId) };
    });

    expect(found.item).toBe(found.card);
    expect(found.card).toContain('black');
  });

  it('follows the values while the order is a cart: the confirmation writes the name of that moment', async () => {
    const found = await inRolledBackTx(async (db) => {
      const attributeId = await twoVariants(db, ['black', 'white']);
      const orderId = await cartOf(db, owner.id, [[product.variantId, 1]]);
      const inCart = await itemName(db, orderId);

      await setText(db, product.variantId, attributeId, 'graphite');
      const confirmed = await confirm(db, owner.id, orderId);
      return {
        inCart,
        confirmed,
        item: await itemName(db, orderId),
        card: await nameFromCard(db, product.variantId),
      };
    });

    expect(found.confirmed.ok).toBe(true);
    expect(found.inCart).toContain('black');
    expect(found.item).toBe(found.card);
    expect(found.item).toContain('graphite');
  });

  it('stays once the order is confirmed, whatever happens to the values', async () => {
    const found = await inRolledBackTx(async (db) => {
      const attributeId = await twoVariants(db, ['black', 'white']);
      const orderId = await cartOf(db, owner.id, [[product.variantId, 1]]);
      const confirmed = await confirm(db, owner.id, orderId);
      const kept = await itemName(db, orderId);

      await setText(db, product.variantId, attributeId, 'graphite');
      return {
        confirmed,
        kept,
        later: await itemName(db, orderId),
        card: await nameFromCard(db, product.variantId),
      };
    });

    expect(found.confirmed.ok).toBe(true);
    expect(found.later).toBe(found.kept);
    expect(found.kept).toContain('black');
    expect(found.card).toContain('graphite');
  });
});
