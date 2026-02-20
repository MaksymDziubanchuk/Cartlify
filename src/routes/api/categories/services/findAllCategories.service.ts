import { prisma } from '@db/client.js';
import { AppError, isAppError } from '@utils/errors.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';

import type {
  FindAllCategoriesDto,
  CategoriesListResponseDto,
  CategoryResponseDto,
} from 'types/dto/categories.dto.js';

function mapCategoryRowToResponse(row: {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
  createdAt: Date;
  updatedAt: Date;
}): CategoryResponseDto {
  // map db nullables into optional api fields
  return {
    id: row.id as any,
    name: row.name,
    slug: row.slug,
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.parentId != null ? { parentId: row.parentId as any } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findAllCategories(
  dto: FindAllCategoriesDto,
): Promise<CategoriesListResponseDto> {
  // normalize query inputs into stable primitives
  const limit = assertLimit(dto.limit ?? 50);

  const cursor =
    typeof dto.cursor === 'string' && dto.cursor.trim() ? dto.cursor.trim() : undefined;
  const search =
    typeof dto.search === 'string' && dto.search.trim() ? dto.search.trim() : undefined;

  const parentId =
    dto.parentId != null
      ? (() => {
          const n = Number(dto.parentId);
          if (!Number.isInteger(n) || n <= 0) throw new AppError('CATEGORY_PARENT_ID_INVALID', 400);
          return n;
        })()
      : undefined;

  // build base filters
  const where: any = {};

  if (parentId != null) where.parentId = parentId;

  if (search) {
    // keep search as broad match for name or slug
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }

  // build keyset cursor filter for name desc + id desc ordering
  const cRaw = cursor ? decodeCursor(cursor) : undefined;

  const c =
    cRaw && typeof cRaw.v === 'string' && cRaw.v.length
      ? { id: cRaw.id, name: cRaw.v }
      : cRaw
        ? (() => {
            throw new AppError('CURSOR_INVALID', 400);
          })()
        : undefined;

  const cursorWhere = c
    ? {
        OR: [{ name: { lt: c.name } }, { AND: [{ name: c.name }, { id: { lt: c.id } }] }],
      }
    : undefined;

  const finalWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

  try {
    // fetch one extra row to detect next page
    const rows = await prisma.category.findMany({
      where: finalWhere,
      orderBy: [{ name: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        parentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // compute next cursor using last item of the current page
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const last = pageRows.length ? pageRows[pageRows.length - 1] : null;

    return {
      items: pageRows.map(mapCategoryRowToResponse),
      limit,
      ...(hasNext && last ? { nextCursor: encodeCursor({ id: last.id, v: last.name }) } : {}),
    };
  } catch (err) {
    // keep app errors unchanged and wrap unknown failures
    if (isAppError(err)) throw err;

    throw new AppError(`categories.findAll: unexpected`, 500);
  }
}
