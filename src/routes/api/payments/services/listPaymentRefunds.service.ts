import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { utcTime } from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import { BadRequestError } from '@utils/errors.js';

import { shopCurrency } from '../providers/index.js';
import { waitingRefunds, type WaitingRefundRow } from './helpers/waitingRefunds.helper.js';

import type {
  GetPaymentRefundsResponseDto,
  ListPaymentRefundsDto,
  PaymentRefundItemDto,
} from 'types/dto/payments.dto.js';

// The refunds that wait for the shop (GET /api/payments/refunds), for an admin or root: the money
// that did not reach a buyer (failed) and the refunds of late payments whose money was not told
// sent (unsent), the oldest first, a page at a time with a cursor and the total of the filter. The
// alerts failed_refunds and refunded_payments_not_sent name this list with the filters of their
// cases (alerts.service.ts), so the count of an alert is the total of its list

// a page after the row: the time, the source (statements before payments) and the number order the
// rows, and the cursor holds all three
const cursorOf = (row: WaitingRefundRow) =>
  encodeCursor({ id: row.num, v: `${row.at.toISOString()}|${row.rank}` });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// the cursor comes back from the client: one of this list, with a time and a source that fit
function cursorWhere(cursor: string | undefined): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const { id, v } = decodeCursor(cursor);
  const [at, rank, ...rest] = typeof v === 'string' ? v.split('|') : [];
  const date = at && ISO.test(at) ? new Date(at) : null;

  if (rest.length || !date || Number.isNaN(date.getTime()) || (rank !== '0' && rank !== '1')) {
    throw new BadRequestError('CURSOR_INVALID');
  }

  return Prisma.sql`(t."at", t.rank, t.num) > (${utcTime(date)}, ${Number(rank)}::int, ${id}::int)`;
}

const itemOf = (row: WaitingRefundRow): PaymentRefundItemDto => ({
  id: row.id,
  source: row.source,
  orderId: row.orderId,
  userId: row.userId,
  returnId: row.returnId,
  provider: row.provider,
  paymentId: row.paymentId,
  refundId: row.refundId,
  amount: row.amount === null ? null : Number(row.amount),
  // a statement is paid back in the currency of the shop, a payment in its own
  currency: row.source === 'return' ? shopCurrency() : row.currency,
  failure: row.failure,
  failureText: row.failureText,
  at: row.at.toISOString(),
});

export async function listPaymentRefunds(
  args: ListPaymentRefundsDto,
): Promise<GetPaymentRefundsResponseDto> {
  assertAdminActor(args.actorId, args.actorRole);

  const filters: Prisma.Sql[] = [Prisma.sql`true`];
  if (args.userId !== undefined) filters.push(Prisma.sql`t."userId" = ${args.userId}::int`);
  if (args.orderId !== undefined) filters.push(Prisma.sql`t."orderId" = ${args.orderId}::int`);
  if (args.to) filters.push(Prisma.sql`t."at" < ${utcTime(args.to)}`);
  const where = Prisma.join(filters, ' and ');
  const rows = waitingRefunds(args.state, Date.now());

  const { page, total } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const page = await db.$queryRaw<WaitingRefundRow[]>(Prisma.sql`
        select t.* from (${rows}) as t
        where ${where} and ${cursorWhere(args.cursor)}
        order by t."at" asc, t.rank asc, t.num asc
        limit ${args.limit + 1}
      `);
      const [count] = await db.$queryRaw<{ total: number }[]>(Prisma.sql`
        select count(*)::int as total from (${rows}) as t where ${where}
      `);

      return { page, total: count?.total ?? 0 };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const hasNext = page.length > args.limit;
  const items = hasNext ? page.slice(0, args.limit) : page;

  return {
    items: items.map(itemOf),
    total,
    limit: args.limit,
    nextCursor: hasNext ? cursorOf(items.at(-1)!) : null,
  };
}
