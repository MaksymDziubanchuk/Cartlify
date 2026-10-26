import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { cartOf, changedRows } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the terms and the contract of the shop (legal_documents) and the consents to them
// (legal_acceptances). Root publishes a version; the database numbers the versions of each kind
// and keeps the sha256 of the text; nobody changes or takes away a version, everybody reads them.
// A customer keeps a consent of their own to a version in force, with an order of their own or
// none; the address and the browser come from the context of the request, not from the row; the
// customer reads their own, an admin every one; nobody changes or takes away a consent. All in
// transactions that roll back: no other file sees a version made here

let buyer: TestUser;
let other: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  buyer = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, other.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Published = { id: number; version: number; sha256: string };

const publish = (
  db: DbSession,
  kind: 'terms' | 'contract',
  opts: { title?: string; content?: string; publishedById?: number } = {},
) =>
  db.attempt<Published>(
    `insert into cartlify.legal_documents (kind, title, content, "publishedById")
     values ($1::cartlify."LegalDocumentKind", $2, $3, $4)
     returning id, version, sha256`,
    kind,
    opts.title ?? `Terms ${kind}`,
    opts.content ?? `The text of the ${kind}.`,
    opts.publishedById ?? root.id,
  );

async function published(db: DbSession, kind: 'terms' | 'contract', content?: string) {
  await db.as(as(root));
  const outcome = await publish(db, kind, content ? { content } : {});
  if (!outcome.ok) throw new Error(`publishing failed: ${outcome.message}`);
  return outcome.rows[0]!;
}

const lastVersionOf = async (db: DbSession, kind: 'terms' | 'contract') =>
  (
    await db.rows<{ version: number | null }>(
      `select max(version) as version from cartlify.legal_documents
       where kind = $1::cartlify."LegalDocumentKind"`,
      kind,
    )
  )[0]!.version ?? 0;

const accept = (
  db: DbSession,
  userId: number,
  documentId: number,
  opts: { orderId?: number; ip?: string } = {},
) =>
  db.attempt<{ ip: string | null; userAgent: string | null }>(
    `insert into cartlify.legal_acceptances ("userId", "documentId", "orderId", ip, "userAgent")
     values ($1, $2, $3, $4, 'typed by the row')
     returning ip, "userAgent"`,
    userId,
    documentId,
    opts.orderId ?? null,
    opts.ip ?? null,
  );

const requestOf = (db: DbSession, ip: string, userAgent: string) =>
  db.rows(
    `select set_config('cartlify.request_ip', $1, true), set_config('cartlify.request_user_agent', $2, true)`,
    ip,
    userAgent,
  );

describe('legal_documents', () => {
  it('numbers the versions of each kind and keeps the sha256 of the text', async () => {
    const { before, first, second, contract, contractBefore } = await inRolledBackTx(async (db) => {
      const before = await lastVersionOf(db, 'terms');
      const contractBefore = await lastVersionOf(db, 'contract');
      const first = await published(db, 'terms', 'First words.');
      const second = await published(db, 'terms', 'Second words.');
      const contract = await published(db, 'contract');
      return { before, first, second, contract, contractBefore };
    });

    expect(first.version).toBe(before + 1);
    expect(second.version).toBe(before + 2);
    expect(contract.version).toBe(contractBefore + 1);
    expect(first.sha256).toBe(sha256('First words.'));
    expect(second.sha256).toBe(sha256('Second words.'));
  });

  it('takes the number and the sha256 from the database, not from the row', async () => {
    const row = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const before = await lastVersionOf(db, 'terms');
      const [made] = await db.rows<{ version: number; sha256: string }>(
        `insert into cartlify.legal_documents (kind, title, content, "publishedById", version, sha256)
         values ('terms'::cartlify."LegalDocumentKind", 'Terms', 'Words.', $1, 999, $2)
         returning version, sha256`,
        root.id,
        'f'.repeat(64),
      );
      return { before, made: made! };
    });

    expect(row.made.version).toBe(row.before + 1);
    expect(row.made.sha256).toBe(sha256('Words.'));
  });

  it.each([
    ['an admin', () => admin],
    ['a user', () => buyer],
  ])('does not let %s publish a version', async (_case, who) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(who()));
      return publish(db, 'terms', { publishedById: who().id });
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let root publish in the name of another account', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      return publish(db, 'terms', { publishedById: admin.id });
    });

    expect(outcome.ok).toBe(false);
  });

  it.each([
    ['an empty title', { title: '' }],
    ['a title with spaces at its edges', { title: ' Terms ' }],
    ['an empty text', { content: '' }],
    ['a text past 200 000 characters', { content: 'w'.repeat(200_001) }],
  ])('refuses %s', async (_case, opts) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      return publish(db, 'terms', opts);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  // the column itself is 200 characters long
  it('refuses a title past 200 characters', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      return publish(db, 'terms', { title: 'T'.repeat(201) });
    });

    expect(outcome).toMatchObject({ ok: false, code: '22001' });
  });

  it('lets nobody change or take away a version, root neither', async () => {
    const { changed, removed } = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(root));
      const changed = await db.attempt(
        `update cartlify.legal_documents set title = 'Other' where id = $1 returning id`,
        doc.id,
      );
      const removed = await db.attempt(
        'delete from cartlify.legal_documents where id = $1 returning id',
        doc.id,
      );
      return { changed, removed };
    });

    expect(changedRows(changed)).toBe(false);
    expect(changedRows(removed)).toBe(false);
  });

  it('lets a guest read the versions', async () => {
    const seen = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'contract');
      await db.as({ role: 'GUEST', guestId: null });
      return db.rows<{ id: number }>(
        'select id from cartlify.legal_documents where id = $1',
        doc.id,
      );
    });

    expect(seen).toHaveLength(1);
  });
});

describe('legal_acceptances', () => {
  it('keeps the consent of a customer with the address and the browser of the request', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(buyer));
      await requestOf(db, '203.0.113.7', 'Live browser');
      const outcome = await accept(db, buyer.id, doc.id, { ip: '198.51.100.1' });
      if (!outcome.ok) throw new Error(outcome.message ?? 'refused');
      return outcome.rows;
    });

    expect(rows).toEqual([{ ip: '203.0.113.7', userAgent: 'Live browser' }]);
  });

  it('keeps no address the request did not have', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(buyer));
      const outcome = await accept(db, buyer.id, doc.id, { ip: '198.51.100.1' });
      if (!outcome.ok) throw new Error(outcome.message ?? 'refused');
      return outcome.rows;
    });

    expect(rows).toEqual([{ ip: null, userAgent: null }]);
  });

  it('refuses a consent to a version that is no longer in force', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const old = await published(db, 'terms');
      await published(db, 'terms');
      await db.as(as(buyer));
      return accept(db, buyer.id, old.id);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'LEGAL_DOCUMENT_NOT_CURRENT' });
  });

  it('keeps a consent with an order of the customer, not with one of another', async () => {
    const { own, foreign } = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'contract');
      const ownOrder = await cartOf(db, buyer.id, []);
      const otherOrder = await cartOf(db, other.id, []);
      await db.as(as(buyer));
      return {
        own: await accept(db, buyer.id, doc.id, { orderId: ownOrder }),
        foreign: await accept(db, buyer.id, doc.id, { orderId: otherOrder }),
      };
    });

    expect(own.ok).toBe(true);
    expect(foreign.ok).toBe(false);
  });

  it('does not let a customer give a consent for another', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(buyer));
      return accept(db, other.id, doc.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let an admin give a consent', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(admin));
      return accept(db, admin.id, doc.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('shows a customer their own consents and an admin every one', async () => {
    const { ofBuyer, ofAdmin } = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(buyer));
      await accept(db, buyer.id, doc.id);
      await db.as(as(other));
      await accept(db, other.id, doc.id);

      const seen = () =>
        db.rows<{ userId: number }>(
          `select "userId" from cartlify.legal_acceptances
           where "documentId" = $1 order by "userId"`,
          doc.id,
        );
      await db.as(as(buyer));
      const ofBuyer = await seen();
      await db.as(as(admin));
      return { ofBuyer, ofAdmin: await seen() };
    });

    expect(ofBuyer.map((row) => row.userId)).toEqual([buyer.id]);
    expect(ofAdmin.map((row) => row.userId)).toEqual([buyer.id, other.id].sort((a, b) => a - b));
  });

  it('lets nobody change or take away a consent', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const doc = await published(db, 'terms');
      await db.as(as(buyer));
      await accept(db, buyer.id, doc.id);

      const results = [];
      for (const who of [buyer, admin, root]) {
        await db.as(as(who));
        results.push(
          await db.attempt(
            `update cartlify.legal_acceptances set ip = '1.1.1.1' where "userId" = $1 returning id`,
            buyer.id,
          ),
          await db.attempt(
            'delete from cartlify.legal_acceptances where "userId" = $1 returning id',
            buyer.id,
          ),
        );
      }
      return results;
    });

    expect(outcomes.some(changedRows)).toBe(false);
  });
});
