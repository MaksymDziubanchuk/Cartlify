import { Prisma } from '@prisma/client';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

type Tx = Prisma.TransactionClient;

export async function insertLoginLog(
  tx: Tx,
  args: {
    userId: UserId;
    email: string;
    role: Role;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  const { userId, email, role, ip, userAgent } = args;

  // write login log row
  await tx.$executeRaw`
    insert into cartlify.login_logs ("userId", "email", "role", "ipAddress", "userAgent")
    values (
      ${userId}::int,
      ${email},
      ${role}::cartlify."Role",
      ${ip ?? null},
      ${userAgent ?? null}
    )
  `;
}
