import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { loadShopSettings } from '@config/shopSettings.js';
import { parseDatabaseUrl, prisma } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import { asAdmin, inRolledBackTx, type DbSession, testTx } from '../../helpers/db.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createAttribute,
  createAttributeGroup,
  createAttributeOption,
  createChatThread,
  createDocument,
  createFavorite,
  createLoginLog,
  createProduct,
  createResetToken,
  createReview,
  createReviewVote,
  createUser,
  createVariantValue,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import {
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  type NewsletterFixtures,
} from '../../helpers/newsletterDb.js';

// the actor context every rls policy reads: cartlify.set_current_context writes it for the
// transaction, current_actor_role, current_actor_id and current_guest_id read it. Without a
// context the database must show and change nothing: a query the app sends without one is a bug
// of the app, and the database is the last line that holds

type Readers = {
  role: string | null;
  userId: number | null;
  guestId: string | null;
  admin: boolean;
  root: boolean;
  owner: boolean;
  ownerOrAdmin: boolean;
};

// what every reader says, is_owner and is_owner_or_admin about the user given
const readers = async (db: DbSession, ownerOf: number): Promise<Readers> => {
  const [row] = await db.rows<Readers>(
    `select cartlify.current_actor_role()::text as role,
            cartlify.current_actor_id() as "userId",
            cartlify.current_guest_id()::text as "guestId",
            cartlify.is_admin() as admin,
            cartlify.is_root() as root,
            cartlify.is_owner($1::int) as owner,
            cartlify.is_owner_or_admin($1::int) as "ownerOrAdmin"`,
    ownerOf,
  );
  return row!;
};

const NO_CONTEXT: Readers = {
  role: null,
  userId: null,
  guestId: null,
  admin: false,
  root: false,
  owner: false,
  ownerOrAdmin: false,
};

// the tables of the shop with the first column of each; the prisma history is the owner's alone
const tablesOf = (db: DbSession) =>
  db.rows<{ name: string; column: string }>(
    `select c.relname as name, a.attname as column
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attnum = 1
     where c.relnamespace = 'cartlify'::regnamespace
       and c.relkind in ('r', 'p')
       and c.relname <> '_prisma_migrations'
     order by c.relname`,
  );

const countOf = async (db: DbSession, table: string) =>
  (await db.rows<{ n: number }>(`select count(*)::int as n from cartlify."${table}"`))[0]!.n;

let owner: TestUser;
let voter: TestUser;
let admin: TestUser;
let product: TestProduct;
let orderId: number;
// the rows of the newsletter tables, which only the functions of the database write: made as the
// owner of the database and committed, because the app role has to find them
let newsletters: NewsletterFixtures;

// a row in every table of the shop, made the way the app makes it, so "shows no row" means the
// rows are there and hidden
beforeAll(async () => {
  // this file calls no startApp, which is what every other file fills a default of the data of
  // the shop with; without one of its own this table would show 0 rows to root and to the owner
  // alike, unlike every other table of the schema, whenever this file ran before such a file
  await loadShopSettings();
  newsletters = await setupNewsletterFixtures();
  owner = await createUser();
  voter = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10 });

  const review = await createReview(owner.id, product.id);
  await createReviewVote(voter.id, review.id, 'UP');
  await createFavorite(owner.id, product.id);
  await createDocument({ productId: product.id });
  // the directory of characteristics, with one of each: a group, a choice, a value, and a category
  // that asks for the choice
  const choice = await createAttribute({
    type: 'option',
    groupId: (await createAttributeGroup()).id,
  });
  await createAttributeOption(choice.id);
  // the value a variant has of a characteristic
  const note = await createAttribute({ type: 'text' });
  await createVariantValue(product.variantId, note.id, { text: 'Matte' });
  await asAdmin((tx) =>
    tx.categoryAttribute.create({
      data: { categoryId: product.categoryId, attributeId: choice.id },
    }),
  );
  await createChatThread(owner.id);
  await createLoginLog(owner, new Date());
  await createResetToken(owner.id);

  orderId = await testTx(async (tx) => {
    await setUserContext(tx, { userId: owner.id, role: 'USER' });
    const order = await tx.order.create({
      data: {
        userId: owner.id,
        total: 0,
        items: {
          create: {
            productId: product.id,
            variantId: product.variantId,
            quantity: 1,
            unitPrice: 10,
            totalPrice: 10,
          },
        },
      },
      select: { id: true },
    });
    return order.id;
  });

  // a paid order: what it took from the batch of the product is in order_batch_allocations
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: owner.id, role: 'USER' });
    const paid = await tx.order.create({
      data: {
        userId: owner.id,
        total: 0,
        delivery: {
          create: {
            method: 'manual',
            recipientFirstName: 'Anna',
            recipientLastName: 'Koval',
            recipientPhone: '+380501234567',
            country: 'UA',
            postalCode: '01001',
            city: 'Kyiv',
            street: 'Test street',
            house: '1',
          },
        },
        items: {
          create: {
            productId: product.id,
            variantId: product.variantId,
            quantity: 1,
            unitPrice: 10,
            totalPrice: 10,
          },
        },
      },
      select: { id: true },
    });
    await tx.$executeRaw`select cartlify.confirm_order(${paid.id}::int, '15 minutes'::interval)`;
    await setAdminContext(tx);
    await tx.$executeRaw`select cartlify.pay_order(${paid.id}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_context_${paid.id}`}, 10)`;
    // sent: a row of the sends of the order
    await tx.$executeRaw`update cartlify.orders set status = 'shipped' where id = ${paid.id}`;
    await tx.$executeRaw`insert into cartlify.order_shipments ("orderId", carrier) values (${paid.id}, 'DHL')`;
  });

  await testTx(async (tx) => {
    await setUserContext(tx, { userId: admin.id, role: 'ADMIN' });
    await tx.$executeRaw`select cartlify.log_admin_action(
      ${admin.id}::int, 'ADMIN'::cartlify."Role", 'product'::cartlify."AdminAuditEntityType",
      ${product.id}::int, 'OTHER'::cartlify."AdminAuditAction", 'product.update', '[]'::jsonb)`;
    await tx.$executeRaw`select cartlify.log_variant_price_change(
      ${product.variantId}::int, 10, 12, 'fixed'::cartlify."PriceChangeMode", 2, 'price.set')`;
    // a setting of an alert of the admin
    await tx.adminAlertSetting.create({
      data: { userId: admin.id, kind: 'low_stock', subscribed: false, threshold: 10 },
    });
  });
});

afterAll(async () => {
  try {
    if (newsletters) await removeNewsletterFixtures(newsletters);
    await closeSessions([owner.id, voter.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

describe('cartlify.set_current_context', () => {
  it('gives the readers the role and the id of a user', async () => {
    const { self, other } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: 41 });
      return { self: await readers(db, 41), other: await readers(db, 42) };
    });

    expect(self).toEqual({
      ...NO_CONTEXT,
      role: 'USER',
      userId: 41,
      owner: true,
      ownerOrAdmin: true,
    });
    expect(other).toEqual({ ...NO_CONTEXT, role: 'USER', userId: 41 });
  });

  it.each(['ADMIN', 'ROOT'] as const)('makes an %s an admin of every row', async (role) => {
    const context = await inRolledBackTx(async (db) => {
      await db.as({ role, userId: 41 });
      return readers(db, 42);
    });

    expect(context).toEqual({
      ...NO_CONTEXT,
      role,
      userId: 41,
      admin: true,
      root: role === 'ROOT',
      ownerOrAdmin: true,
    });
  });

  it('gives a guest its guest id and no user id, also when a user id comes along', async () => {
    const guestId = randomUUID();

    const context = await inRolledBackTx(async (db) => {
      await db.as({ role: 'GUEST', guestId, userId: 41 });
      return readers(db, 41);
    });

    expect(context).toEqual({ ...NO_CONTEXT, role: 'GUEST', guestId });
  });

  it('gives a user no guest id, also when a guest id comes along', async () => {
    const context = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: 41, guestId: randomUUID() });
      return readers(db, 41);
    });

    expect(context).toMatchObject({ role: 'USER', userId: 41, guestId: null });
  });

  it('replaces the whole context: nothing of the actor before stays', async () => {
    const guestId = randomUUID();

    const { guestAfterUser, userAfterGuest } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: 41 });
      await db.as({ role: 'GUEST', guestId });
      const guestAfterUser = await readers(db, 41);

      await db.as({ role: 'GUEST', guestId });
      await db.as({ role: 'USER', userId: 41 });
      return { guestAfterUser, userAfterGuest: await readers(db, 41) };
    });

    expect(guestAfterUser).toEqual({ ...NO_CONTEXT, role: 'GUEST', guestId });
    expect(userAfterGuest).toMatchObject({ role: 'USER', userId: 41, guestId: null });
  });

  // the system acts as an admin without an id (setAdminContext); a signed-in admin has one
  it('tells the system apart from a signed-in admin', async () => {
    const isSystem = await inRolledBackTx(async (db) => {
      const result: Record<string, boolean> = {};
      for (const [who, actor] of [
        ['system', { role: 'ADMIN' }],
        ['admin', { role: 'ADMIN', userId: 41 }],
        ['root without an id', { role: 'ROOT' }],
        ['user', { role: 'USER', userId: 41 }],
        ['none', null],
      ] as const) {
        await db.as(actor);
        const [row] = await db.rows<{ system: boolean }>('select cartlify.is_system() as system');
        result[who] = row!.system;
      }
      return result;
    });

    expect(isSystem).toEqual({
      system: true,
      admin: false,
      'root without an id': false,
      user: false,
      none: false,
    });
  });

  it('leaves no context when the role is null', async () => {
    const context = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT', userId: 41 });
      await db.as(null);
      return readers(db, 41);
    });

    expect(context).toEqual(NO_CONTEXT);
  });
});

describe('the context readers', () => {
  // set_config is open to every role: a value set_current_context never writes must not
  // become an actor
  it.each([
    ['cartlify.role', 'SUPERUSER'],
    ['cartlify.role', 'root'],
    ['cartlify.role', 'ROOT,USER'],
    ['cartlify.user_id', '41abc'],
    ['cartlify.user_id', '-41'],
    ['cartlify.user_id', '41.5'],
    ['cartlify.guest_id', 'not-a-uuid'],
  ])('read no actor from %s = %s', async (setting, value) => {
    const context = await inRolledBackTx(async (db) => {
      await db.rows('select set_config($1, $2, true)', setting, value);
      return readers(db, 41);
    });

    expect(context).toEqual(NO_CONTEXT);
  });

  it('give no right for a session setting the policies do not read', async () => {
    const { context, users } = await inRolledBackTx(async (db) => {
      for (const setting of ['cartlify.is_admin', 'cartlify.admin', 'cartlify.bypass_rls']) {
        await db.rows('select set_config($1, $2, true)', setting, 'true');
      }
      await db.rows(`select set_config('cartlify.actor_role', 'ROOT', true)`);
      return { context: await readers(db, owner.id), users: await countOf(db, 'users') };
    });

    expect(context).toEqual(NO_CONTEXT);
    expect(users).toBe(0);
  });
});

describe('without a context', () => {
  // the catalog the shop shows to every visitor; reviews name their author. A vote is what one
  // user did, the review keeps the counts. The versions of the terms and of the contract are
  // public too: everybody reads them before accepting them
  const CATALOG = [
    'attribute_groups',
    'attribute_options',
    'attributes',
    'categories',
    'category_attributes',
    'documents',
    'legal_documents',
    'parties',
    'product_documents',
    'product_images',
    'product_variants',
    'products',
    'reviews',
    'variant_images',
    'variant_attribute_values',
  ];

  // the counts of the four contexts are compared, so they come from one snapshot of the tables
  it('shows no row outside the catalog, and of the catalog no more than a visitor sees', async () => {
    const { hidden, visitor, seen } = await inRolledBackTx(
      async (db) => {
        // a version of the terms and a consent to it, made in this transaction only: a version
        // committed would be in force for every other file
        await db.as({ role: 'ROOT', userId: admin.id });
        const [terms] = await db.rows<{ id: number }>(
          `insert into cartlify.legal_documents (kind, title, content, "publishedById")
           values ('terms'::cartlify."LegalDocumentKind", 'Terms', 'Words.', $1) returning id`,
          admin.id,
        );
        await db.as({ role: 'USER', userId: owner.id });
        await db.rows(
          'insert into cartlify.legal_acceptances ("userId", "documentId", "event") values ($1, $2, \'consent.accept\') returning id',
          owner.id,
          terms!.id,
        );

        // a paid order with a statement of return, the same way: the rows of the statement are
        // read by the owner of the order and by an admin only
        const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.variantId, 1]]);
        await db.as({ role: 'ADMIN', userId: admin.id });
        const [item] = await db.rows<{ id: number }>(
          'select id from cartlify.order_items where "orderId" = $1',
          orderId,
        );
        const [made] = await db.rows<{ id: number }>(
          `select cartlify.create_return(
             $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
             'defect'::cartlify."ReturnReason", null, 'Anna', 'anna@example.com', null, null, 4,
             'Europe/Madrid'
           ) as id`,
          orderId,
          JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
        );
        // and a parcel the shop paid to carry the goods back: an admin reads it, nobody else
        await db.rows(
          `select cartlify.record_return_shipment(
             $1::int, 'DHL', null, null, 4.5, (now() at time zone 'UTC')::timestamp(3)
           ) as id`,
          made!.id,
        );
        await db.as(null);

        const tables = await tablesOf(db);
        const count = async () => {
          const counts: Record<string, number> = {};
          for (const { name } of tables) counts[name] = await countOf(db, name);
          return counts;
        };

        const hidden = await count();
        await db.as({ role: 'GUEST', guestId: null });
        const visitor = await count();

        // the same rows with a context: root sees what an admin keeps, the owner the rest
        await db.as({ role: 'ROOT', userId: admin.id });
        const asRoot = await count();
        await db.as({ role: 'USER', userId: owner.id });
        const asOwner = await count();
        const seen = Object.fromEntries(
          tables.map(({ name }) => [name, Math.max(asRoot[name]!, asOwner[name]!)]),
        );

        return { hidden, visitor, seen };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    expect(Object.keys(hidden)).toHaveLength(42);
    expect(Object.entries(hidden).filter(([name, n]) => n > 0 && !CATALOG.includes(name))).toEqual(
      [],
    );
    expect(Object.entries(hidden).filter(([name, n]) => n > visitor[name]!)).toEqual([]);
    expect(Object.entries(seen).filter(([, n]) => n === 0)).toEqual([]);
  });

  it('changes and deletes no row of any table', async () => {
    const changed = await inRolledBackTx(async (db) => {
      const changed: string[] = [];

      for (const { name, column } of await tablesOf(db)) {
        const update = await db.attempt(
          `update cartlify."${name}" set "${column}" = "${column}" returning 1`,
        );
        if (update.ok && update.rows.length)
          changed.push(`${name}: update of ${update.rows.length}`);

        const removal = await db.attempt(`delete from cartlify."${name}" returning 1`);
        if (removal.ok && removal.rows.length)
          changed.push(`${name}: delete of ${removal.rows.length}`);
      }

      return changed;
    });

    expect(changed).toEqual([]);
  });

  // each one acts as the owner past the policies, so it checks the actor first itself
  it.each([
    [
      'auth_get_user_for_login',
      () => `select * from cartlify.auth_get_user_for_login('${owner.email}')`,
      'LOGIN_LOOKUP_FORBIDDEN',
    ],
    [
      'users_get_public_profile',
      () => `select * from cartlify.users_get_public_profile(${owner.id})`,
      'USER_PROFILE_READ_FORBIDDEN',
    ],
    [
      'auth_resend_verify',
      () =>
        `select * from cartlify.auth_resend_verify('${owner.email}', 'hash', now() + interval '1 day')`,
      'VERIFY_RESEND_FORBIDDEN',
    ],
    [
      'auth_verify_email',
      () => `select cartlify.auth_verify_email('hash')`,
      'VERIFY_EMAIL_FORBIDDEN',
    ],
    [
      'migrate_guest_data_to_user',
      () => `select cartlify.migrate_guest_data_to_user(gen_random_uuid(), ${owner.id})`,
      'GUEST_MIGRATION_FORBIDDEN',
    ],
    [
      'confirm_order',
      () => `select cartlify.confirm_order(${orderId}, interval '15 minutes')`,
      'ORDER_CONFIRM_FORBIDDEN',
    ],
    [
      'unconfirm_order',
      () => `select cartlify.unconfirm_order(${orderId})`,
      'ORDER_UNCONFIRM_FORBIDDEN',
    ],
    [
      'cancel_order_payment',
      () => `select cartlify.cancel_order_payment(${orderId})`,
      'ORDER_CANCEL_PAYMENT_FORBIDDEN',
    ],
    [
      'pay_order',
      () => `select cartlify.pay_order(${orderId}, 'stripe', 'pi_none', 10)`,
      'ORDER_PAY_FORBIDDEN',
    ],
    [
      'expire_order_reservation',
      () => `select cartlify.expire_order_reservation(${orderId})`,
      'ORDER_EXPIRE_FORBIDDEN',
    ],
  ])('is refused the system function %s', async (_name, statement, code) => {
    const outcome = await inRolledBackTx((db) => db.attempt(statement()));

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('writes no line to the admin log or the price log', async () => {
    const { audit, price } = await inRolledBackTx(async (db) => ({
      audit: await db.attempt(
        `select cartlify.log_admin_action($1::int, 'ADMIN', 'product', $2::int, 'OTHER', 'product.update', '[]'::jsonb)`,
        admin.id,
        product.id,
      ),
      price: await db.attempt(
        `select 1 as done from cartlify.log_variant_price_change($1::int, 10, 11, 'fixed', 1, 'price.set')`,
        product.variantId,
      ),
    }));

    expect(audit).toMatchObject({ ok: false, code: '42501' });
    // the price log acts as the owner and checks the actor itself
    expect(price).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRICE_LOG_FORBIDDEN'),
    });
  });

  it('refreshes no price of an order', async () => {
    const { refreshed, unitPrice } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      await db.rows(
        'update cartlify.product_variants set price = 15 where id = $1 returning 1',
        product.variantId,
      );
      await db.as(null);
      const [refresh] = await db.rows<{ refreshed: number }>(
        'select cartlify.refresh_order_prices($1::int) as refreshed',
        orderId,
      );

      await db.as({ role: 'USER', userId: owner.id });
      const [item] = await db.rows<{ unitPrice: string }>(
        'select "unitPrice"::text as "unitPrice" from cartlify.order_items where "orderId" = $1',
        orderId,
      );
      return { refreshed: refresh?.refreshed, unitPrice: item?.unitPrice };
    });

    expect(refreshed).toBe(0);
    expect(Number(unitPrice)).toBe(10);
  });
});

describe('the context of a transaction', () => {
  // the pool hands a connection to the next request: a context left on it would act for
  // another user. One connection only, so the next transaction surely takes the same one
  let single: PrismaClient;

  beforeAll(() => {
    const { pool, schema } = parseDatabaseUrl(process.env.DATABASE_URL!);
    single = new PrismaClient({
      adapter: new PrismaPg({ ...pool, max: 1 }, schema ? { schema } : undefined),
    });
  });

  afterAll(async () => {
    await single.$disconnect();
  });

  const roleOnConnection = async () =>
    (
      await single.$queryRawUnsafe<{ role: string | null; pid: number }[]>(
        'select cartlify.current_actor_role()::text as role, pg_backend_pid() as pid',
      )
    )[0]!;

  it('ends with its transaction: the next one on the same connection starts with none', async () => {
    const pid = await single.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`select cartlify.set_current_context('ROOT', 1, null)`);
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('select pg_backend_pid() as pid');
      return row!.pid;
    });

    expect(await roleOnConnection()).toEqual({ role: null, pid });
  });

  it('lasts only for its statement when no transaction is open', async () => {
    const { pid } = await roleOnConnection();
    await single.$executeRawUnsafe(`select cartlify.set_current_context('ROOT', 1, null)`);

    expect(await roleOnConnection()).toEqual({ role: null, pid });
  });
});
