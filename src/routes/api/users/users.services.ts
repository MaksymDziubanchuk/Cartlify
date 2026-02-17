import { prisma } from '@db/client.js';
import {
  AppError,
  UnauthorizedError,
  isAppError,
  BadRequestError,
  NotFoundError,
} from '@utils/errors.js';
import { setUserContext, setAdminContext } from '@db/dbContext.service.js';
import { assertEmail } from '@helpers/validateEmail.js';
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
} from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserId } from 'types/ids.js';

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
      if (!user) throw new AppError('User not found', 500);

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

          // derive current user's vote from enum stored in review_votes
          const action = r.votes[0]?.action;
          const userVote = action === 'UP' ? 'up' : action === 'DOWN' ? 'down' : null;

          return {
            id: r.id as any,
            productId: r.productId as any,

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
    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`users.findMe: unexpected (${msg})`, 500);
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
    throw new AppError('ACTOR_ROLE_INVALID', 500);
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

  const normalizePhone = (input: string): string => {
    const cleaned = input.trim().replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) throw new BadRequestError('PHONE_INVALID');
    return cleaned;
  };

  // build partial update payload for db
  const data: Record<string, unknown> = {};

  const nameRaw = readStr(name);
  if (nameRaw !== undefined) {
    const v = nameRaw.trim();
    data.name = v ? v : null;
  }

  const localeRaw = readStr(locale);
  if (localeRaw !== undefined) {
    const v = localeRaw.trim();
    data.locale = v ? v : null;
  }

  // clear phone explicitly
  if (phone === null) {
    data.phone = null;
  } else {
    const phoneRaw = readStr(phone);
    if (phoneRaw !== undefined) {
      const v = phoneRaw.trim();
      data.phone = v ? normalizePhone(v) : null;
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

          const action = r.votes[0]?.action;
          const userVote = action === 'UP' ? 'up' : action === 'DOWN' ? 'down' : null;

          return {
            id: r.id as any,
            productId: r.productId as any,
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

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`users.updateMe: unexpected (${msg})`, 500);
  }
}

async function findById({ userId }: FindUserByIdDto): Promise<UserByIdResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard invalid id
  if (!Number.isInteger(id)) throw new BadRequestError('USER_ID_INVALID');

  try {
    return await prisma.$transaction(async (tx) => {
      // use guest context for public profile reads
      await setAdminContext(tx);

      // select only public profile fields
      const user = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          createdAt: true,
          updatedAt: true,
          name: true,
          avatarUrl: true,
        },
      });

      // hide rls-missed rows as not found
      if (!user) throw new NotFoundError('USER_NOT_FOUND');

      // validate email format before returning it to client
      assertEmail(user.email);

      // build final public response
      return {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrls: buildImageUrls(user.avatarUrl, 'avatar') } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`users.findById: unexpected (${msg})`, 500);
  }
}

async function deleteUserById({ actorId, userId }: DeleteUserByIdDto): Promise<MessageResponseDto> {
  // normalize ids
  const rootId = typeof actorId === 'string' ? Number(actorId) : actorId;
  const targetId = typeof userId === 'string' ? Number(userId) : userId;

  // guard invalid input
  if (!Number.isInteger(targetId) || targetId <= 0) throw new BadRequestError('USER_ID_INVALID');

  // avoid locking yourself out
  if (targetId === rootId) throw new AppError('ROOT_CANNOT_DELETE_SELF', 409);

  try {
    await prisma.$transaction(async (tx) => {
      // apply root db context for rls
      await setUserContext(tx, { userId: rootId, role: 'ROOT' });

      // ensure target exists
      const target = await tx.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true },
      });

      if (!target) throw new NotFoundError('USER_NOT_FOUND');

      // keep previous email "visible" but safe for email format and length
      const prevTag = target.email
        .toLowerCase()
        .replace(/@/g, '_at_')
        .replace(/[^a-z0-9_]+/g, '_')
        .slice(0, 32);

      const deletedEmail = `deleted+${targetId}+${prevTag}@deleted.com`;

      // revoke all tokens for this user
      await tx.userToken.deleteMany({ where: { userId: targetId } });

      // anonymize pii and disable verification
      await tx.user.update({
        where: { id: targetId },
        data: {
          email: deletedEmail,
          passwordHash: null,
          authProvider: 'LOCAL',
          providerSub: null,
          isVerified: false,
          name: null,
          avatarUrl: null,
          publicId: null,
          locale: null,
          phone: null,
        },
        select: { id: true },
      });
    });

    return { message: 'user deleted' };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`users.deleteUserById: unexpected (${msg})`, 500);
  }
}

export const usersServices = {
  findMe,
  beginAvatarUpload,
  updateMe,
  findById,
  deleteUserById,
};
