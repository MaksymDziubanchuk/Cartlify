import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createParty,
  createProduct,
  createUser,
  defaultPartyId,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the directory of the parties a product names, the manufacturer and the person responsible in the
// EU: everybody reads it, only an admin or a root writes it, the values are held by the database,
// and a party a product names cannot be deleted

let user: TestUser;
let admin: TestUser;
let root: TestUser;
let partyId: number;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  partyId = (await createParty()).id;
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

const insertParty = (
  name: string,
  address = '1 Test Street, 28001 Madrid',
  email = 'maker@shop.example.com',
  country = 'ES',
) =>
  [
    'insert into cartlify.parties (name, address, email, country) values ($1, $2, $3, $4) returning id',
    name,
    address,
    email,
    country,
  ] as const;

describe('parties', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s read them', async (_who, actor) => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return db.rows('select id from cartlify.parties where id = $1', partyId);
    });

    expect(seen).toEqual([{ id: partyId }]);
  });

  it.each([
    ['an admin', asAdmin],
    ['a root', asRoot],
  ])('let %s create, change and delete one', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actor());
      const created = await db.attempt<{ id: number }>(...insertParty(`Maker ${uniqueTag()}`));
      const id = created.ok ? created.rows[0]!.id : 0;
      return [
        created,
        await db.attempt(
          `update cartlify.parties set address = '2 New Street, Madrid' where id = $1 returning id`,
          id,
        ),
        await db.attempt('delete from cartlify.parties where id = $1 returning id', id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s create, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return [
        await db.attempt(...insertParty(`Maker ${uniqueTag()}`)),
        await db.attempt(
          `update cartlify.parties set name = 'Renamed' where id = $1 returning id`,
          partyId,
        ),
        await db.attempt('delete from cartlify.parties where id = $1 returning id', partyId),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });

  it('refuse a party an admin made with a value the API does not give', async () => {
    const long = (n: number) => 'x'.repeat(n);

    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const tag = uniqueTag();
      const refused = [
        // an empty name, a name with a space at its end, one too long
        insertParty(''),
        insertParty(` Maker ${tag}`),
        insertParty(long(201)),
        // an address that is empty, padded or too long
        insertParty(`Maker ${tag}`, ''),
        insertParty(`Maker ${tag}`, ' 1 Street'),
        insertParty(`Maker ${tag}`, long(501)),
        // an email without an at sign, without a dot after it, with a space, too long
        insertParty(`Maker ${tag}`, '1 Street', 'maker.example.com'),
        insertParty(`Maker ${tag}`, '1 Street', 'maker@example'),
        insertParty(`Maker ${tag}`, '1 Street', 'ma ker@example.com'),
        insertParty(`Maker ${tag}`, '1 Street', `${long(250)}@a.co`),
        // a country in small letters, of one letter, of three
        insertParty(`Maker ${tag}`, '1 Street', 'maker@example.com', 'es'),
        insertParty(`Maker ${tag}`, '1 Street', 'maker@example.com', 'E'),
        insertParty(`Maker ${tag}`, '1 Street', 'maker@example.com', 'ESP'),
      ];

      const results = [];
      for (const args of refused) results.push(await db.attempt(...args));
      return results;
    });

    expect(outcomes.map((outcome) => (outcome.ok ? 'created' : outcome.code))).toEqual(
      Array(13).fill('23514'),
    );
  });

  it('take the longest values the API gives', async () => {
    const long = (n: number) => 'x'.repeat(n);

    const created = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(
        ...insertParty(long(200), long(500), `${long(240)}@example.com`.slice(0, 254), 'PT'),
      );
    });

    expect(created.ok).toBe(true);
  });

  it('keep one row for one name, address and country, letter case ignored', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const tag = uniqueTag();
      return [
        await db.attempt(...insertParty(`Maker ${tag}`, '1 Street', 'a@example.com', 'ES')),
        // the same, in capitals: the same party
        await db.attempt(...insertParty(`MAKER ${tag}`, '1 STREET', 'b@example.com', 'ES')),
        // the same name and address in another country is another party
        await db.attempt(...insertParty(`Maker ${tag}`, '1 Street', 'a@example.com', 'FR')),
      ];
    });

    expect(outcomes.map((outcome) => (outcome.ok ? 'created' : outcome.code))).toEqual([
      'created',
      '23505',
      'created',
    ]);
  });

  it('let an admin change the four values of a party and nothing else of it', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const [made] = await db.rows<{ id: number }>(...insertParty(`Maker ${uniqueTag()}`));
      const id = made!.id;
      const update = (set: string) =>
        db.attempt(`update cartlify.parties set ${set} where id = $1 returning id`, id);
      return [
        await update(
          `name = 'Renamed ' || id, address = 'New Street', email = 'new@x.example.com'`,
        ),
        await update(`country = 'FR', "updatedAt" = now()`),
        await update(`id = id + 1000000`),
        await update(`"createdAt" = now() - interval '1 year'`),
      ];
    });

    expect(outcomes.map((outcome) => (outcome.ok ? 'changed' : outcome.code))).toEqual([
      'changed',
      'changed',
      '42501',
      '42501',
    ]);
  });

  it('refuse to delete a party a product names as its manufacturer or its person in the EU', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const tag = uniqueTag();
      const [category] = await db.rows<{ id: number }>(
        'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
        `Db category ${tag}`,
        `db-category-${tag}`,
      );
      const [maker] = await db.rows<{ id: number }>(...insertParty(`Maker ${tag}`));
      const [person] = await db.rows<{ id: number }>(
        ...insertParty(`Person ${tag}`, '3 Street', 'person@example.com', 'FR'),
      );
      await db.rows(
        `insert into cartlify.products (name, "categoryId", "manufacturerId", "euResponsibleId")
         values ($1, $2, $3, $4)`,
        `Db product ${tag}`,
        category!.id,
        maker!.id,
        person!.id,
      );

      return [
        await db.attempt('delete from cartlify.parties where id = $1 returning id', maker!.id),
        await db.attempt('delete from cartlify.parties where id = $1 returning id', person!.id),
      ];
    });

    expect(outcomes.map((outcome) => (outcome.ok ? 'deleted' : outcome.code))).toEqual([
      '23503',
      '23503',
    ]);
  });
});

describe('the manufacturer and the warnings of a product', () => {
  let categoryId: number;

  beforeAll(async () => {
    categoryId = (await createProduct({ stock: 0 })).categoryId;
  });

  const insertProduct = (manufacturer: number | null, warnings: string | null) =>
    [
      `insert into cartlify.products (name, "categoryId", "manufacturerId", warnings)
       values ($1, $2, $3, $4) returning id`,
      `Db product ${uniqueTag()}`,
      categoryId,
      manufacturer,
      warnings,
    ] as const;

  it('need a manufacturer', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(...insertProduct(null, null));
    });

    expect(outcome).toMatchObject({ ok: false, code: '23502' });
  });

  it('refuse a manufacturer that is not in the directory', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(...insertProduct(2_000_000_000, null));
    });

    expect(outcome).toMatchObject({ ok: false, code: '23503' });
  });

  it('take no warnings and warnings of up to 2000 signs', async () => {
    const maker = await defaultPartyId();

    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return [
        await db.attempt(...insertProduct(maker, null)),
        await db.attempt(...insertProduct(maker, 'Keep away from fire')),
        await db.attempt(...insertProduct(maker, 'x'.repeat(2000))),
      ];
    });

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
  });

  it('refuse warnings that are empty, padded or longer than 2000 signs', async () => {
    const maker = await defaultPartyId();

    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return [
        await db.attempt(...insertProduct(maker, '')),
        await db.attempt(...insertProduct(maker, ' Keep away from fire')),
        await db.attempt(...insertProduct(maker, 'x'.repeat(2001))),
      ];
    });

    expect(outcomes.map((outcome) => (outcome.ok ? 'created' : outcome.code))).toEqual([
      '23514',
      '23514',
      '23514',
    ]);
  });
});
