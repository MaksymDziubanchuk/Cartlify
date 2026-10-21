import { Prisma } from '@prisma/client';
import type { AuthProvider } from '@prisma/client';

import env from '@config/env.js';
import { prisma } from '@db/client.js';
import {
  UnauthorizedError,
  isAppError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  InternalError,
} from '@utils/errors.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { PROFILE_TEXT_MAX_LENGTH, isPhone, textLength } from '@helpers/profileText.js';
import { verifyPass } from '@helpers/safePass.js';
import {
  makePublicId,
  makeUploadPublicId,
  moveImage,
  requireImageStream,
  uploadImage,
  UploadImageResult,
} from '@utils/cloudinary.util.js';
import { avatarOf } from '@utils/avatar.util.js';

import type {
  AvatarPart,
  FindUserByIdDto,
  FindMeByIdDto,
  UpdateMeDto,
  UserResponseDto,
  UserReviewResponseDto,
  UserByIdResponseDto,
  PublicUserProfileDto,
  DeleteUserByIdDto,
  DeleteMeDto,
} from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

import {
  loadProfileLists,
  parseProfileLists,
  resolveProfilePeriod,
} from './services/helpers/adminProfile.helper.js';
import { deleteAccount } from './services/helpers/deleteAccount.helper.js';
import { findUsers } from './services/findUsers.service.js';
import { removeUserAvatar } from './services/removeUserAvatar.service.js';
import { countAvatarRemovals, deleteAvatarFile } from './services/helpers/avatarRemovals.helper.js';

async function findMe({ userId }: FindMeByIdDto): Promise<UserResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard against unauthenticated/invalid context
  if (!Number.isInteger(id)) throw new UnauthorizedError('LOGIN_REQUIRED');

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for RLS policies
      await setUserContext(tx, { userId: id, role: 'USER' });

      // load current user profile fields
      const user = await tx.user.findUnique({
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

      // should never happen after successful auth, treat as server inconsistency
      if (!user) throw new InternalError({ reason: 'USER_NOT_FOUND_AFTER_AUTH' });

      // validate email format before returning it to client
      assertEmail(user.email);

      // fetch only user reviews that contain a real comment, plus vote aggregate and user's own vote
      const rows = await tx.review.findMany({
        where: {
          userId: id,
          AND: [{ comment: { not: null } }, { NOT: { comment: '' } }],
        },
        select: {
          id: true,
          productId: true,
          rating: true,
          userId: true,
          createdAt: true,
          comment: true,
          upVotes: true,
          downVotes: true,
          updatedAt: true,
          votes: {
            where: { userId: id },
            select: { action: true },
            take: 1,
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      // map db shape to api dto, trimming comment and normalizing userVote values
      const reviews: UserReviewResponseDto[] = rows
        .map((r) => {
          // normalize comment to avoid returning empty/whitespace-only values
          const comment = (r.comment ?? '').trim();
          if (!comment) return null;

          // rating is required in the response; the api never creates a review with text and without rating
          if (r.rating == null) return null;

          // derive current user's vote from enum stored in review_votes
          const action = r.votes[0]?.action;
          const userVote = action === 'UP' ? 'up' : action === 'DOWN' ? 'down' : null;

          return {
            id: r.id as any,
            productId: r.productId as any,
            rating: r.rating,

            userId: r.userId as any,
            createdAt: r.createdAt,
            comment,
            upVotes: r.upVotes,
            downVotes: r.downVotes,
            userVote,
            updatedAt: r.updatedAt,
          };
        })
        // drop rows that ended up with an empty comment after trimming
        .filter((x): x is UserReviewResponseDto => x !== null);

      // build final user response, including derived avatar urls and optional fields
      return {
        id: user.id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        // the own picture in its sizes, or the drawn letter
        ...avatarOf(user),
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
        reviews,
      };
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // keep a short diagnostic message without leaking full error objects

    throw new InternalError({ reason: 'USERS_FIND_ME_UNEXPECTED' }, err);
  }
}

async function beginAvatarUpload(args: {
  userId: UserId;
  avatar: AvatarPart;
}): Promise<UploadImageResult> {
  const s: any = args.avatar.file;

  // fast fail: stream already dead
  if (!s || s.destroyed || s.readableEnded) {
    throw new BadRequestError('AVATAR_EMPTY');
  }

  // an empty file and one that is not a jpeg, png or webp by its bytes never reach cloudinary
  const safeStream = await requireImageStream(args.avatar.file, {
    mimetype: args.avatar.mimetype,
    emptyCode: 'AVATAR_STREAM_ERROR',
  });

  // the avatar waits under an id of its own: updateMe moves it to the avatar of the account once
  // the profile is written, a refused request deletes it (the controller)
  return uploadImage({
    publicId: makeUploadPublicId(),
    file: safeStream,
    mimetype: args.avatar.mimetype,
    ...(args.avatar.filename ? { filename: args.avatar.filename } : {}),
    tags: ['avatar', `user:${args.userId}`],
  });
}

// the profile fields an update answers with
const profileSelect = {
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
} satisfies Prisma.UserSelect;

async function updateMe({
  userId,
  userRole,
  name,
  locale,
  phone,
  avatarUploaded,
  removeAvatar,
  log,
}: UpdateMeDto): Promise<UserResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard against unauthenticated/invalid context
  if (!Number.isInteger(id)) throw new UnauthorizedError('LOGIN_REQUIRED');

  // normalize actor role from dto/context
  const rawRole = userRole as unknown as string;
  if (rawRole !== 'USER' && rawRole !== 'ADMIN' && rawRole !== 'ROOT') {
    throw new InternalError({ reason: 'ACTOR_ROLE_INVALID' });
  }
  const role = rawRole as 'USER' | 'ADMIN' | 'ROOT';

  // unwrap multipart attached fields to plain strings
  const readStr = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (
      typeof v === 'object' &&
      v !== null &&
      'value' in v &&
      typeof (v as any).value === 'string'
    ) {
      return (v as any).value;
    }
    return undefined;
  };

  // build partial update payload for db
  const data: Record<string, unknown> = {};

  // a json body is checked against the limit by its schema; a form is not, so the limit is
  // checked here for both, on the text as it was sent
  const nameRaw = readStr(name);
  if (nameRaw !== undefined) {
    if (textLength(nameRaw) > PROFILE_TEXT_MAX_LENGTH) throw new BadRequestError('NAME_TOO_LONG');
    const v = nameRaw.trim();
    data.name = v ? v : null;
  }

  const localeRaw = readStr(locale);
  if (localeRaw !== undefined) {
    if (textLength(localeRaw) > PROFILE_TEXT_MAX_LENGTH) {
      throw new BadRequestError('LOCALE_TOO_LONG');
    }
    const v = localeRaw.trim();
    data.locale = v ? v : null;
  }

  // clear phone explicitly
  if (phone === null) {
    data.phone = null;
  } else {
    const phoneRaw = readStr(phone);
    if (phoneRaw !== undefined) {
      // the same rule as the schema of a json body: empty removes the phone, anything else is
      // taken as sent or refused; a form does not get a number cleaned for it
      if (phoneRaw !== '' && !isPhone(phoneRaw)) throw new BadRequestError('PHONE_INVALID');
      data.phone = phoneRaw === '' ? null : phoneRaw;
    }
  }

  // the uploaded avatar still waits under its own id; the row gets the place it moves to
  const avatarPublicId = avatarUploaded ? makePublicId({ kind: 'avatar', userId: id }) : null;
  if (avatarUploaded && avatarPublicId) {
    data.publicId = avatarPublicId;
    data.avatarUrl = avatarUploaded.urlBase;
  }

  // an empty avatar removes it: the profile draws the letter, the file goes after the commit
  if (removeAvatar) {
    data.publicId = null;
    data.avatarUrl = null;
  }

  // reject empty updates to avoid silent no-op
  if (!Object.keys(data).length) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // the file of the removed avatar, read before the row forgets it
  let removedPublicId: string | null = null;
  let profile: UserResponseDto;

  try {
    profile = await prisma.$transaction(
      async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: id, role });

        if (removeAvatar) {
          const before = await tx.user.findUnique({ where: { id }, select: { publicId: true } });
          removedPublicId = before?.publicId ?? null;
        }

        // update profile fields under rls
        let user = await tx.user.update({ where: { id }, data, select: profileSelect });

        // the row is written, so the request is taken: only now the upload replaces the avatar
        // file of the account; a refused request never touched it
        if (avatarUploaded && avatarPublicId) {
          const placed = await moveImage(avatarUploaded.publicId, avatarPublicId);
          user = await tx.user.update({
            where: { id },
            data: { avatarUrl: placed.urlBase },
            select: profileSelect,
          });
        }

        // validate email format before returning it to client
        assertEmail(user.email);

        // fetch only user reviews that contain a real comment, plus vote aggregate and user's own vote
        const rows = await tx.review.findMany({
          where: {
            userId: id,
            AND: [{ comment: { not: null } }, { NOT: { comment: '' } }],
          },
          select: {
            id: true,
            productId: true,
            rating: true,
            userId: true,
            createdAt: true,
            comment: true,
            upVotes: true,
            downVotes: true,
            updatedAt: true,
            votes: {
              where: { userId: id },
              select: { action: true },
              take: 1,
            },
          },
          orderBy: { updatedAt: 'desc' },
        });

        const reviews = rows
          .map((r) => {
            const comment = (r.comment ?? '').trim();
            if (!comment) return null;

            // rating is required in the response; the api never creates a review with text and without rating
            if (r.rating == null) return null;

            const action = r.votes[0]?.action;
            const userVote = action === 'UP' ? 'up' : action === 'DOWN' ? 'down' : null;

            return {
              id: r.id as any,
              productId: r.productId as any,
              rating: r.rating,
              userId: r.userId as any,
              createdAt: r.createdAt,
              comment,
              upVotes: r.upVotes,
              downVotes: r.downVotes,
              userVote,
              updatedAt: r.updatedAt,
            };
          })
          .filter((x): x is UserReviewResponseDto => x !== null);

        // build final user response, including derived avatar urls and optional fields
        return {
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
          reviews,
        };
        // the move at cloudinary runs inside the transaction
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    // rls hides a deleted account from its owner for changes; its access token still works for
    // a few minutes after the deletion
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError('USER_NOT_FOUND');
    }

    throw new InternalError({ reason: 'USERS_UPDATE_ME_UNEXPECTED' }, err);
  }

  if (removedPublicId && log) await deleteAvatarFile(removedPublicId, log);

  return profile;
}

// a row of cartlify.users_get_public_profile; the fields after avatarUrl are null for a user
type ProfileRow = {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  role: Role | null;
  authProvider: AuthProvider | null;
  isVerified: boolean | null;
  locale: string | null;
  phone: string | null;
  deletedAt: Date | null;
};

// the email of an account for the letter of its drawn avatar; the transaction goes on as admin
async function emailForAvatar(tx: Prisma.TransactionClient, id: number): Promise<string | null> {
  await setAdminContext(tx);
  const row = await tx.user.findUnique({ where: { id }, select: { email: true } });
  return row?.email ?? null;
}

async function findById({
  actorId,
  actorRole,
  userId,
  include,
  from,
  to,
}: FindUserByIdDto): Promise<UserByIdResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard invalid id
  if (!Number.isInteger(id)) throw new BadRequestError('USER_ID_INVALID');

  // the checkboxes and the period are for an admin or root, the ones of a user are ignored
  const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';
  const period = isAdmin ? resolveProfilePeriod({ from, to }) : null;
  const lists = isAdmin ? parseProfileLists(include) : [];

  try {
    return await prisma.$transaction(async (tx) => {
      // the db function serves only a signed-in actor, so it needs the actor context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // the db function decides by the role what the profile holds: a user gets the name, the
      // avatar and the dates, an admin or root the whole profile; a deleted account is no row for
      // a user, as if it never was
      const rows = await tx.$queryRaw<ProfileRow[]>`
        select
          id,
          created_at as "createdAt",
          updated_at as "updatedAt",
          name,
          avatar_url as "avatarUrl",
          email,
          role,
          auth_provider as "authProvider",
          is_verified as "isVerified",
          locale,
          phone,
          deleted_at as "deletedAt"
        from cartlify.users_get_public_profile(${id}::int)
        limit 1
      `;

      const user = rows[0] ?? null;
      if (!user) throw new NotFoundError('USER_NOT_FOUND');

      // the drawn avatar of an account without a name takes the first letter of the email, which
      // the database function keeps from a user: it is read the way the authors of reviews are,
      // under the admin context, and only its first letter leaves the server
      const letterEmail =
        user.name || user.email !== null ? user.email : await emailForAvatar(tx, id);

      const profile: PublicUserProfileDto = {
        id: user.id as UserId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        ...avatarOf({ ...user, email: letterEmail, deleted: user.deletedAt !== null }),
      };

      if (!period) return profile;

      // the database gives an admin these fields always
      const { email, role, authProvider, isVerified } = user;
      if (email === null || role === null || authProvider === null || isVerified === null) {
        throw new InternalError({ reason: 'USER_ADMIN_PROFILE_INCOMPLETE' });
      }
      assertEmail(email);

      // the open chat of the user with an admin: the admin goes from the profile into it
      const chat = await tx.chatThread.findFirst({
        where: { userId: id, type: 'admin', status: 'open' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      return {
        ...profile,
        email,
        role,
        authProvider,
        isVerified,
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
        ...(user.deletedAt ? { deletedAt: user.deletedAt } : {}),
        openChatThreadId: chat?.id ?? null,
        // past the limit the page tells the admin to take the account to root
        avatarRemovals: await countAvatarRemovals(tx, id),
        avatarRemovalsLimit: env.AVATAR_REMOVALS_LIMIT,
        period,
        ...(await loadProfileLists(tx, id, lists, period)),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_FIND_BY_ID_UNEXPECTED' }, err);
  }
}

async function deleteUserById({
  actorId,
  userId,
  log,
}: DeleteUserByIdDto): Promise<MessageResponseDto> {
  // normalize ids
  const rootId = typeof actorId === 'string' ? Number(actorId) : actorId;
  const targetId = typeof userId === 'string' ? Number(userId) : userId;

  // guard invalid input
  if (!Number.isInteger(targetId) || targetId <= 0) throw new BadRequestError('USER_ID_INVALID');

  // avoid locking yourself out
  if (targetId === rootId) throw new ConflictError('ROOT_CANNOT_DELETE_SELF');

  // a root deletes without asking about the orders: the admin tells the person
  await deleteAccount({ userId: targetId, systemActorId: rootId, confirmOpenOrders: true, log });

  return { message: 'user deleted' };
}

// a login this recent confirms an oauth account, that has no password to ask for
const RECENT_LOGIN_MAX_AGE_MS = 10 * 60_000;

// what confirms a deletion: the own row and the last login, both the user's to read
async function loadDeletionConfirmation(id: number) {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: id, role: 'USER' });

      return {
        account: await tx.user.findUnique({
          where: { id },
          select: { authProvider: true, passwordHash: true },
        }),
        lastLogin: await tx.loginLog.findFirst({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_DELETE_ME_UNEXPECTED' }, err);
  }
}

// a user deletes their own account: a local one confirms it with the password, an oauth one with
// a login of the last 10 minutes. Admins and roots never get here, the route lets only users in
async function deleteMe({ userId, password, confirmOpenOrders, log }: DeleteMeDto): Promise<void> {
  const id = typeof userId === 'string' ? Number(userId) : userId;
  if (!Number.isInteger(id)) throw new UnauthorizedError('LOGIN_REQUIRED');

  const { account, lastLogin } = await loadDeletionConfirmation(id);

  if (!account) throw new NotFoundError('USER_NOT_FOUND');

  if (account.authProvider === 'LOCAL') {
    // spaces at the edges of a password are dropped, the same as at the login
    const cleanPassword = password?.trim() ?? '';
    if (!cleanPassword) throw new BadRequestError('PASSWORD_REQUIRED');
    if (!account.passwordHash) {
      throw new InternalError({ reason: 'LOCAL_ACCOUNT_PASSWORD_HASH_MISSING' });
    }

    // an older password kept its edge spaces in the hash, it is checked once more as typed
    const ok =
      (await verifyPass(cleanPassword, account.passwordHash)) ||
      (cleanPassword !== password &&
        password !== undefined &&
        (await verifyPass(password, account.passwordHash)));

    // 403, not 401: the session is fine, only the confirmation is wrong
    if (!ok) throw new ForbiddenError('PASSWORD_INVALID');
  } else {
    const fresh =
      lastLogin !== null && Date.now() - lastLogin.createdAt.getTime() <= RECENT_LOGIN_MAX_AGE_MS;

    // the frontend logs out, sends the person through the provider again and repeats the request
    if (!fresh) throw new ForbiddenError('RECENT_LOGIN_REQUIRED');
  }

  await deleteAccount({
    userId: id,
    systemActorId: id,
    confirmOpenOrders: confirmOpenOrders === true,
    log,
  });
}

export const usersServices = {
  findUsers,
  removeUserAvatar,
  findMe,
  beginAvatarUpload,
  updateMe,
  findById,
  deleteUserById,
  deleteMe,
};
