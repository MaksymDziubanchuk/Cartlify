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

import { buildImageUrls } from '@utils/cloudinary.util.js';

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

  if (!cleanEmail) throw new BadRequestError('Email is required');
  if (!password) throw new BadRequestError('Password is required');

  const invalidCreds = () => new AppError('Invalid email or password', 401);

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
        throw new AppError(`Use ${u.auth_provider} login for this account`, 403);
      }

      // verify password hash
      if (!u.password_hash) {
        throw new AppError('Local account has no password hash', 500);
      }

      const ok = await verifyPass(password, u.password_hash);
      if (!ok) throw invalidCreds();

      // require verified email
      if (!u.is_verified) {
        throw new AppError('Email is not verified', 403);
      }

      // switch to user db context
      await setUserContext(tx, { userId: u.id, role: u.role });

      await migrateGuestDataToUser(tx, guestId, u.id);

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

      if (!user) throw new AppError('User not found after login', 500);

      assertEmail(user.email);

      // issue session tokens
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
        ...(user.avatarUrl ? { avatarUrls: buildImageUrls(user.avatarUrl, 'avatar') } : {}),
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
      };

      return { result, refreshToken, accessToken };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`Login(service): unexpected (${msg})`, 500);
  }
}
