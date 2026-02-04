import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import { AppError, BadRequestError } from '@utils/errors.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { verifyPass } from '@helpers/safePass.js';

import type { LoginDto, LoginResponseDto } from 'types/dto/auth.dto.js';

import { setGuestContext, setUserContext } from '@db/dbContext.service.js';
import { migrateGuestDataToUser } from './helpers/guestMigration.service.js';
import { insertLoginLog } from './helpers/loginLogs.service.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.service.js';

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

  if (!cleanEmail) throw new BadRequestError('Email is required');
  if (!password) throw new BadRequestError('Password is required');

  const invalidCreds = () => new AppError('Invalid email or password', 401);

  return await prisma
    .$transaction(async (tx) => {
      await setGuestContext(tx, guestId);

      const rows = await tx.$queryRaw<
        {
          id: number;
          password_hash: string | null;
          role: Role;
          is_verified: boolean;
          authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
        }[]
      >`select * from cartlify.auth_get_user_for_login(${cleanEmail})`;

      const u = rows[0];
      if (!u) throw invalidCreds();

      if (u.authProvider !== 'LOCAL') {
        throw new AppError(`Use ${u.authProvider} login for this account`, 403);
      }

      if (!u.password_hash) {
        throw new AppError('Local account has no password hash', 500);
      }

      const ok = await verifyPass(password, u.password_hash);
      if (!ok) throw invalidCreds();

      if (!u.is_verified) {
        throw new AppError('Email is not verified', 403);
      }

      await setUserContext(tx, { userId: u.id, role: u.role });

      await migrateGuestDataToUser(tx, guestId, u.id);

      await insertLoginLog(tx, {
        userId: u.id as any,
        email: cleanEmail,
        role: u.role as any,
        ...(ip !== undefined ? { ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });

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

      if (!user) throw new AppError('User not found after login', 500);

      assertEmail(user.email);

      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role,
        rememberMe,
      });

      const result: LoginResponseDto = {
        id: user.id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
      };

      return { result, refreshToken, accessToken };
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;
      throw new AppError('Something went wrong', 500);
    });
}
