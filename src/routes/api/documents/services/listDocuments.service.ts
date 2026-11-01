import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { decodeCursor, encodeCursor, type CursorPayload } from '@helpers/codeCursor.js';
import { likePattern } from '@helpers/likePattern.js';

import { documentSelect, mapDocumentRow, usageOf } from './helpers/documents.helper.js';

import type { DocumentsListResponseDto, ListDocumentsDto } from 'types/dto/documents.dto.js';

type DocumentsCursor = CursorPayload & { s?: unknown };

// the documents of the directory by title, letter case ignored, with the number of products that
// name each. The cursor holds the lowered title of the last row and the order it was made in, so a
// cursor of another order is refused
export async function listDocuments({
  actorId,
  actorRole,
  limit,
  cursor,
  q,
  kind,
  sortOrder,
}: ListDocumentsDto): Promise<DocumentsListResponseDto> {
  assertAdminActor(actorId, actorRole);

  const sortKey = `title:${sortOrder}`;
  const direction = sortOrder === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

  let after: { id: number; title: string } | null = null;
  if (cursor) {
    const payload = decodeCursor(cursor) as DocumentsCursor;
    if (payload.s !== sortKey || typeof payload.v !== 'string') {
      throw new BadRequestError('CURSOR_INVALID');
    }
    after = { id: payload.id, title: payload.v };
  }

  const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q) filters.push(Prisma.sql`d.title ILIKE ${likePattern(q)}`);
  if (kind) filters.push(Prisma.sql`d.kind = ${kind}::cartlify."DocumentKind"`);
  const where = Prisma.join(filters, ' AND ');

  const past = after
    ? sortOrder === 'desc'
      ? Prisma.sql`AND (lower(d.title), d.id) < (${after.title}::text, ${after.id}::int)`
      : Prisma.sql`AND (lower(d.title), d.id) > (${after.title}::text, ${after.id}::int)`
    : Prisma.empty;

  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const found = await tx.$queryRaw<{ id: number; key: string }[]>(Prisma.sql`
        SELECT d.id, lower(d.title) AS key
        FROM cartlify.documents d
        WHERE ${where} ${past}
        ORDER BY lower(d.title) ${direction}, d.id ${direction}
        LIMIT ${limit + 1}
      `);
      const [{ total }] = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT count(*)::int AS total FROM cartlify.documents d WHERE ${where}
      `);

      const page = found.slice(0, limit);
      const rows = await tx.document.findMany({
        where: { id: { in: page.map((row) => row.id) } },
        select: documentSelect,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const usage = await usageOf(
        tx,
        page.map((row) => row.id),
      );

      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          ...mapDocumentRow(byId.get(row.id)!),
          usage: usage.get(row.id)!,
        })),
        total,
        limit,
        nextCursor:
          found.length > limit && last
            ? encodeCursor({ id: last.id, v: last.key, s: sortKey } as CursorPayload)
            : null,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'DOCUMENTS_LIST_UNEXPECTED' }, err);
  }
}
