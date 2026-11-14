import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { returnCodeOf } from '@helpers/returns.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { utcTime } from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import { BadRequestError } from '@utils/errors.js';

import {
  moneyRefundConditions,
  moneyRefundsOf,
  returnsLeftOf,
  type MoneyRefundRow,
} from './helpers/moneyRefunds.helper.js';

import type {
  GetPaymentRefundsResponseDto,
  ListPaymentRefundsDto,
  PaymentRefundItemDto,
} from 'types/dto/payments.dto.js';

// The refunds of the money journal (GET /api/payments/refunds), for an admin or root: the refunds of
// the statements, of what is left after a dispute, of the late payments and the ones made by hand
// in the dashboard of the provider, with where each stands, the oldest state first, a page at a time
// with a cursor and the total of the filter. The alerts of the refunds name this list with the
// filters of their cases (alerts.service.ts), so the count of an alert is the total of its list

// a page after the row: the time it came to its state and its id order the rows, the cursor holds
// both
const cursorOf = (row: MoneyRefundRow) => encodeCursor({ id: row.id, v: row.at.toISOString() });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// the cursor comes back from the client: one of this list, with a time that fits
function cursorWhere(cursor: string | undefined): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const { id, v } = decodeCursor(cursor);
  const date = typeof v === 'string' && ISO.test(v) ? new Date(v) : null;

  if (!date || Number.isNaN(date.getTime())) throw new BadRequestError('CURSOR_INVALID');

  return Prisma.sql`(t."at", t.id) > (${utcTime(date)}, ${id}::int)`;
}

// left: what the open statements of the answer still have to send (returnsLeftOf)
export const refundItemOf = (
  row: MoneyRefundRow,
  left: Map<number, string> = new Map(),
): PaymentRefundItemDto => ({
  id: row.id,
  purpose: row.purpose,
  state: row.state,
  need: row.need,
  orderId: row.orderId,
  userId: row.userId,
  returnId: row.returnId,
  returnCode:
    row.returnId !== null && row.orderId !== null && row.returnNumber !== null && row.returnBasis
      ? returnCodeOf(row.returnBasis, row.orderId, row.returnNumber)
      : null,
  provider: row.provider,
  paymentId: row.paymentId,
  refundId: row.refundId,
  amount: Number(row.amount),
  currency: row.currency,
  failure: row.failure,
  failureText: row.failureText,
  bankReference: row.bankReference,
  byDashboard: row.byDashboard,
  createdAt: row.createdAt.toISOString(),
  at: row.at.toISOString(),
  paymentLeft: row.paymentLeft === null ? null : Number(row.paymentLeft),
  returnLeft:
    row.returnId !== null && left.has(row.returnId) ? Number(left.get(row.returnId)) : null,
});

export async function listPaymentRefunds(
  args: ListPaymentRefundsDto,
): Promise<GetPaymentRefundsResponseDto> {
  assertAdminActor(args.actorId, args.actorRole);

  const where = moneyRefundConditions({
    purpose: args.purpose,
    state: args.state,
    need: args.need,
    userId: args.userId,
    orderId: args.orderId,
    from: args.from,
    to: args.to,
  });

  // the refunds of the purpose asked for only (the same rows, fewer lines read)
  const refunds = moneyRefundsOf(args.purpose);

  const { page, total, left } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const page = await db.$queryRaw<MoneyRefundRow[]>(Prisma.sql`
        select t.* from ${refunds} as t
        where ${where} and ${cursorWhere(args.cursor)}
        order by t."at" asc, t.id asc
        limit ${args.limit + 1}
      `);
      const [count] = await db.$queryRaw<{ total: number }[]>(Prisma.sql`
        select count(*)::int as total from ${refunds} as t where ${where}
      `);

      // what the open statements of the page still have to send
      const left = await returnsLeftOf(db, page.slice(0, args.limit));

      return { page, total: count?.total ?? 0, left };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const hasNext = page.length > args.limit;
  const items = hasNext ? page.slice(0, args.limit) : page;

  return {
    items: items.map((row) => refundItemOf(row, left)),
    total,
    limit: args.limit,
    nextCursor: hasNext ? cursorOf(items.at(-1)!) : null,
  };
}
