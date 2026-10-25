import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

import type { Role } from 'types/user.js';

// the role an account has now, null for an account that is gone or deleted: an access token
// names the role it had at the login until it runs out, root may have changed it since
export async function readActorRole(userId: number): Promise<Role | null> {
  const user = await prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    return tx.user.findUnique({ where: { id: userId }, select: { role: true, deletedAt: true } });
  });

  return user && !user.deletedAt ? (user.role as Role) : null;
}
