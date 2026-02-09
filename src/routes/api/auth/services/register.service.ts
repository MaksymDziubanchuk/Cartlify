import { Prisma, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';

import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';

import { sendVerifyEmail } from './helpers/sendVerifyEmail.helper.js';

import { setGuestContext, setUserContext } from '@db/dbContext.service.js';

import { buildImageUrls } from '@utils/cloudinary.util.js';

import type { RegisterDto, RegisterResponseDto } from 'types/dto/auth.dto.ts';

// local register flow
// create user + verify token
export async function register({
  email,
  password,
  name,
  userId: guestId,
}: RegisterDto): Promise<RegisterResponseDto> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name?.trim() || undefined;

  if (!cleanEmail) throw new BadRequestError('Email is required');

  assertEmail(cleanEmail);

  if (!password || password.length < 6) {
    throw new BadRequestError('Password must be at least 6 characters');
  }

  // prepare password and verify token
  const passwordHash = await hashPass(password);
  const { token, expiresAt } = makeVerifyToken();

  let result: RegisterResponseDto;

  try {
    result = await prisma.$transaction(async (tx) => {
      await setGuestContext(tx, guestId);

      // create user row
      await tx.$executeRaw`
        insert into cartlify.users (email, "passwordHash", role, "isVerified", name)
        values (
          ${cleanEmail},
          ${passwordHash},
          'USER'::cartlify."Role",
          false,
          ${cleanName ?? null}
        )
      `;

      // read new user id
      const [{ id }] = await tx.$queryRaw<{ id: number }[]>`
        select currval(pg_get_serial_sequence('cartlify.users', 'id'))::int as id
      `;

      // switch to user db context
      await setUserContext(tx, { userId: id, role: 'USER' });

      // store verify email token
      await tx.$executeRaw`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${id},
          'VERIFY_EMAIL'::cartlify."UserTokenType",
          ${token},
          ${expiresAt}
        )
      `;

      // load created user profile
      const u = await tx.user.findUnique({
        where: { id },
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

      if (!u) throw new AppError('User creation failed', 500);

      return {
        id: u.id,
        email: u.email as any,
        role: u.role as Role,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        ...(u.name ? { name: u.name } : {}),
        ...(u.avatarUrl ? { avatarUrls: buildImageUrls(u.avatarUrl, 'avatar') } : {}),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };
    });
  } catch (err) {
    // map unique email conflict
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Email already in use', 409);
    }
    // map raw sql unique conflict
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2010' &&
      (err.meta as any)?.code === '23505'
    ) {
      throw new AppError('Email already in use', 409);
    }
    throw err;
  }

  // send verify email after commit
  await sendVerifyEmail({
    to: cleanEmail,
    token,
    expiresAt,
    userName: cleanName || '',
  });

  return result;
}
