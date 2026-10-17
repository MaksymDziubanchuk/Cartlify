import type { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

// test data the app itself would not let a test make: users, products and tokens are
// admin-only under rls, so a test creates and inspects its own rows as admin
export const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await setAdminContext(tx);
    return fn(tx);
  });
