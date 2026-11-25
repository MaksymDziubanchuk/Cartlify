import type { AuthProvider, Role } from '@prisma/client';
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

import type { LoginDto } from 'types/dto/auth.dto.js';

import { setGuestContext } from '@db/dbContext.service.js';
import type { UserId } from 'types/ids.js';
import { openSession, type OpenedSession } from './helpers/openSession.helper.js';
import { secondStepOfLogin, type SecondStep } from './twoFactor.service.js';

// a login opens a session, or, for an admin or root, asks for the second step
export type LoginOutcome = { session: OpenedSession } | { secondStep: SecondStep };

// local login flow: the password, then the second step of an admin or root, then the session
export async function login({
  email,
  password,
  rememberMe = false,
  ip,
  userAgent,
  userId: guestId,
  acceptedDocumentIds = [],
  trustedDevice,
}: LoginDto & { trustedDevice?: string | undefined }): Promise<LoginOutcome> {
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
          auth_provider: AuthProvider;
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

      // an admin or root goes on to the second step, unless the browser is one an admin trusts;
      // the password alone changes nothing then: no guest data move, no line of the journal
      const secondStep = await secondStepOfLogin(tx, {
        userId: u.id,
        role: u.role,
        event: 'login.password',
        rememberMe,
        deviceCookie: trustedDevice,
      });
      if (secondStep) return { secondStep };

      const session = await openSession(tx, {
        userId: u.id,
        role: u.role,
        guestId: guestId as UserId,
        rememberMe,
        event: 'login.password',
        ip,
        userAgent,
        acceptedDocumentIds,
      });

      return { session };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'LOGIN_SERVICE_UNEXPECTED' }, err);
  }
}
