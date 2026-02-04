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
  provider: OAuthProvider;
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
    provider,
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
      ${provider},
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

    u = rows[0];

    // fallback select on conflict
    if (!u) throw new AppError(userNotFoundAfterConflictMsg, 500);

    if (u.authProvider !== provider) {
      throw new AppError(`Use ${u.authProvider} login for this account`, 403);
    }

    if (u.providerSub && u.providerSub !== providerSub) {
      throw new AppError(providerSubMismatchMsg, 403);
    }
  }

  // set user db context
  await setUserContext(tx, { userId: u.id, role: u.role });

  // fill missing profile fields
  await tx.$executeRaw`
    update cartlify.users
    set
      "providerSub" = coalesce("providerSub", ${providerSub}),
      name          = coalesce(name, ${name}),
      "avatarUrl"   = coalesce("avatarUrl", ${avatarUrl}),
      locale        = coalesce(locale, ${locale})
    where id = ${u.id}::int
  `;

  return u;
}
