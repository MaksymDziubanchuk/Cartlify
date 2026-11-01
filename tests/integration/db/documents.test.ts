import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the directory of the documents (instructions, certificates) and the documents of a product:
// everybody reads, only an admin or a root writes, a document changes its title and kind and
// nothing else, a product names a document once and a place once, and a document in use stays

let user: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ stock: 0 });
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

const insertDocument = (
  title: string,
  over: { url?: string; publicId?: string; sizeBytes?: number; kind?: string } = {},
) =>
  [
    `insert into cartlify.documents (title, kind, url, "publicId", "sizeBytes")
     values ($1, $2::cartlify."DocumentKind", $3, $4, $5) returning id`,
    title,
    over.kind ?? 'instruction',
    over.url ?? 'https://res.cloudinary.com/demo/image/upload/v1/test/documents/x.pdf',
    over.publicId ?? `test/documents/${randomUUID()}`,
    over.sizeBytes ?? 1234,
  ] as const;

const codeOf = (outcome: { ok: boolean; code?: string | null }) =>
  outcome.ok ? 'done' : (outcome.code ?? 'failed');

// a document of the transaction, made as an admin
async function aDocument(db: DbSession): Promise<number> {
  await db.as(asAdmin());
  const [row] = await db.rows<{ id: number }>(...insertDocument(`Manual ${uniqueTag()}`));
  return row!.id;
}

describe('documents', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s read them and the documents of a product', async (_who, actor) => {
    const seen = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      await db.rows(
        'insert into cartlify.product_documents ("productId", "documentId", position) values ($1, $2, 1)',
        product.id,
        id,
      );
      await db.as(actor());
      return {
        document: await db.rows('select id from cartlify.documents where id = $1', id),
        named: await db.rows(
          'select "documentId" from cartlify.product_documents where "documentId" = $1',
          id,
        ),
        id,
      };
    });

    expect(seen.document).toEqual([{ id: seen.id }]);
    expect(seen.named).toEqual([{ documentId: seen.id }]);
  });

  it.each([
    ['an admin', asAdmin],
    ['a root', asRoot],
  ])('let %s create, change the title and the kind of, and delete one', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actor());
      const created = await db.attempt<{ id: number }>(...insertDocument(`Manual ${uniqueTag()}`));
      const id = created.ok ? created.rows[0]!.id : 0;
      return [
        created,
        await db.attempt(
          `update cartlify.documents set title = 'Renamed', kind = 'certificate' where id = $1 returning id`,
          id,
        ),
        await db.attempt('delete from cartlify.documents where id = $1 returning id', id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s create, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      await db.as(actor());
      return [
        await db.attempt(...insertDocument(`Manual ${uniqueTag()}`)),
        await db.attempt(
          `update cartlify.documents set title = 'Renamed' where id = $1 returning id`,
          id,
        ),
        await db.attempt('delete from cartlify.documents where id = $1 returning id', id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });

  it('keeps the file, the id and the day of a document as they were made', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      const update = (set: string) =>
        db.attempt(`update cartlify.documents set ${set} where id = $1 returning id`, id);
      return [
        await update(`title = 'Another title', kind = 'declaration', "updatedAt" = now()`),
        await update(`url = 'https://res.cloudinary.com/demo/image/upload/v2/other.pdf'`),
        await update(`"publicId" = 'test/documents/other'`),
        await update(`"sizeBytes" = 99`),
        await update(`"createdAt" = now() - interval '1 year'`),
        await update('id = id + 1000000'),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', '42501', '42501', '42501', '42501', '42501']);
  });

  it('refuse values the API does not give: an empty, padded or long title, no file, no size', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const refused = [
        insertDocument(''),
        insertDocument(' Padded'),
        insertDocument('x'.repeat(201)),
        insertDocument('Manual', { url: '' }),
        insertDocument('Manual', { publicId: '' }),
        insertDocument('Manual', { sizeBytes: 0 }),
        insertDocument('Manual', { sizeBytes: -5 }),
      ];

      const results = [];
      for (const args of refused) results.push(await db.attempt(...args));
      return results;
    });

    expect(outcomes.map(codeOf)).toEqual(Array(7).fill('23514'));
  });

  it('take a title of up to 200 signs and refuse a kind that is not one', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return [
        await db.attempt(...insertDocument('x'.repeat(200))),
        await db.attempt(...insertDocument('Manual', { kind: 'brochure' })),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', '22P02']);
  });

  it('keep one row for one public id', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const publicId = `test/documents/${randomUUID()}`;
      return [
        await db.attempt(...insertDocument('First', { publicId })),
        await db.attempt(...insertDocument('Second', { publicId })),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', '23505']);
  });
});

describe('the documents of a product', () => {
  const name = (db: DbSession, documentId: number, position: number, productId = product.id) =>
    db.attempt(
      `insert into cartlify.product_documents ("productId", "documentId", position)
       values ($1, $2, $3) returning "documentId"`,
      productId,
      documentId,
      position,
    );

  it('let an admin name documents in a place of their own and delete the rows', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const first = await aDocument(db);
      const second = await aDocument(db);
      return [
        await name(db, first, 1),
        await name(db, second, 2),
        await db.attempt(
          'delete from cartlify.product_documents where "productId" = $1 returning "productId"',
          product.id,
        ),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', 'done']);
  });

  it('let a user name none and delete none', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      await name(db, id, 1);
      await db.as(asUser());
      return [
        await name(db, id, 2),
        await db.attempt(
          'delete from cartlify.product_documents where "documentId" = $1 returning "documentId"',
          id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false]);
  });

  it('never change a row: there is no policy to update one', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      await name(db, id, 1);
      return db.attempt(
        'update cartlify.product_documents set position = 5 where "documentId" = $1 returning position',
        id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('refuse a place under 1, a place twice, and a document twice in one product', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const first = await aDocument(db);
      const second = await aDocument(db);
      return [
        await name(db, first, 0),
        await name(db, first, 1),
        await name(db, second, 1),
        await name(db, first, 2),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['23514', 'done', '23505', '23505']);
  });

  it('let two products name one document in the same place', async () => {
    const other = await createProduct({ stock: 0 });

    const outcomes = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      return [await name(db, id, 1), await name(db, id, 1, other.id)];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done']);
  });

  it('keep a document a product names: it cannot be deleted', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await aDocument(db);
      await name(db, id, 1);
      return db.attempt('delete from cartlify.documents where id = $1 returning id', id);
    });

    expect(codeOf(outcome)).toBe('23503');
  });
});
