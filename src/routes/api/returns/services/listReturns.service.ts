import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError } from '@utils/errors.js';

import { REFUND_DAYS, returnCodeOf } from '@helpers/returns.js';

import { andOf, returnConditions, type ReturnFilters } from './helpers/returnFilters.helper.js';

import type {
  GetReturnsResponseDto,
  ReturnListItemDto,
  ReturnsSortBy,
  ReturnsSortDir,
} from 'types/dto/returns.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

export type ListReturnsDto = ReturnFilters & {
  actorId: UserId;
  actorRole: Role;
  limit: number;
  cursor?: string | undefined;
  sortBy: ReturnsSortBy;
  sortDir: ReturnsSortDir;
};

// The list of the statements of return for an admin or root (GET /api/returns): each statement with
// the sums of its rows by what became of the goods and of the money, filtered by what waits for
// the admin, sorted by the time it was stated, closed or changed or by its money, a page at a time
// with a cursor and the total of the filter. The alerts of the admins name this list with the
// filters of their cases (alerts.service.ts). format=csv gives every row of the filter.

const DAY = 86_400_000;

type Row = {
  id: number;
  orderId: number;
  number: number;
  statedAt: Date;
  source: ReturnListItemDto['source'];
  basis: ReturnListItemDto['basis'];
  reason: ReturnListItemDto['reason'];
  contactName: string;
  contactEmail: string;
  extendsId: number | null;
  closedAt: Date | null;
  updatedAt: Date;
  proofProvidedAt: Date | null;
  proofConfirmedAt: Date | null;
  acceptedAt: Date | null;
  orderStatus: string;
  returnStatus: ReturnListItemDto['order']['returnStatus'];
  userId: number;
  accountAlive: boolean;
  units: number;
  amount: Prisma.Decimal;
  refunded_amount: Prisma.Decimal;
  goods_expected: number;
  goods_received: number;
  goods_declined: number;
  money_not_refunded: number;
  money_pending: number;
  money_refunded: number;
  money_refused: number;
  failed: boolean;
  sv: Date | Prisma.Decimal;
};

// the value a sort goes by, in the inner select (sv); a statement not closed has the beginning of
// time for its closing, so it comes last of the newest first. The end of the days of the money is
// the statement and the days the law gives while some money is due and not back (on its way, or a
// failed transfer, too:
// the goods are in, or the proof of the parcel is confirmed), and the end of time for a statement
// that owes none yet, which comes last of the nearest first
const SORT_VALUE: Record<ReturnsSortBy, Prisma.Sql> = {
  statedAt: Prisma.sql`r."statedAt"`,
  closedAt: Prisma.sql`coalesce(r."closedAt", 'epoch'::timestamp)`,
  updatedAt: Prisma.sql`r."updatedAt"`,
  amount: Prisma.sql`a.amount`,
  moneyDeadline: Prisma.sql`case
    when exists (
      select 1 from cartlify.return_items as d
      where d."returnId" = r.id
        and d.money in (
          'not_refunded'::cartlify."ReturnMoney",
          'pending'::cartlify."ReturnMoney",
          'failed'::cartlify."ReturnMoney"
        )
        and (
          d.goods in (
            'to_stock'::cartlify."ReturnGoods",
            'written_off'::cartlify."ReturnGoods",
            'lost'::cartlify."ReturnGoods"
          )
          or (d.goods = 'expected'::cartlify."ReturnGoods" and exists (
            select 1 from cartlify.order_shipments as p
            where p."returnId" = r.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
              and p."confirmedAt" is not null
          ))
        )
    )
    then r."statedAt" + ${REFUND_DAYS}::int * interval '1 day'
    else '9999-12-31T00:00:00'::timestamp
  end`,
};

const isDateSort = (sortBy: ReturnsSortBy) => sortBy !== 'amount';

const selectOf = (sortBy: ReturnsSortBy) => Prisma.sql`
  select r.id, r."orderId", r.number, r."statedAt", r.source::text as source, r.basis::text as basis,
         r.reason::text as reason, r."contactName", r."contactEmail", r."extendsId", r."closedAt",
         r."updatedAt", case when p.carrier is not null then p."shippedAt" end as "proofProvidedAt",
         p."confirmedAt" as "proofConfirmedAt",
         r."acceptedAt",
         o.status::text as "orderStatus", o."returnStatus"::text as "returnStatus", o."userId",
         u."deletedAt" is null as "accountAlive",
         a.units, a.amount, a.refunded_amount, a.goods_expected, a.goods_received, a.goods_declined,
         a.money_not_refunded, a.money_pending, a.money_refunded, a.money_refused, a.failed,
         ${SORT_VALUE[sortBy]} as sv
  from cartlify.returns as r
  join cartlify.orders as o on o.id = r."orderId"
  join cartlify.users as u on u.id = o."userId"
  -- the parcel the goods go back to the shop in (one a statement)
  left join cartlify.order_shipments as p
    on p."returnId" = r.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
  cross join lateral (
    select coalesce(sum(i.quantity), 0)::int as units,
           coalesce(sum(i.amount), 0) as amount,
           coalesce(sum(i.amount) filter (where i.money = 'refunded'), 0) as refunded_amount,
           coalesce(sum(i.quantity) filter (where i.goods = 'expected'), 0)::int as goods_expected,
           coalesce(sum(i.quantity) filter (
             where i.goods in ('to_stock', 'written_off', 'lost')
           ), 0)::int as goods_received,
           coalesce(sum(i.quantity) filter (
             where i.goods in ('not_accepted', 'not_arrived')
           ), 0)::int as goods_declined,
           -- a row whose last transfer failed has its money not back either
           coalesce(sum(i.quantity) filter (where i.money in ('not_refunded', 'failed')), 0)::int as money_not_refunded,
           coalesce(sum(i.quantity) filter (where i.money = 'pending'), 0)::int as money_pending,
           coalesce(sum(i.quantity) filter (where i.money = 'refunded'), 0)::int as money_refunded,
           coalesce(sum(i.quantity) filter (where i.money = 'refused'), 0)::int as money_refused,
           coalesce(bool_or(i.money = 'failed'), false) as failed
    from cartlify.return_items as i
    where i."returnId" = r.id
  ) as a`;

const itemOf = (row: Row, now: number, left: Map<number, string>): ReturnListItemDto => ({
  id: row.id,
  code: returnCodeOf(row.basis, row.orderId, row.number),
  orderId: row.orderId,
  order: { status: row.orderStatus, returnStatus: row.returnStatus },
  buyer: { id: row.userId, alive: row.accountAlive },
  contact: { name: row.contactName, email: row.contactEmail },
  statedAt: row.statedAt.toISOString(),
  daysSince: Math.max(0, Math.floor((now - row.statedAt.getTime()) / DAY)),
  source: row.source,
  basis: row.basis,
  reason: row.reason,
  extendsId: row.extendsId,
  closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  updatedAt: row.updatedAt.toISOString(),
  proof: {
    providedAt: row.proofProvidedAt ? row.proofProvidedAt.toISOString() : null,
    confirmedAt: row.proofConfirmedAt ? row.proofConfirmedAt.toISOString() : null,
  },
  acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  units: row.units,
  amount: decimalToNumber(row.amount),
  refundedAmount: decimalToNumber(row.refunded_amount),
  moneyLeft: left.has(row.id) ? Number(left.get(row.id)) : null,
  goods: {
    expected: row.goods_expected,
    received: row.goods_received,
    declined: row.goods_declined,
  },
  money: {
    notRefunded: row.money_not_refunded,
    pending: row.money_pending,
    refunded: row.money_refunded,
    refused: row.money_refused,
    failed: row.failed,
  },
});

const sortKeyOf = (sortBy: ReturnsSortBy, sortDir: ReturnsSortDir) => `${sortBy}:${sortDir}`;

const NUMBER = /^-?\d+(\.\d+)?$/;

// a date of the cursor is one an iso string gives back (a date that is none, 2026-13-45, is no
// cursor and not an error of the database)
const isIsoDate = (value: string) => {
  const date = new Date(value);
  // the year 0 is none for the database
  return (
    !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1 && date.toISOString() === value
  );
};

// the cursor comes back from the client: it is one of this sort and direction, with a value that fits
function cursorWhere(
  cursor: string | undefined,
  sortBy: ReturnsSortBy,
  sortDir: ReturnsSortDir,
): Prisma.Sql {
  if (!cursor) return Prisma.sql`true`;

  const { id, v, s } = decodeCursor(cursor) as { id: number; v: unknown; s?: unknown };
  const fits =
    s === sortKeyOf(sortBy, sortDir) &&
    typeof v === 'string' &&
    (isDateSort(sortBy) ? isIsoDate(v) : NUMBER.test(v));
  if (!fits) throw new BadRequestError('CURSOR_INVALID');

  const op = Prisma.raw(sortDir === 'asc' ? '>' : '<');
  const value = isDateSort(sortBy) ? Prisma.sql`${v}::timestamp` : Prisma.sql`${v}::numeric`;

  return Prisma.sql`(x.sv ${op} ${value} or (x.sv = ${value} and x.id ${op} ${id}::int))`;
}

const cursorOf = (row: Row, sortBy: ReturnsSortBy, sortDir: ReturnsSortDir) =>
  encodeCursor({
    id: row.id,
    v: row.sv instanceof Date ? row.sv.toISOString() : row.sv.toString(),
    s: sortKeyOf(sortBy, sortDir),
  } as never);

async function readRows(args: ListReturnsDto, page: { limit?: number }) {
  const now = Date.now();
  const where = andOf(returnConditions(args, 'r', now));
  const dir = Prisma.raw(args.sortDir === 'asc' ? 'asc' : 'desc');

  return tx(
    async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });

      const rows = await db.$queryRaw<Row[]>(Prisma.sql`
        select x.* from (${selectOf(args.sortBy)} where ${where}) as x
        where ${cursorWhere(args.cursor, args.sortBy, args.sortDir)}
        order by x.sv ${dir}, x.id ${dir}
        ${page.limit ? Prisma.sql`limit ${page.limit + 1}` : Prisma.empty}
      `);
      const [count] = await db.$queryRaw<{ total: number }[]>(Prisma.sql`
        select count(*)::int as total from cartlify.returns as r where ${where}
      `);

      // what the open statements of the rows still have to send, counted for these rows only: the
      // function counts a statement in full
      const open = rows.filter((row) => row.closedAt === null).map((row) => row.id);
      const left = new Map<number, string>();
      if (open.length > 0) {
        const counted = await db.$queryRaw<{ id: number; left: string }[]>(Prisma.sql`
          select r.id, cartlify.return_money_left(r.id) ->> 'total' as left
          from cartlify.returns as r
          where r.id = any(${open}::int[])
        `);
        for (const one of counted) left.set(one.id, one.left);
      }

      return { rows, total: count?.total ?? 0, now, left };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );
}

export async function listReturns(args: ListReturnsDto): Promise<GetReturnsResponseDto> {
  assertAdminActor(args.actorId, args.actorRole);

  const { rows, total, now, left } = await readRows(args, { limit: args.limit });
  const hasNext = rows.length > args.limit;
  const page = hasNext ? rows.slice(0, args.limit) : rows;

  return {
    items: page.map((row) => itemOf(row, now, left)),
    total,
    limit: args.limit,
    nextCursor: hasNext ? cursorOf(page.at(-1)!, args.sortBy, args.sortDir) : null,
  };
}

const COLUMNS: CsvColumn<ReturnListItemDto>[] = [
  { header: 'return_id', kind: 'number', value: (row) => row.id },
  { header: 'code', kind: 'text', value: (row) => row.code },
  { header: 'order_id', kind: 'number', value: (row) => row.orderId },
  { header: 'stated_at', kind: 'text', value: (row) => row.statedAt },
  { header: 'days_since', kind: 'number', value: (row) => row.daysSince },
  { header: 'source', kind: 'text', value: (row) => row.source },
  { header: 'basis', kind: 'text', value: (row) => row.basis },
  { header: 'reason', kind: 'text', value: (row) => row.reason },
  { header: 'contact_name', kind: 'text', value: (row) => row.contact.name },
  { header: 'contact_email', kind: 'text', value: (row) => row.contact.email },
  { header: 'account_alive', kind: 'text', value: (row) => (row.buyer.alive ? 'yes' : 'no') },
  { header: 'order_status', kind: 'text', value: (row) => row.order.status },
  { header: 'return_status', kind: 'text', value: (row) => row.order.returnStatus },
  { header: 'units', kind: 'number', value: (row) => row.units },
  { header: 'amount', kind: 'money', value: (row) => row.amount },
  { header: 'refunded_amount', kind: 'money', value: (row) => row.refundedAmount },
  { header: 'money_left', kind: 'money', value: (row) => row.moneyLeft },
  { header: 'goods_expected', kind: 'number', value: (row) => row.goods.expected },
  { header: 'goods_received', kind: 'number', value: (row) => row.goods.received },
  { header: 'goods_declined', kind: 'number', value: (row) => row.goods.declined },
  { header: 'money_not_refunded', kind: 'number', value: (row) => row.money.notRefunded },
  { header: 'money_pending', kind: 'number', value: (row) => row.money.pending },
  { header: 'money_refunded', kind: 'number', value: (row) => row.money.refunded },
  { header: 'money_refused', kind: 'number', value: (row) => row.money.refused },
  { header: 'transfer_failed', kind: 'text', value: (row) => (row.money.failed ? 'yes' : 'no') },
  { header: 'proof_provided_at', kind: 'text', value: (row) => row.proof.providedAt },
  { header: 'proof_confirmed_at', kind: 'text', value: (row) => row.proof.confirmedAt },
  { header: 'accepted_at', kind: 'text', value: (row) => row.acceptedAt },
  { header: 'closed_at', kind: 'text', value: (row) => row.closedAt },
  { header: 'extends_id', kind: 'number', value: (row) => row.extendsId },
];

// every statement of the filter, in the order asked, as a file for the accountant
export async function listReturnsCsv(args: ListReturnsDto) {
  assertAdminActor(args.actorId, args.actorRole);

  const { rows, now, left } = await readRows({ ...args, cursor: undefined }, {});
  const day = new Date(now).toISOString().slice(0, 10);

  return {
    fileName: `returns-${day}.csv`,
    body: toCsv(
      COLUMNS,
      rows.map((row) => itemOf(row, now, left)),
    ),
  };
}
