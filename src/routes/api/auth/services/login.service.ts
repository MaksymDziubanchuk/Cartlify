import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import {
  AppError,
  BadRequestError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from '@utils/errors.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { verifyPass } from '@helpers/safePass.js';

import type { LoginDto, LoginResponseDto } from 'types/dto/auth.dto.js';

import { setGuestContext } from '@db/dbContext.service.js';
import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';
import { insertLoginLog } from './helpers/loginLogs.helper.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.helper.js';

import { avatarOf } from '@utils/avatar.util.js';

// local login flow
// guest -> user context switch
// migrate + log + issue tokens
export async function login({
  email,
  password,
  rememberMe = false,
  ip,
  userAgent,
  userId: guestId,
}: LoginDto): Promise<{ result: LoginResponseDto; refreshToken: string; accessToken: string }> {
  const cleanEmail = email.trim().toLowerCase();

  assertEmail(cleanEmail);

  if (!cleanEmail) throw new BadRequestError('EMAIL_REQUIRED');

  // spaces at the edges of a password are dropped, the same at registration and password reset
  const cleanPassword = password?.trim() ?? '';
  if (!cleanPassword) throw new BadRequestError('PASSWORD_REQUIRED');

  const invalidCreds = () => new UnauthorizedError('INVALID_CREDENTIALS');

  try {
    return await prisma.$transaction(async (tx) => {
      // allow guest-scoped reads
      await setGuestContext(tx, guestId);

      // load login data from db
      const rows = await tx.$queryRaw<
        {
          id: number;
          password_hash: string | null;
          role: Role;
          is_verified: boolean;
          auth_provider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
        }[]
      >`select * from cartlify.auth_get_user_for_login(${cleanEmail})`;

      const u = rows[0];
      if (!u) throw invalidCreds();

      // require local auth provider
      if (u.auth_provider !== 'LOCAL') {
        throw new ForbiddenError('AUTH_PROVIDER_MISMATCH', {
          authProvider: u.auth_provider,
        });
      }

      // verify password hash
      if (!u.password_hash) {
        throw new InternalError({ reason: 'LOCAL_ACCOUNT_PASSWORD_HASH_MISSING' });
      }

      // registration used to keep edge spaces in the hash, such a password is
      // checked once more exactly as typed, so those accounts still log in
      const ok =
        (await verifyPass(cleanPassword, u.password_hash)) ||
        (cleanPassword !== password && (await verifyPass(password, u.password_hash)));
      if (!ok) throw invalidCreds();

      // require verified email
      if (!u.is_verified) {
        throw new ForbiddenError('EMAIL_NOT_VERIFIED');
      }

      // switches the transaction to the user context, everything below runs as this user
      await migrateGuestDataToUser(tx, guestId, { id: u.id, role: u.role });

      await insertLoginLog(tx, {
        userId: u.id as any,
        email: cleanEmail,
        role: u.role as any,
        ...(ip !== undefined ? { ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });

      // load full user profile
      const user = await tx.user.findUnique({
        where: { id: u.id },
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
        },
      });

      if (!user) if (!user) throw new InternalError({ reason: 'USER_NOT_FOUND_AFTER_LOGIN' });

      assertEmail(user.email);

      // issue session tokens
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role,
        rememberMe,
        ...(userAgent !== undefined ? { userAgent } : {}),
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
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
      };

      return { result, refreshToken, accessToken };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'LOGIN_SERVICE_UNEXPECTED' }, err);
  }
}
