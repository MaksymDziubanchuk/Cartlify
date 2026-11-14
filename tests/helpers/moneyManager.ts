import { setUserContext } from '@db/dbContext.service.js';

import { asAdmin, testTx } from './db.js';

// root allows an admin to handle the money the way the database lets it be done, by its function
// (the route of root does the same, and a test of another route that needs an admin with the right
// does not depend on that route). The right is a column no statement changes
export async function giveMoneyRight(rootId: number, adminId: number): Promise<void> {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: rootId, role: 'ROOT' });
    await tx.$executeRaw`select cartlify.money_set_manager(${adminId}::int, true)`;
  });
}

// root takes the right away, the way the database lets it be done
export async function takeMoneyRight(rootId: number, adminId: number): Promise<void> {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: rootId, role: 'ROOT' });
    await tx.$executeRaw`select cartlify.money_set_manager(${adminId}::int, false)`;
  });
}

// the right as the column keeps it
export const moneyRightOf = (userId: number) =>
  asAdmin(async (tx) => {
    const row = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { canManageMoney: true },
    });
    return row.canManageMoney;
  });

// the lines of the admin log about the right of the money of one account, in the order written
export const moneyManagerLinesOf = (userId: number) =>
  asAdmin(async (tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'user', entityId: userId, action: 'MONEY_MANAGER_CHANGE' },
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
