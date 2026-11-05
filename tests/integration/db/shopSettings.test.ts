import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// shop_settings: a version of the data of the shop (delivery, brand, reservation, moderation,
// withdrawal, languages, the seller), added by root, or by the system to fill in the default of a
// field root left empty. A row is never changed or removed; the current version is the highest
// number. All in transactions that roll back: no other file sees a row made here

let admin: TestUser;
let root: TestUser;
let other: TestUser;

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  other = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, root.id, other.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });
const SYSTEM: Actor = { role: 'ADMIN', userId: null };

type Written = {
  id: number;
  version: number;
  setById: number | null;
  basedOnVersion: number | null;
};

// the version of the row the rest of the suite already committed (*.shopwide.test.ts and the
// system fill of every file's startApp write real rows this file only reads, never changes): a
// fresh table and a well-used one behave the same, this file never assumes which one it is
const currentVersion = async (db: DbSession) =>
  (
    await db.rows<{ version: number }>(
      'select coalesce(max(version), 0)::int as version from cartlify.shop_settings',
    )
  )[0]!.version;

// a full row of fields a write needs, with the value of a field overridable; a write of root's
// takes the version it claims to have seen (0 for the first one)
const write = (db: DbSession, opts: { setById?: number | null; basedOnVersion?: number | null }) =>
  db.attempt<Written>(
    `insert into cartlify.shop_settings
       ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById", "basedOnVersion")
     values ('{manual}', '{UA}', '{en}', 'en', $1, $2)
     returning id, version, "setById", "basedOnVersion"`,
    opts.setById ?? null,
    opts.basedOnVersion ?? null,
  );

describe('shop_settings versions', () => {
  it('lets root write the next version, claiming the version it saw', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const base = await currentVersion(db);
      const written = await write(db, { setById: root.id, basedOnVersion: base });
      return { base, written };
    });

    expect(result.written.ok && result.written.rows[0]).toMatchObject({
      version: result.base + 1,
      setById: root.id,
      basedOnVersion: result.base,
    });
  });

  it('refuses a write of root that claims a version the table has moved past', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const base = await currentVersion(db);
      const first = await write(db, { setById: root.id, basedOnVersion: base });
      const stale = await write(db, { setById: root.id, basedOnVersion: base });
      const fresh = await write(db, { setById: root.id, basedOnVersion: base + 1 });
      return { base, first, stale, fresh };
    });

    expect(result.first.ok).toBe(true);
    expect(result.stale).toEqual({ ok: false, code: '23514', message: 'SHOP_SETTINGS_OUTDATED' });
    expect(result.fresh.ok && result.fresh.rows[0]).toMatchObject({ version: result.base + 2 });
  });

  it('lets the system write a version with no author and no claimed version', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(SYSTEM);
      const base = await currentVersion(db);
      const written = await write(db, { setById: null, basedOnVersion: null });
      return { base, written };
    });

    expect(result.written.ok && result.written.rows[0]).toMatchObject({
      version: result.base + 1,
      setById: null,
      basedOnVersion: null,
    });
  });

  it("refuses root writing in another root's name, and the system writing with an author", async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const base = await currentVersion(db);
      const forOther = await write(db, { setById: other.id, basedOnVersion: base });
      await db.as(SYSTEM);
      const systemNamed = await write(db, { setById: root.id, basedOnVersion: null });
      return { forOther, systemNamed };
    });

    expect(result.forOther.ok).toBe(false);
    expect(result.systemNamed.ok).toBe(false);
  });

  it('refuses a write of a signed-in admin, a buyer or a guest', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const byAdmin = await write(db, { setById: admin.id, basedOnVersion: 0 });
      await db.as(null);
      const byNobody = await write(db, {});
      return { byAdmin, byNobody };
    });

    expect(result.byAdmin.ok).toBe(false);
    expect(result.byNobody.ok).toBe(false);
  });

  it('never lets a version be changed or removed, by root or by the system', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const base = await currentVersion(db);
      const made = await write(db, { setById: root.id, basedOnVersion: base });
      const id = made.ok ? made.rows[0]!.id : -1;

      const updated = await db.attempt(
        `update cartlify.shop_settings set "shopName" = 'x' where id = $1`,
        id,
      );
      const deleted = await db.attempt(`delete from cartlify.shop_settings where id = $1`, id);

      await db.as(SYSTEM);
      const updatedBySystem = await db.attempt(
        `update cartlify.shop_settings set "shopName" = 'x' where id = $1`,
        id,
      );

      return { made, updated, deleted, updatedBySystem };
    });

    expect(result.made.ok).toBe(true);
    // RLS already hides the row from UPDATE/DELETE (no row matched, no error): the append-only
    // guard trigger of db/05 only matters for a role RLS would not stop, such as a superuser
    expect(result.updated.ok && result.updated.rows).toEqual([]);
    expect(result.deleted.ok && result.deleted.rows).toEqual([]);
    expect(result.updatedBySystem.ok && result.updatedBySystem.rows).toEqual([]);
  });

  it('lets root and a signed-in admin read every version (the app shows admin only the current one, this table alone cannot tell "current" without asking itself and looping forever)', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const base = await currentVersion(db);
      await write(db, { setById: root.id, basedOnVersion: base });
      await write(db, { setById: root.id, basedOnVersion: base + 1 });

      const byRoot = await db.rows<{ version: number }>(
        'select version from cartlify.shop_settings where version > $1 order by version',
        base,
      );

      await db.as(as(admin));
      const byAdmin = await db.rows<{ version: number }>(
        'select version from cartlify.shop_settings where version > $1 order by version',
        base,
      );

      return { base, byRoot, byAdmin };
    });

    expect(result.byRoot.map((r) => r.version)).toEqual([result.base + 1, result.base + 2]);
    expect(result.byAdmin.map((r) => r.version)).toEqual([result.base + 1, result.base + 2]);
  });
});

describe('shop_settings values', () => {
  const insertWith = (db: DbSession, fields: string, values: unknown[]) =>
    db.attempt(
      `insert into cartlify.shop_settings
         ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById", ${fields})
       values ('{manual}', '{UA}', '{en}', 'en', $1, ${values.map((_, i) => `$${i + 2}`).join(', ')})`,
      root.id,
      ...values,
    );

  it('refuses a delivery method the app does not know, and a method named twice', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const unknown = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual,courier}', '{UA}', '{en}', 'en', $1)`,
        root.id,
      );
      const twice = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual,manual}', '{UA}', '{en}', 'en', $1)`,
        root.id,
      );
      return { unknown, twice };
    });

    expect(result.unknown).toMatchObject({ ok: false, code: '23514' });
    expect(result.twice).toMatchObject({ ok: false, code: '23514' });
  });

  it('requires the pickup address and hours once pickup is on, and a price above zero', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const noAddress = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById", "pickupHours")
         values ('{pickup}', '{UA}', '{en}', 'en', $1, 'Mon-Fri 9-18')`,
        root.id,
      );
      const withBoth = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById", "pickupAddress", "pickupHours")
         values ('{pickup}', '{UA}', '{en}', 'en', $1, 'Main St 1', 'Mon-Fri 9-18')`,
        root.id,
      );
      const zeroPrice = await insertWith(db, '"deliveryFlatPrice"', [0]);
      return { noAddress, withBoth, zeroPrice };
    });

    expect(result.noAddress).toMatchObject({ ok: false, code: '23514' });
    expect(result.withBoth.ok).toBe(true);
    expect(result.zeroPrice).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses a country that is not two capital letters, and one named twice', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const lower = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual}', '{ua}', '{en}', 'en', $1)`,
        root.id,
      );
      const twice = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual}', '{UA,UA}', '{en}', 'en', $1)`,
        root.id,
      );
      return { lower, twice };
    });

    expect(result.lower).toMatchObject({ ok: false, code: '23514' });
    expect(result.twice).toMatchObject({ ok: false, code: '23514' });
  });

  it('keeps reservation minutes above zero, the stripe page at least 30, together at most 1440', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const shortPage = await insertWith(db, '"reservationMinutes", "stripePageMinutes"', [15, 20]);
      const tooLong = await insertWith(db, '"reservationMinutes", "stripePageMinutes"', [800, 700]);
      const ok = await insertWith(db, '"reservationMinutes", "stripePageMinutes"', [15, 30]);
      return { shortPage, tooLong, ok };
    });

    expect(result.shortPage).toMatchObject({ ok: false, code: '23514' });
    expect(result.tooLong).toMatchObject({ ok: false, code: '23514' });
    expect(result.ok.ok).toBe(true);
  });

  it('keeps the days of grace of a withdrawal from 0 to 30', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const tooMany = await insertWith(db, '"withdrawalGraceDays"', [31]);
      const ok = await insertWith(db, '"withdrawalGraceDays"', [30]);
      return { tooMany, ok };
    });

    expect(result.tooMany).toMatchObject({ ok: false, code: '23514' });
    expect(result.ok.ok).toBe(true);
  });

  it('refuses a language not of two lower-case letters, named twice, or not among the enabled', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const upper = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual}', '{UA}', '{EN}', 'en', $1)`,
        root.id,
      );
      const twice = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual}', '{UA}', '{en,en}', 'en', $1)`,
        root.id,
      );
      const notEnabled = await db.attempt(
        `insert into cartlify.shop_settings
           ("deliveryMethods", "deliveryCountries", "enabledLocales", "shopLocale", "setById")
         values ('{manual}', '{UA}', '{uk}', 'en', $1)`,
        root.id,
      );
      return { upper, twice, notEnabled };
    });

    expect(result.upper).toMatchObject({ ok: false, code: '23514' });
    expect(result.twice).toMatchObject({ ok: false, code: '23514' });
    expect(result.notEnabled).toMatchObject({ ok: false, code: '23514' });
  });
});

describe('users.locale', () => {
  it('keeps a language to two lower-case letters, or empty', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      const bad = await db.attempt(
        `update cartlify.users set locale = $1 where id = $2`,
        'EN-us',
        admin.id,
      );
      const cleared = await db.attempt(
        `update cartlify.users set locale = $1 where id = $2`,
        null,
        admin.id,
      );
      return { bad, cleared };
    });

    expect(result.bad).toMatchObject({ ok: false, code: '23514' });
    expect(result.cleared.ok).toBe(true);
  });
});
