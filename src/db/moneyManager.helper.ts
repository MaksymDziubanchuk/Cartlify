import type { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import type { Role } from 'types/user.js';

// May this account handle the money the way root does? The answer is the function of the database
// (db/05), asked in the context of the account: root, or an admin whose account is not deleted and
// whom root allowed. It is read now, at every call, never from a token or a cache: a right root took
// away stops at once, in a session that is open too

// the answer in a transaction that has the context of the account already (a snapshot that reads more
// than this, the alerts)
export async function askMoneyManager(db: Prisma.TransactionClient): Promise<boolean> {
  const rows = await db.$queryRaw<{ allowed: boolean | null }[]>`
    select cartlify.money_manager() as allowed
  `;

  return rows[0]?.allowed === true;
}

export async function isMoneyManager(actor: { userId: number; role: Role }): Promise<boolean> {
  return tx(async (db) => {
    await setUserContext(db, actor);

    return askMoneyManager(db);
  });
}
