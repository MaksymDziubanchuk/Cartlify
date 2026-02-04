import { Prisma, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';

import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';

import { setGuestContext, setUserContext } from '@db/dbContext.service.js';

import type { RegisterDto, RegisterResponseDto } from 'types/dto/auth.dto.ts';

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

  const passwordHash = await hashPass(password);
  const { token, expiresAt } = makeVerifyToken();

  try {
    return await prisma.$transaction(async (tx) => {
      await setGuestContext(tx, guestId);

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

      const [{ id }] = await tx.$queryRaw<{ id: number }[]>`
        select currval(pg_get_serial_sequence('cartlify.users', 'id'))::int as id
      `;

      await setUserContext(tx, { userId: id, role: 'USER' });

      await tx.$executeRaw`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${id},
          'VERIFY_EMAIL'::cartlify."UserTokenType",
          ${token},
          ${expiresAt}
        )
      `;

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
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Email already in use', 409);
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2010' &&
      (err.meta as any)?.code === '23505'
    ) {
      throw new AppError('Email already in use', 409);
    }
    throw err;
  }
}
