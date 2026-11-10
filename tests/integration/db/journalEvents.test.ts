import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import {
  AUDIT_EVENTS,
  CONSENT_EVENTS,
  LEGACY_EVENT,
  LOGIN_EVENTS,
  PRICE_LOG_EVENTS,
} from '@config/journalEvents.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';

// every line of the four journals (admin_audit_log, product_price_change_logs, login_logs,
// legal_acceptances) names the event that made it, written domain.name in lower case. The list of
// the events the app writes is src/config/journalEvents.ts; the database holds the shape only
// (db/06), and a line without an event is no line

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let productId: number;
let variantId: number;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  const product = await createProduct({ price: 10 });
  productId = product.id;
  variantId = product.variantId;
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asBuyer = (): Actor => ({ role: 'USER', userId: buyer.id });

// the forms an event may not have
const BAD_EVENTS = [
  'Product.Update',
  'product',
  'product.',
  '.update',
  'product.update.batch',
  'product update',
  'product-update.x',
  '1product.update',
  '',
];

const auditLine = (db: DbSession, event: string | null) =>
  db.attempt(
    `select 1 as done from cartlify.log_admin_action(
       $1::int, 'ADMIN'::cartlify."Role", 'product'::cartlify."AdminAuditEntityType", $2::int,
       'PRODUCT_UPDATE'::cartlify."AdminAuditAction", $3, '[]'::jsonb)`,
    admin.id,
    productId,
    event,
  );

const priceLine = (db: DbSession, event: string | null) =>
  db.attempt(
    `select 1 as done from cartlify.log_variant_price_change(
       $1::int, 10, 12, 'fixed'::cartlify."PriceChangeMode", 2, $2)`,
    variantId,
    event,
  );

const loginLine = (db: DbSession, event: string | null) =>
  db.attempt(
    `insert into cartlify.login_logs ("userId", email, role, event)
     values ($1, $2, 'USER', $3) returning event`,
    buyer.id,
    buyer.email,
    event,
  );

describe('the events of the admin log', () => {
  it('keeps the event of a line, next to its action', async () => {
    const line = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const written = await auditLine(db, 'product.update_batch');
      expect(written.ok).toBe(true);
      const [row] = await db.rows<{ action: string; event: string }>(
        `select action::text as action, event from cartlify.admin_audit_log
         where "entityId" = $1 and "actorId" = $2 and action = 'PRODUCT_UPDATE' order by id desc limit 1`,
        productId,
        admin.id,
      );
      return row;
    });

    expect(line).toEqual({ action: 'PRODUCT_UPDATE', event: 'product.update_batch' });
  });

  it.each(AUDIT_EVENTS)('takes the event %s', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return auditLine(db, event);
    });

    expect(outcome.ok).toBe(true);
  });

  // the kinds of thing and the actions of the newsletters (root's mark of an admin, a newsletter, a
  // subscriber, an address blocked for the form) are values of the two enums of the log
  it.each([
    ['user', 'NEWSLETTER_MANAGER_CHANGE', 'newsletter.manager_granted'],
    ['newsletter_campaign', 'NEWSLETTER_CAMPAIGN_CHANGE', 'newsletter.campaign_created'],
    ['newsletter_subscriber', 'NEWSLETTER_SUBSCRIBER_DELETE', 'newsletter.subscriber_erased'],
    ['newsletter_block', 'NEWSLETTER_BLOCK_CHANGE', 'newsletter.block_added'],
  ])('keeps a line about %s with the action %s', async (entityType, action, event) => {
    const line = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const written = await db.attempt(
        `select 1 as done from cartlify.log_admin_action(
           $1::int, 'ADMIN'::cartlify."Role", $2::cartlify."AdminAuditEntityType", 77,
           $3::cartlify."AdminAuditAction", $4, '[]'::jsonb)`,
        admin.id,
        entityType,
        action,
        event,
      );
      expect(written.ok).toBe(true);
      const [row] = await db.rows<{ entityType: string; action: string; event: string }>(
        `select "entityType"::text as "entityType", action::text as action, event
         from cartlify.admin_audit_log where "actorId" = $1 and "entityId" = 77
         order by id desc limit 1`,
        admin.id,
      );
      return row;
    });

    expect(line).toEqual({ entityType, action, event });
  });

  it.each([...BAD_EVENTS, null])('refuses the event %p', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return auditLine(db, event);
    });

    expect(outcome.ok).toBe(false);
  });

  it('writes the lines the database writes itself with their events', async () => {
    // the line of a sale that a price ended is written by the trigger of the variants
    const events = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      await db.rows(
        `update cartlify.product_variants set "salePrice" = 5, "saleEndsAt" = (now() at time zone 'UTC') + interval '1 day'
         where id = $1 returning id`,
        variantId,
      );
      await db.rows(
        `update cartlify.product_variants set price = 4 where id = $1 returning id`,
        variantId,
      );
      return db.rows<{ event: string }>(
        `select event from cartlify.admin_audit_log
         where "entityType" = 'variant' and "entityId" = $1 and action = 'PRODUCT_SALE'
         order by id desc limit 1`,
        variantId,
      );
    });

    expect(events).toEqual([{ event: 'product.sale_end_by_price' }]);
  });
});

describe('the events of the log of prices', () => {
  it('keeps the event of a line', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      await priceLine(db, 'price.bulk');
      return db.rows<{ event: string }>(
        `select event from cartlify.product_price_change_logs
         where "variantId" = $1 order by id desc limit 1`,
        variantId,
      );
    });

    expect(rows).toEqual([{ event: 'price.bulk' }]);
  });

  it.each(PRICE_LOG_EVENTS)('takes the event %s', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return priceLine(db, event);
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([...BAD_EVENTS, null])('refuses the event %p', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return priceLine(db, event);
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('the events of the log of logins', () => {
  it('keeps how the person came in', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asBuyer());
      return loginLine(db, 'login.google');
    });

    expect(outcome).toMatchObject({ ok: true, rows: [{ event: 'login.google' }] });
  });

  it.each(LOGIN_EVENTS)('takes the event %s', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asBuyer());
      return loginLine(db, event);
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([...BAD_EVENTS, null])('refuses the event %p', async (event) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asBuyer());
      return loginLine(db, event);
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('the events of the log of consents', () => {
  // a version in force is made in the transaction that rolls back: no other file sees it
  const consent = (db: DbSession, event: string | null) =>
    db.attempt(
      `insert into cartlify.legal_acceptances ("userId", "documentId", event)
       select $1, d.id, $2 from cartlify.legal_documents as d
       where d.kind = 'terms'::cartlify."LegalDocumentKind"
       order by d.version desc limit 1
       returning event`,
      buyer.id,
      event,
    );

  async function withTerms<T>(run: (db: DbSession) => Promise<T>): Promise<T> {
    return inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT', userId: root.id });
      await db.rows(
        `insert into cartlify.legal_documents (kind, title, content, "publishedById")
         values ('terms'::cartlify."LegalDocumentKind", 'Terms', 'The words.', $1) returning id`,
        root.id,
      );
      await db.as(asBuyer());
      return run(db);
    });
  }

  it('keeps where the person agreed', async () => {
    const outcome = await withTerms((db) => consent(db, 'consent.order'));

    expect(outcome).toMatchObject({ ok: true, rows: [{ event: 'consent.order' }] });
  });

  it.each(CONSENT_EVENTS)('takes the event %s', async (event) => {
    const outcome = await withTerms((db) => consent(db, event));

    expect(outcome.ok).toBe(true);
  });

  it.each([...BAD_EVENTS, null])('refuses the event %p', async (event) => {
    const outcome = await withTerms((db) => consent(db, event));

    expect(outcome.ok).toBe(false);
  });
});

describe('the list of the events', () => {
  it('has the event of the lines from before the events in every journal', () => {
    for (const list of [AUDIT_EVENTS, PRICE_LOG_EVENTS, LOGIN_EVENTS, CONSENT_EVENTS]) {
      expect(list).toContain(LEGACY_EVENT);
    }
  });

  it('names each event once, in the form the database takes', () => {
    for (const list of [AUDIT_EVENTS, PRICE_LOG_EVENTS, LOGIN_EVENTS, CONSENT_EVENTS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const event of list) expect(event).toMatch(/^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$/);
    }
  });
});
