import { prisma } from '@db/client.js';
import {
  AppError,
  UnauthorizedError,
  isAppError,
  BadRequestError,
  NotFoundError,
} from '@utils/errors.js';
import { setUserContext, setAdminContext } from '@db/dbContext.service.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { makePublicId, overwriteImage } from '@utils/cloudinary.util.js';

import type {
  FindUserByIdDto,
  FindMeByIdDto,
  UpdateMeDto,
  UserResponseDto,
  UserReviewResponseDto,
  UserByIdResponseDto,
} from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';

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
    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`users.findMe: unexpected (${msg})`, 500);
  }
}

async function updateMe({
  userId,
  name,
  avatar,
  locale,
  phone,
}: UpdateMeDto): Promise<UserResponseDto> {
  // normalize user id from dto
  const id = typeof userId === 'string' ? Number(userId) : userId;
  // guard against unauthenticated/invalid context
  if (!Number.isInteger(id)) throw new UnauthorizedError('LOGIN_REQUIRED');

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

  const phoneRaw = readStr(phone);
  if (phoneRaw !== undefined) {
    const v = phoneRaw.trim();
    data.phone = v ? v : null;
  }

  // detect multipart file field
  const filePart = avatar as any;
  const hasAvatar =
    typeof filePart === 'object' &&
    filePart !== null &&
    typeof filePart.mimetype === 'string' &&
    filePart.file;

  // reject empty updates to avoid silent no-op
  if (!hasAvatar && !Object.keys(data).length) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // upload avatar outside tx to avoid external calls inside db transaction
  let uploaded: { publicId: string; urlBase: string } | null = null;

  try {
    if (hasAvatar) {
      // ensure user exists before uploading to avoid orphan images
      await prisma.$transaction(async (tx) => {
        await setUserContext(tx, { userId: id, role: 'USER' });

        const exists = await tx.user.findUnique({
          where: { id },
          select: { id: true },
        });

        if (!exists) throw new AppError('User not found', 500);
      });

      // use stable public id to keep one avatar per user
      const publicId = makePublicId({ kind: 'avatar', userId: id });

      uploaded = await overwriteImage({
        publicId,
        file: filePart.file,
        mimetype: filePart.mimetype,
        filename: typeof filePart.filename === 'string' ? filePart.filename : undefined,
        tags: ['avatar', `user:${id}`],
      });

      // persist avatar fields in the same update call
      data.publicId = uploaded.publicId;
      data.avatarUrl = uploaded.urlBase;
    }

    return await prisma.$transaction(async (tx) => {
      // set db session context for RLS policies
      await setUserContext(tx, { userId: id, role: 'USER' });

      // update profile fields under RLS
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

      // map db shape to api dto, trimming comment and normalizing userVote values
      const reviews = rows
        .map((r) => {
          const comment = (r.comment ?? '').trim();
          if (!comment) return null;

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
    // preserve known app errors and map everything else to a generic 500
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

export const usersServices = {
  findMe,
  updateMe,
  findById,
};
