import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { assertEmail } from '@helpers/validateEmail.js';

import { buildImageUrls } from '@utils/cloudinary.util.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import type { FindAdminsDto, GetAdminsResponseDto } from 'types/dto/root.dto.js';

export async function findAdmins(dto: FindAdminsDto): Promise<GetAdminsResponseDto> {
  // normalize limit and inputs
  const limit = assertLimit(dto.limit);

  const cursor =
    typeof dto.cursor === 'string' && dto.cursor.trim() ? dto.cursor.trim() : undefined;

  const search =
    typeof dto.search === 'string' && dto.search.trim() ? dto.search.trim() : undefined;

  // decode and validate cursor payload
  const cRaw = cursor ? decodeCursor(cursor) : undefined;

  const c =
    cRaw && typeof cRaw.v === 'string' && cRaw.v.length
      ? (() => {
          const d = new Date(cRaw.v);
          if (Number.isNaN(d.getTime())) throw new BadRequestError('CURSOR_INVALID');
          return { id: cRaw.id, createdAt: d };
        })()
      : cRaw
        ? (() => {
            throw new BadRequestError('CURSOR_INVALID');
          })()
        : undefined;

  // build keyset cursor where (createdAt desc, id desc)
  const cursorWhere = c
    ? {
        OR: [
          { createdAt: { lt: c.createdAt } },
          {
            AND: [{ createdAt: c.createdAt }, { id: { lt: c.id } }],
          },
        ],
      }
    : undefined;

  // build base where (admins only + optional search)
  const baseWhere: any = { role: 'ADMIN' };

  if (search) {
    // search matches either email or name
    baseWhere.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  // apply cursor as additional AND filter
  const where = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;

  try {
    return await prisma.$transaction(async (tx) => {
      // set actor context for rls inside this transaction
      await setUserContext(tx, {
        userId: dto.actorId,
        role: dto.actorRole,
      });

      // fetch limit + 1 to detect next page
      const rows = await tx.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
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

      // total count for the same base filter (without cursor window)
      const total = await tx.user.count({
        where: baseWhere,
      });

      // slice to requested page size
      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;

      // build next cursor from last row
      const last = pageRows.length ? pageRows[pageRows.length - 1] : null;

      const nextCursor =
        hasNext && last
          ? encodeCursor({
              id: last.id,
              v: last.createdAt.toISOString(),
            })
          : null;

      // map db rows to response dto
      const items = pageRows.map((u) => {
        assertEmail(u.email);

        return {
          id: u.id as any,
          email: u.email,
          role: u.role,
          isVerified: u.isVerified,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          ...(u.name ? { name: u.name } : {}),
          ...(u.avatarUrl
            ? {
                avatarUrls: buildImageUrls(u.avatarUrl, 'avatar'),
              }
            : {}),
          ...(u.locale ? { locale: u.locale } : {}),
          ...(u.phone ? { phone: u.phone } : {}),
        };
      });

      return {
        items,
        limit,
        nextCursor,
        total,
      };
    });
  } catch (err) {
    // rethrow known app errors and wrap unexpected ones
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'ROOT_ADMINS_FIND_UNEXPECTED' }, err);
  }
}
