import { Prisma, Role } from '@prisma/client';
import { getPgCode, prisma } from '@db/client.js';
import { BadRequestError, ConflictError, InternalError } from '@utils/errors.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashToken } from '@helpers/tokenHash.js';
import { hashPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';

import { sendVerifyEmail } from './helpers/sendVerifyEmail.helper.js';

import { setAdminContext, setGuestContext, setUserContext } from '@db/dbContext.service.js';

import { avatarOf } from '@utils/avatar.util.js';
import { checkChosenVersions } from '@routes/api/legal/services/helpers/legalConsent.helper.js';
import {
  currentDocuments,
  knownDocumentIds,
  recordConsents,
  versionsOf,
} from '@routes/api/legal/services/helpers/legalDocuments.helper.js';

import type { RegisterDto, RegisterResponseDto } from 'types/dto/auth.dto.ts';

// local register flow
// create user + verify token. The data of the guest stays with the guest: nobody proved the
// email yet, a mistyped address would take the chats and favorites of the browser into the
// account of somebody else; they move with the verification of the email or with a login.
// An address registered before and never verified is taken by the new registration: somebody may
// have registered the address of someone else with a password of their own, the owner sets the
// password now, and the new link goes to the owner.
// While a version of the terms or of the contract is in force the person accepts every one of
// them here (acceptedDocumentIds): the consent is kept with the account, with the address and the
// browser of the request
export async function register({
  email,
  password,
  name,
  userId: guestId,
  acceptedDocumentIds = [],
}: RegisterDto): Promise<RegisterResponseDto> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name?.trim() || undefined;

  if (!cleanEmail) throw new BadRequestError('EMAIL_REQUIRED');

  assertEmail(cleanEmail);

  // spaces at the edges of a password are dropped, the same at login and at password reset
  const cleanPassword = password?.trim() ?? '';

  if (cleanPassword.length < 6) {
    throw new BadRequestError('PASSWORD_TOO_SHORT', { minLength: 6 });
  }

  // prepare password and verify token
  const passwordHash = await hashPass(cleanPassword);
  const { token, expiresAt } = makeVerifyToken();

  let result: RegisterResponseDto;

  try {
    result = await prisma.$transaction(async (tx) => {
      // an account of the address already there: the system reads it, a guest sees no users
      await setAdminContext(tx);
      const [existing] = await tx.$queryRaw<
        { id: number; isVerified: boolean; authProvider: string; role: Role }[]
      >`
        select id, "isVerified", "authProvider", role
        from cartlify.users
        where email = ${cleanEmail}
      `;

      let id: number;

      if (existing) {
        // a verified account, one of a provider or of an admin belongs to someone
        if (existing.isVerified || existing.authProvider !== 'LOCAL' || existing.role !== 'USER') {
          throw new ConflictError('EMAIL_ALREADY_IN_USE');
        }

        id = existing.id;
        await setUserContext(tx, { userId: id, role: 'USER' });

        await tx.user.update({
          where: { id },
          data: { passwordHash, ...(cleanName ? { name: cleanName } : {}), updatedAt: new Date() },
          select: { id: true },
        });

        // the links mailed for the account before end, the new one is the only way in
        await tx.userToken.updateMany({
          where: { userId: id, type: 'VERIFY_EMAIL', usedAt: null },
          data: { usedAt: new Date() },
        });
      } else {
        await setGuestContext(tx, guestId);

        // create user row; a guest may create only a USER
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
        [{ id }] = await tx.$queryRaw<{ id: number }[]>`
          select currval(pg_get_serial_sequence('cartlify.users', 'id'))::int as id
        `;

        // everything below runs as this user
        await setUserContext(tx, { userId: id, role: 'USER' });
      }

      // the versions in force, each one accepted; none while root has published none
      const current = versionsOf(await currentDocuments(tx));
      checkChosenVersions(
        current,
        acceptedDocumentIds,
        await knownDocumentIds(tx, acceptedDocumentIds),
        {
          every: true,
        },
      );
      await recordConsents(tx, id, acceptedDocumentIds, 'consent.register');

      // store the hash of the verify link, the link itself goes only to the mail:
      // a copy of the database is not enough to verify someone else's email
      await tx.$executeRaw`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${id},
          'VERIFY_EMAIL'::cartlify."UserTokenType",
          ${hashToken(token)},
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

      if (!u) throw new InternalError({ reason: 'USER_CREATION_FAILED' });

      return {
        id: u.id,
        email: u.email as any,
        role: u.role as Role,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        ...(u.name ? { name: u.name } : {}),
        ...avatarOf(u),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };
    });
  } catch (err) {
    // map unique email conflict
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('EMAIL_ALREADY_IN_USE');
    }
    // map raw sql unique conflict
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2010' &&
      getPgCode(err) === '23505'
    ) {
      throw new ConflictError('EMAIL_ALREADY_IN_USE');
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
