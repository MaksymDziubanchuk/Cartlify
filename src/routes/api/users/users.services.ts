import { Prisma } from '@prisma/client';

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
  overwriteImage,
  requireNonEmptyStream,
  UploadImageResult,
  buildImageUrls,
} from '@utils/cloudinary.util.js';

import type {
  AvatarPart,
  FindUserByIdDto,
  FindMeByIdDto,
  UpdateMeDto,
  UserResponseDto,
  UserReviewResponseDto,
  UserByIdResponseDto,
  DeleteUserByIdDto,
  DeleteMeDto,
} from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserId } from 'types/ids.js';

import { deleteAccount } from './services/helpers/deleteAccount.helper.js';

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
        // convert stored avatar base url to sized urls for client usage
        ...(user.avatarUrl ? { avatarUrls: buildImageUrls(user.avatarUrl, 'avatar') } : {}),
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

  const publicId = makePublicId({ kind: 'avatar', userId: args.userId });

  const safeStream = await requireNonEmptyStream(args.avatar.file, 'AVATAR_STREAM_ERROR');

  return overwriteImage({
    publicId,
    file: safeStream,
    mimetype: args.avatar.mimetype,
    ...(args.avatar.filename ? { filename: args.avatar.filename } : {}),
    tags: ['avatar', `user:${args.userId}`],
  });
}

async function updateMe({
  userId,
  userRole,
  name,
  locale,
  phone,
  avatarUploaded,
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

  // apply uploaded avatar identifiers (cloudinary upload is done elsewhere)
  if (avatarUploaded) {
    data.publicId = avatarUploaded.publicId;
    data.avatarUrl = avatarUploaded.urlBase;
  }

  // reject empty updates to avoid silent no-op
  if (!Object.keys(data).length) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: id, role });

      // update profile fields under rls
      const user = await tx.user.update({
        where: { id },
        data,
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
        ...(user.avatarUrl ? { avatarUrls: buildImageUrls(user.avatarUrl, 'avatar') } : {}),
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
        reviews,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // rls hides a deleted account from its owner for changes; its access token still works for
    // a few minutes after the deletion
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError('USER_NOT_FOUND');
    }

    throw new InternalError({ reason: 'USERS_UPDATE_ME_UNEXPECTED' }, err);
  }
}

async function findById({
  actorId,
  actorRole,
  userId,
}: FindUserByIdDto): Promise<UserByIdResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard invalid id
  if (!Number.isInteger(id)) throw new BadRequestError('USER_ID_INVALID');

  try {
    return await prisma.$transaction(async (tx) => {
      // the db function serves only a signed-in actor, so it needs the actor context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // read minimal profile via security definer and keep rls rules in db;
      // the function also returns the email, it is left out here: a public profile has no email,
      // a user sees their own one in /users/me
      const rows = await tx.$queryRaw<
        Array<{
          id: number;
          createdAt: Date;
          updatedAt: Date;
          name: string | null;
          avatarUrl: string | null;
        }>
      >`
        select
          id,
          created_at as "createdAt",
          updated_at as "updatedAt",
          name,
          avatar_url as "avatarUrl"
        from cartlify.users_get_public_profile(${id}::int)
        limit 1
      `;

      const user = rows[0] ?? null;

      // hide rls-missed rows as not found
      if (!user) throw new NotFoundError('USER_NOT_FOUND');

      // a user cannot read the deletion mark of another account under rls, the server reads it as
      // the system; a deleted account is gone for everyone but an admin, as if it never was
      const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';
      if (!isAdmin) await setAdminContext(tx);

      const { deletedAt } = await tx.user.findUniqueOrThrow({
        where: { id },
        select: { deletedAt: true },
      });

      if (deletedAt && !isAdmin) throw new NotFoundError('USER_NOT_FOUND');

      // build final public response
      return {
        id: user.id,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrls: buildImageUrls(user.avatarUrl, 'avatar') } : {}),
        // only an admin gets here with a deleted account
        ...(deletedAt ? { deletedAt } : {}),
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
  findMe,
  beginAvatarUpload,
  updateMe,
  findById,
  deleteUserById,
  deleteMe,
};
