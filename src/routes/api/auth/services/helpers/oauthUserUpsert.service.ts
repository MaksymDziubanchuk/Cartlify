import type { Prisma, Role } from '@prisma/client';
import { AppError } from '@utils/errors.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

type Tx = Prisma.TransactionClient;

export type OAuthProvider = 'GOOGLE' | 'GITHUB' | 'LINKEDIN';

export interface OAuthUserRow {
  id: number;
  email: string;
  role: Role;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  name: string | null;
  avatarUrl: string | null;
  locale: string | null;
  phone: string | null;
  authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
  providerSub: string | null;
}

export interface UpsertOAuthUserArgs {
  email: string;
  authProvider: OAuthProvider;
  providerSub: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  locale: string | null;

  userNotFoundAfterConflictMsg: string;
  providerSubMismatchMsg: string;
}

export async function upsertOAuthUserByEmail(
  tx: Tx,
  args: UpsertOAuthUserArgs,
): Promise<OAuthUserRow> {
  const {
    email,
    authProvider,
    providerSub,
    emailVerified,
    name,
    avatarUrl,
    locale,
    userNotFoundAfterConflictMsg,
    providerSubMismatchMsg,
  } = args;

  // upsert oauth user by email
  await setAdminContext(tx);

  const inserted = await tx.$queryRaw<OAuthUserRow[]>`
    insert into cartlify.users (
      email,
      role,
      "isVerified",
      name,
      "avatarUrl",
      locale,
      "authProvider",
      "providerSub",
      "passwordHash"
    )
    values (
      ${email},
      'USER'::cartlify."Role",
      ${emailVerified},
      ${name},
      ${avatarUrl},
      ${locale},
      ${authProvider},
      ${providerSub},
      null
    )
    on conflict (email) do nothing
    returning
      id,
      email,
      role,
      "isVerified",
      "createdAt",
      "updatedAt",
      name,
      "avatarUrl",
      locale,
      phone,
      "authProvider",
      "providerSub"
  `;

  // track current user row
  let u = inserted[0];

  if (!u) {
    const rows = await tx.$queryRaw<OAuthUserRow[]>`
      select
        id,
        email,
        role,
        "isVerified",
        "createdAt",
        "updatedAt",
        name,
        "avatarUrl",
        locale,
        phone,
        "authProvider",
        "providerSub"
      from cartlify.users
      where email = ${email}
      limit 1
    `;

    // fallback user snapshot
    u = rows[0];

    // fallback select on conflict
    if (!u) throw new AppError(userNotFoundAfterConflictMsg, 500);

    // allow oauth takeover
    const canAdoptUnverifiedLocal =
      u.authProvider === 'LOCAL' && !u.isVerified && emailVerified === true;

    // provider mismatch on existing account
    if (u.authProvider !== authProvider) {
      if (!canAdoptUnverifiedLocal) {
        throw new AppError(`Use ${u.authProvider} login for this account`, 403);
      }

      // convert unverified local to oauth
      const updated = await tx.$queryRaw<OAuthUserRow[]>`
        update cartlify.users
        set
          "authProvider" = ${authProvider},
          "providerSub"  = ${providerSub},
          "isVerified"   = true,
          "passwordHash" = null,
          "updatedAt"    = now()
        where id = ${u.id}::int
        returning
          id,
          email,
          role,
          "isVerified",
          "createdAt",
          "updatedAt",
          name,
          "avatarUrl",
          locale,
          phone,
          "authProvider",
          "providerSub"
      `;

      const uu = updated[0];
      if (!uu) throw new AppError(userNotFoundAfterConflictMsg, 500);

      // invalidate pending verify tokens
      await tx.$executeRaw`
        update cartlify.user_tokens
        set "usedAt" = now()
        where "userId" = ${uu.id}::int
          and type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
          and "usedAt" is null
      `;

      // use converted row
      u = uu;
    }

    // prevent sub takeover
    if (u.authProvider === authProvider && u.providerSub && u.providerSub !== providerSub) {
      throw new AppError(providerSubMismatchMsg, 403);
    }
  }

  // set user db context
  await setUserContext(tx, { userId: u.id, role: u.role });

  // fill missing profile fields
  const updated = await tx.$queryRaw<OAuthUserRow[]>`
    update cartlify.users
    set
      "providerSub" = coalesce("providerSub", ${providerSub}),
      name          = coalesce(name, ${name}),
      "avatarUrl"   = coalesce("avatarUrl", ${avatarUrl}),
      locale        = coalesce(locale, ${locale}),
      "updatedAt"   = now()
    where id = ${u.id}::int
    returning
      id,
      email,
      role,
      "isVerified",
      "createdAt",
      "updatedAt",
      name,
      "avatarUrl",
      locale,
      phone,
      "authProvider",
      "providerSub"
  `;

  // refresh returned fields
  u = updated[0] ?? u;

  return u;
}
