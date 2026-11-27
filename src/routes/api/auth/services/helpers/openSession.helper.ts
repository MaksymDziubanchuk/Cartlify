import type { Prisma, Role } from '@prisma/client';

import type { LoginEvent, WrittenEvent } from '@config/journalEvents.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { canManageMoneyOf } from '@helpers/moneyManager.js';
import { canManageNewslettersOf } from '@helpers/newsletterManager.js';
import { takeConsentAtLogin } from '@routes/api/legal/services/helpers/legalDocuments.helper.js';
import { avatarOf } from '@utils/avatar.util.js';
import { InternalError } from '@utils/errors.js';
import type { LoginResponseDto } from 'types/dto/auth.dto.js';
import type { UserId } from 'types/ids.js';

import { migrateGuestDataToUser } from './guestMigration.helper.js';
import { insertLoginLog } from './loginLogs.helper.js';
import { issueTokensOnLogin } from './tokenRotation.helper.js';

export type OpenedSession = { result: LoginResponseDto; accessToken: string; refreshToken: string };

// The end of every login once each step it asks for passed (the password, a provider, the code of an
// admin or root): the data of the guest of this browser go to the account, a customer accepts the
// versions that came in force, the login journal gets its line, and a new session opens. The
// transaction runs as the account from here on.
export async function openSession(
  tx: Prisma.TransactionClient,
  args: {
    userId: number;
    role: Role;
    guestId: UserId;
    rememberMe: boolean;
    event: WrittenEvent<LoginEvent>;
    ip?: string | undefined;
    userAgent?: string | undefined;
    acceptedDocumentIds?: number[];
  },
): Promise<OpenedSession> {
  const { userId, role } = args;

  await migrateGuestDataToUser(tx, args.guestId, { id: userId as UserId, role });

  // a customer accepts the versions in force that came since the last consent before the login
  // goes on (LEGAL_ACCEPTANCE_REQUIRED names them); an admin or root buys nothing
  if (role === 'USER') await takeConsentAtLogin(tx, userId, args.acceptedDocumentIds ?? []);

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      isVerified: true,
      createdAt: true,
      updatedAt: true,
      name: true,
      avatarUrl: true,
      locale: true,
      phone: true,
      canManageNewsletters: true,
      canManageMoney: true,
      deletedAt: true,
    },
  });
  if (!user) throw new InternalError({ reason: 'USER_NOT_FOUND_AFTER_LOGIN' });

  assertEmail(user.email);

  await insertLoginLog(tx, {
    userId: userId as UserId,
    email: user.email,
    role,
    event: args.event,
    ...(args.ip !== undefined ? { ip: args.ip } : {}),
    ...(args.userAgent !== undefined ? { userAgent: args.userAgent } : {}),
  });

  const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
    userId,
    role,
    rememberMe: args.rememberMe,
    ...(args.userAgent !== undefined ? { userAgent: args.userAgent } : {}),
  });

  const result: LoginResponseDto = {
    id: user.id,
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.name ? { name: user.name } : {}),
    ...avatarOf(user),
    canManageNewsletters: canManageNewslettersOf(user),
    canManageMoney: canManageMoneyOf(user),
    ...(user.locale ? { locale: user.locale } : {}),
    ...(user.phone ? { phone: user.phone } : {}),
  };

  return { result, accessToken, refreshToken };
}
