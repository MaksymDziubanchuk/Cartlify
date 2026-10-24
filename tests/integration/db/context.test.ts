import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { parseDatabaseUrl, prisma } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createChatThread,
  createFavorite,
  createLoginLog,
  createProduct,
  createResetToken,
  createReview,
  createReviewVote,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

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

// a row in every table of the shop, made the way the app makes it, so "shows no row" means the
// rows are there and hidden
beforeAll(async () => {
  owner = await createUser();
  voter = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10 });

  const review = await createReview(owner.id, product.id);
  await createReviewVote(voter.id, review.id, 'UP');
  await createFavorite(owner.id, product.id);
  await createChatThread(owner.id);
  await createLoginLog(owner, new Date());
  await createResetToken(owner.id);

  orderId = await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: owner.id, role: 'USER' });
    const order = await tx.order.create({
      data: {
        userId: owner.id,
        total: 0,
        items: { create: { productId: product.id, quantity: 1, unitPrice: 10, totalPrice: 10 } },
      },
      select: { id: true },
    });
    return order.id;
  });

  // a paid order: what it took from the batch of the product is in order_batch_allocations
  await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: owner.id, role: 'USER' });
    const paid = await tx.order.create({
      data: {
        userId: owner.id,
        total: 0,
        shippingAddress: 'Test street 1, Kyiv',
        recipientFirstName: 'Anna',
        recipientLastName: 'Koval',
        recipientPhone: '+380501234567',
        items: { create: { productId: product.id, quantity: 1, unitPrice: 10, totalPrice: 10 } },
      },
      select: { id: true },
    });
    await tx.$executeRaw`select cartlify.confirm_order(${paid.id}::int, '15 minutes'::interval)`;
    await setAdminContext(tx);
    await tx.$executeRaw`select cartlify.pay_order(${paid.id}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_context_${paid.id}`}, 10)`;
  });

  await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: admin.id, role: 'ADMIN' });
    await tx.$executeRaw`select cartlify.log_admin_action(
      ${admin.id}::int, 'ADMIN'::cartlify."Role", 'product'::cartlify."AdminAuditEntityType",
      ${product.id}::int, 'OTHER'::cartlify."AdminAuditAction", '[]'::jsonb)`;
    await tx.$executeRaw`select cartlify.log_product_price_change(
      ${product.id}::int, 10, 12, 'fixed'::cartlify."PriceChangeMode", 2)`;
    // an alert the admin turned off
    await tx.adminAlertMute.create({ data: { userId: admin.id, kind: 'low_stock' } });
  });
});

afterAll(async () => {
  try {
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
  // user did, the review keeps the counts
  const CATALOG = ['categories', 'product_images', 'products', 'reviews'];

  // the counts of the four contexts are compared, so they come from one snapshot of the tables
  it('shows no row outside the catalog, and of the catalog no more than a visitor sees', async () => {
    const { hidden, visitor, seen } = await inRolledBackTx(
      async (db) => {
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

    expect(Object.keys(hidden)).toHaveLength(18);
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
      'cancel_paid_order',
      () => `select cartlify.cancel_paid_order(${orderId})`,
      'ORDER_CANCEL_FORBIDDEN',
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
        `select cartlify.log_admin_action($1::int, 'ADMIN', 'product', $2::int, 'OTHER', '[]'::jsonb)`,
        admin.id,
        product.id,
      ),
      price: await db.attempt(
        `select 1 as done from cartlify.log_product_price_change($1::int, 10, 11, 'fixed', 1)`,
        product.id,
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
        'update cartlify.products set price = 15 where id = $1 returning 1',
        product.id,
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
