import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { holdsOf } from '@helpers/orderHolds.js';
import { returnCodeOf } from '@helpers/returns.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { utcTime } from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';

import { DISPUTE_ENDED_STATUSES } from './helpers/moneyHeld.helper.js';

import type {
  DisputeCardDto,
  DisputeItemDto,
  GetDisputeDto,
  GetDisputesResponseDto,
  ListDisputesDto,
} from 'types/dto/payments.dto.js';

// The disputes of the payments at the bank, inquiries included (GET /api/payments/disputes and its
// card), for an admin or root: the state as the app follows it from the provider, what the dispute
// took less what it gave back, whether a statement of its order is open; the nearest due first (a
// dispute with no date due last), a page at a time with a cursor and the total of the filter. The
// alerts of the disputes name this list

// the states that end a dispute
const ENDED: readonly string[] = DISPUTE_ENDED_STATUSES;

// the date due a dispute is sorted by: one without a date goes after every other
const DUE = Prisma.sql`coalesce(d."evidenceDueBy", '9999-12-31 00:00:00'::timestamp)`;

type DisputeRow = {
  id: number;
  provider: string;
  stripeId: string;
  paymentId: string;
  orderId: number | null;
  userId: number | null;
  late: boolean;
  reason: string | null;
  status: string;
  evidenceDueBy: Date | null;
  hasEvidence: boolean;
  submissionCount: number;
  isChargeRefundable: boolean;
  withdrawn: string;
  returnOpen: boolean;
  openedAt: Date;
  closedAt: Date | null;
  draftedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  due: Date;
};

const ROWS = Prisma.sql`
  select d.id, d.provider::text as provider, d."stripeId", d."paymentId", d."orderId", d."userId",
    not exists (
      select 1 from cartlify.orders as o where o.id = d."orderId" and o."paymentId" = d."paymentId"
    ) as late,
    d.reason, d.status::text as status, d."evidenceDueBy", d."hasEvidence", d."submissionCount",
    d."isChargeRefundable",
    to_char(coalesce((
      select -sum(l.amount) from cartlify.money_log as l where l."disputeId" = d.id
    ), 0), 'FM99999999990.00') as withdrawn,
    exists (
      select 1 from cartlify.returns as r where r."orderId" = d."orderId" and r."closedAt" is null
    ) as "returnOpen",
    d."openedAt", d."closedAt", d."draftedAt", d."createdAt", d."updatedAt",
    ${DUE} as due
  from cartlify.payment_disputes as d
`;

const itemOf = (row: DisputeRow): DisputeItemDto => ({
  id: row.id,
  provider: row.provider,
  stripeId: row.stripeId,
  paymentId: row.paymentId,
  orderId: row.orderId,
  userId: row.userId,
  late: row.late,
  reason: row.reason,
  status: row.status as DisputeItemDto['status'],
  open: !ENDED.includes(row.status),
  evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
  hasEvidence: row.hasEvidence,
  submissionCount: row.submissionCount,
  isChargeRefundable: row.isChargeRefundable,
  withdrawn: Number(row.withdrawn),
  returnOpen: row.returnOpen,
  openedAt: row.openedAt.toISOString(),
  closedAt: row.closedAt?.toISOString() ?? null,
  draftedAt: row.draftedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// the cursor comes back from the client: one of this list, with a date that fits
function cursorWhere(cursor: string | undefined): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const { id, v } = decodeCursor(cursor);
  const date = typeof v === 'string' && ISO.test(v) ? new Date(v) : null;
  if (!date || Number.isNaN(date.getTime())) throw new BadRequestError('CURSOR_INVALID');

  return Prisma.sql`(${DUE}, d.id) > (${utcTime(date)}, ${id}::int)`;
}

export type DisputeFilters = Pick<
  ListDisputesDto,
  'statuses' | 'open' | 'toAnswer' | 'closedFrom' | 'orderId' | 'moneyUndecided'
>;

// the conditions of the filters on the disputes under the alias, all of which a dispute meets; the
// alerts of the disputes count their cases with them (alerts.service.ts), so the count of an alert is
// the total of this list
export function disputeConditions(args: DisputeFilters, alias = 'd'): Prisma.Sql {
  const d = Prisma.raw(alias);
  const where: Prisma.Sql[] = [Prisma.sql`true`];

  if (args.statuses?.length) {
    where.push(Prisma.sql`${d}.status::text in (${Prisma.join(args.statuses)})`);
  }
  if (args.open === true) {
    where.push(Prisma.sql`${d}.status::text not in (${Prisma.join(ENDED)})`);
  }
  if (args.open === false) where.push(Prisma.sql`${d}.status::text in (${Prisma.join(ENDED)})`);
  if (args.toAnswer) {
    where.push(
      Prisma.sql`${d}.status::text not in (${Prisma.join(ENDED)}) and ${d}."submissionCount" = 0`,
    );
  }
  if (args.closedFrom) where.push(Prisma.sql`${d}."closedAt" >= ${utcTime(args.closedFrom)}`);
  if (args.orderId !== undefined) where.push(Prisma.sql`${d}."orderId" = ${args.orderId}::int`);
  // what the bank took waits for root to say what it was for (RETURN_BANK_MONEY_PENDING)
  if (args.moneyUndecided !== undefined) {
    const undecided = Prisma.sql`exists (
      select 1 from cartlify.money_log as ul
      where ul."disputeId" = ${d}.id and ul.event = 'money.dispute_withdrawn' and ul."moneyUse" is null
    )`;
    where.push(args.moneyUndecided ? undecided : Prisma.sql`not ${undecided}`);
  }

  return Prisma.join(where, ' and ');
}

export async function listDisputes(args: ListDisputesDto): Promise<GetDisputesResponseDto> {
  assertAdminActor(args.actorId, args.actorRole);

  const where = disputeConditions(args);

  const { page, total } = await tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const page = await db.$queryRaw<DisputeRow[]>(Prisma.sql`
        ${ROWS}
        where ${where} and ${cursorWhere(args.cursor)}
        order by ${DUE} asc, d.id asc
        limit ${args.limit + 1}
      `);
      const [count] = await db.$queryRaw<{ total: number }[]>(Prisma.sql`
        select count(*)::int as total from cartlify.payment_disputes as d where ${where}
      `);

      return { page, total: count?.total ?? 0 };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  const hasNext = page.length > args.limit;
  const items = hasNext ? page.slice(0, args.limit) : page;
  const last = items.at(-1);

  return {
    items: items.map(itemOf),
    total,
    limit: args.limit,
    nextCursor: hasNext && last ? encodeCursor({ id: last.id, v: last.due.toISOString() }) : null,
  };
}

// the card of a dispute: its state, the money it moved (the lines of the money journal), the order
// and the statements of the order
export async function getDispute({
  actorId,
  actorRole,
  disputeId,
}: GetDisputeDto): Promise<DisputeCardDto> {
  assertAdminActor(actorId, actorRole);

  return tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });

    const [row] = await db.$queryRaw<DisputeRow[]>(Prisma.sql`
      ${ROWS} where d.id = ${disputeId}::int
    `);
    if (!row) throw new NotFoundError('DISPUTE_NOT_FOUND');

    const money = await db.moneyLog.findMany({
      where: { disputeId: row.id },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        event: true,
        amount: true,
        currency: true,
        stripeTxId: true,
        moneyUse: true,
        createdAt: true,
      },
    });

    const order = row.orderId
      ? await db.order.findUnique({
          where: { id: row.orderId },
          select: { id: true, status: true, total: true, holds: true },
        })
      : null;

    const statements = row.orderId
      ? await db.orderReturn.findMany({
          where: { orderId: row.orderId },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            orderId: true,
            number: true,
            basis: true,
            reason: true,
            refundedTotal: true,
            closedAt: true,
          },
        })
      : [];

    // what the open statements still owe: what root weighs when it says what the money of the
    // bank was for
    const open = statements.filter((statement) => statement.closedAt === null).map(({ id }) => id);
    const left = new Map<number, string>();
    if (open.length > 0) {
      const counted = await db.$queryRaw<{ id: number; left: string }[]>(Prisma.sql`
        select r.id, cartlify.return_money_left(r.id) ->> 'total' as left
        from cartlify.returns as r
        where r.id = any(${open}::int[])
      `);
      for (const one of counted) left.set(one.id, one.left);
    }

    return {
      ...itemOf(row),
      money: money.map((line) => ({
        ...line,
        amount: decimalToNumber(line.amount),
        createdAt: line.createdAt.toISOString(),
      })),
      order: order
        ? {
            id: order.id,
            status: order.status,
            total: decimalToNumber(order.total),
            holds: holdsOf(order.holds),
          }
        : null,
      returns: statements.map((statement) => ({
        id: statement.id,
        code: returnCodeOf(statement.basis, statement.orderId, statement.number),
        reason: statement.reason,
        refundedTotal: decimalToNumber(statement.refundedTotal),
        moneyLeft: left.has(statement.id) ? Number(left.get(statement.id)) : null,
        closedAt: statement.closedAt?.toISOString() ?? null,
      })),
    };
  });
}
