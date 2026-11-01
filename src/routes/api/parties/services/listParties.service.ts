import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { decodeCursor, encodeCursor, type CursorPayload } from '@helpers/codeCursor.js';
import { likePattern } from '@helpers/likePattern.js';

import { mapPartyRow, partySelect, usageOf } from './helpers/parties.helper.js';

import type { ListPartiesDto, PartiesListResponseDto } from 'types/dto/parties.dto.js';

type PartiesCursor = CursorPayload & { s?: unknown };

// the parties of the directory by name, letter case ignored, with the number of products that name
// each. The cursor holds the lowered name of the last row and the order it was made in, so a
// cursor of another order is refused
export async function listParties({
  actorId,
  actorRole,
  limit,
  cursor,
  q,
  country,
  sortOrder,
}: ListPartiesDto): Promise<PartiesListResponseDto> {
  assertAdminActor(actorId, actorRole);

  const sortKey = `name:${sortOrder}`;
  const direction = sortOrder === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

  let after: { id: number; name: string } | null = null;
  if (cursor) {
    const payload = decodeCursor(cursor) as PartiesCursor;
    if (payload.s !== sortKey || typeof payload.v !== 'string') {
      throw new BadRequestError('CURSOR_INVALID');
    }
    after = { id: payload.id, name: payload.v };
  }

  const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q) {
    const pattern = likePattern(q);
    filters.push(
      Prisma.sql`(p.name ILIKE ${pattern} OR p.address ILIKE ${pattern} OR p.email ILIKE ${pattern})`,
    );
  }
  if (country) filters.push(Prisma.sql`p.country = ${country.toUpperCase()}`);
  const where = Prisma.join(filters, ' AND ');

  const past = after
    ? sortOrder === 'desc'
      ? Prisma.sql`AND (lower(p.name), p.id) < (${after.name}::text, ${after.id}::int)`
      : Prisma.sql`AND (lower(p.name), p.id) > (${after.name}::text, ${after.id}::int)`
    : Prisma.empty;

  try {
    return await prisma.$transaction(async (tx) => {
      // the products taken out of the catalog are counted too, which an admin reads
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const found = await tx.$queryRaw<{ id: number; key: string }[]>(Prisma.sql`
        SELECT p.id, lower(p.name) AS key
        FROM cartlify.parties p
        WHERE ${where} ${past}
        ORDER BY lower(p.name) ${direction}, p.id ${direction}
        LIMIT ${limit + 1}
      `);
      const [{ total }] = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT count(*)::int AS total FROM cartlify.parties p WHERE ${where}
      `);

      const page = found.slice(0, limit);
      const rows = await tx.party.findMany({
        where: { id: { in: page.map((row) => row.id) } },
        select: partySelect,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const usage = await usageOf(
        tx,
        page.map((row) => row.id),
      );

      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          ...mapPartyRow(byId.get(row.id)!),
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
    throw new InternalError({ reason: 'PARTIES_LIST_UNEXPECTED' }, err);
  }
}
