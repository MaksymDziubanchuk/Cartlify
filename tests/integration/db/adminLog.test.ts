import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the log of what admins do (admin_audit_log), written through cartlify.log_admin_action. A line
// names who did it: a signed-in admin writes lines in their own name and with their own role. The
// system (the admin context without an id) writes the lines of what nobody signed in did, such as
// the refund of a late payment, in the name of the buyer it concerns. Only admins read the log

let buyer: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let root: TestUser;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, otherAdmin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asSystem = (): Actor => ({ role: 'ADMIN' });

const logAction = (db: DbSession, actorId: number, actorRole: string, changes = '[]') =>
  db.attempt(
    `select 1 as done from cartlify.log_admin_action($1::int, $2::cartlify."Role", 'order', 1, 'OTHER', $3::jsonb)`,
    actorId,
    actorRole,
    changes,
  );

const lastLineOf = async (db: DbSession) => {
  await db.as({ role: 'ROOT', userId: root.id });
  const [row] = await db.rows<{ actorId: number; actorRole: string }>(
    `select "actorId", "actorRole"::text as "actorRole" from cartlify.admin_audit_log order by id desc limit 1`,
  );
  return row;
};

describe('cartlify.log_admin_action', () => {
  it('lets an admin write a line in their own name, and read the log', async () => {
    const { written, line } = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const written = await logAction(db, admin.id, 'ADMIN');
      return { written, line: await lastLineOf(db) };
    });

    expect(written.ok).toBe(true);
    expect(line).toEqual({ actorId: admin.id, actorRole: 'ADMIN' });
  });

  it('lets root write a line in their own name with the role of root', async () => {
    const { written, line } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT', userId: root.id });
      const written = await logAction(db, root.id, 'ROOT');
      return { written, line: await lastLineOf(db) };
    });

    expect(written.ok).toBe(true);
    expect(line).toEqual({ actorId: root.id, actorRole: 'ROOT' });
  });

  // a line of the log says who did it; the admin of the context is the one
  it.each([
    ['in the name of another admin', () => otherAdmin.id, 'ADMIN'],
    ['with a role they do not have', () => admin.id, 'ROOT'],
    ['in the name of a buyer', () => buyer.id, 'USER'],
  ])('does not let a signed-in admin write a line %s', async (_case, actorOf, role) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return logAction(db, actorOf(), role);
    });

    expect(outcome.ok).toBe(false);
  });

  it('lets the system write the line of a refund in the name of the buyer', async () => {
    const { written, line } = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      const written = await logAction(
        db,
        buyer.id,
        'USER',
        JSON.stringify([{ field: 'refund', old: null, new: { initiator: 'system' } }]),
      );
      return { written, line: await lastLineOf(db) };
    });

    expect(written.ok).toBe(true);
    expect(line).toEqual({ actorId: buyer.id, actorRole: 'USER' });
  });

  it('refuses changes that are no list of changes', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return logAction(db, admin.id, 'ADMIN', '{"field":"name"}');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('ADMIN_AUDIT_CHANGES_NOT_ARRAY'),
    });
  });

  it('lets a user neither write nor read the log', async () => {
    const { written, seen } = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      await logAction(db, admin.id, 'ADMIN');
      await db.as({ role: 'USER', userId: buyer.id });
      return {
        written: await logAction(db, buyer.id, 'USER'),
        seen: await db.rows('select id from cartlify.admin_audit_log limit 1'),
      };
    });

    expect(written.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
