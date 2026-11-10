import { setUserContext } from '@db/dbContext.service.js';

import { asAdmin, testTx } from './db.js';

// root allows an admin to run the newsletters the way the database lets it be done, by its function
// (the route of root does the same, and a test of another route that needs an admin with the right
// does not depend on that route). The right is a column no statement changes
export async function giveNewsletterRight(rootId: number, adminId: number): Promise<void> {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: rootId, role: 'ROOT' });
    await tx.$executeRaw`select cartlify.newsletter_set_manager(${adminId}::int, true)`;
  });
}

// root takes the right away, the way the database lets it be done
export async function takeNewsletterRight(rootId: number, adminId: number): Promise<void> {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: rootId, role: 'ROOT' });
    await tx.$executeRaw`select cartlify.newsletter_set_manager(${adminId}::int, false)`;
  });
}

// the right as the column keeps it
export const newsletterRightOf = (userId: number) =>
  asAdmin(async (tx) => {
    const row = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { canManageNewsletters: true },
    });
    return row.canManageNewsletters;
  });

// the lines of the admin log about one account, as action and event in the order they were written
export const managerLinesOf = (userId: number) =>
  asAdmin(async (tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'user', entityId: userId, action: 'NEWSLETTER_MANAGER_CHANGE' },
      orderBy: { id: 'asc' },
      select: {
        actorId: true,
        actorRole: true,
        entityType: true,
        entityId: true,
        action: true,
        event: true,
        meta: true,
      },
    }),
  );
