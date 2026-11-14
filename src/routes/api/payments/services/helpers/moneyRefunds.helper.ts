import { Prisma } from '@prisma/client';

import { utcTime } from '@routes/api/admin/services/helpers/accountingSql.helper.js';

import { disputeOpenOf, refundStillOwedOf, statementMoneyHeldOf } from './moneyHeld.helper.js';

// The refunds of the money journal (db/05, money_log) as rows of one kind, for the list of
// GET /api/payments/refunds and for the alerts that name it, so the count of an alert is the total
// of its list. A refund is the lines of money.refund under one key of the app (a transfer of a
// statement in its parts, a refund of a late payment), or one line of a refund made by hand in the
// dashboard of the provider; a transfer that money already there paid all of asked no provider and
// is none of them. Its state comes from the lines that follow it: the failure that reversed it,
// money root sent another way instead of it (the line money.outside that names it), the state sent.
// - purpose: return (the money of a statement), dispute_remainder (the transfer of a statement the
//   system made after a dispute the shop lost: what the bank did not give back), late_payment (a
//   payment the order could not take), hand (made by hand in the dashboard), compensation (money
//   root gave by the button of the app)
// - state: in_transit (asked, not told sent), sent, failed (the last word is a failure), outside
//   (root sent the money another way after it failed)
// - waiting: a failure the shop still has to act on: the rows of the statement still owe the money
//   of the failed transfer (a way back left alone, a transfer of its own: its open statement owes it
//   and nothing sent it again since), or root has not sent a failed refund another way; a refusal
//   because the money went back already is counted by its refunds made by hand and waits for
//   nothing. A failure
//   waits for the bank, not for the shop, while a dispute of the payment is open (moneyHeld.helper.ts;
//   the end of the dispute decides where the money goes), and the money of a statement waits for root
//   while a refund of the payment made by hand waits for root's decision: the transfers of the
//   statement and the money sent another way are refused meanwhile. A refund of a late payment the
//   bank refused for a dispute waits for the dispute even once it ended: the app sends the payment
//   back again when the shop wins, the bank gave it when it lost; the transfer of a statement the bank
//   refused is back among the failures once no dispute of the payment is open, its rows still owing
//   the money: after the dispute ends it is back in the usual alerts. A
//   failure of a late payment, of a refund made by hand or of a compensation waits only while the
//   buyer does not have the money another way: after a dispute the bank gave the payment back, or
//   the app sent the late payment back again, and root may not send it another way
//   (PAYMENT_REFUND_NOT_FAILED); other refunds that used what is left of the payment change nothing
// - unassigned: a refund made by hand of the payment of its order that root has not said what it was
//   for yet (the decision, POST /api/payments/money-lines/:moneyLogId/decision), with what it needs
//   (need): explain (the order went or was cancelled, or a statement of the order waits for its
//   money); none while the order is not sent and nothing waits (root decides with the hold of the
//   order). A refund made by hand of a late payment is never so: it is no money of the goods

export const MONEY_REFUND_PURPOSES = [
  'return',
  'dispute_remainder',
  'late_payment',
  'hand',
  'compensation',
] as const;
export type MoneyRefundPurpose = (typeof MONEY_REFUND_PURPOSES)[number];

export const MONEY_REFUND_STATES = ['in_transit', 'sent', 'failed', 'outside'] as const;
export type MoneyRefundState = (typeof MONEY_REFUND_STATES)[number];

export const MONEY_REFUND_NEEDS = ['explain'] as const;
export type MoneyRefundNeed = (typeof MONEY_REFUND_NEEDS)[number];

export type MoneyRefundRow = {
  // the first line of the refund in the journal: the id of a case, the one root names
  id: number;
  purpose: MoneyRefundPurpose;
  state: MoneyRefundState;
  waiting: boolean;
  unassigned: boolean;
  need: MoneyRefundNeed | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  // what the provider was asked for, above 0, digits with two decimals
  amount: string;
  currency: string | null;
  failure: string | null;
  failureText: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  createdAt: Date;
  // when it came to its state: asked, told sent, failed, sent another way
  at: Date;
  // the statement it is the money of, for its code; what is left of the payment at the provider
  returnNumber: number | null;
  returnBasis: string | null;
  paymentLeft: string | null;
};

// the lines of the refunds of one purpose only: every line of a refund has the purpose of the refund
// (a transfer of a statement after a dispute lost is of the purpose return in the journal), so the
// rows of a purpose read from its lines alone are the same rows, and a list or an alert of one kind
// reads no other refunds
const linesOfPurpose = (purpose: MoneyRefundPurpose | undefined) =>
  purpose
    ? Prisma.sql`and l.purpose = ${purpose === 'dispute_remainder' ? 'return' : purpose}::cartlify."MoneyPurpose"`
    : Prisma.empty;

// the rows (of one purpose when it is given), to be used as `from ${moneyRefundsOf()} as t`
export const moneyRefundsOf = (purpose?: MoneyRefundPurpose) => Prisma.sql`(
  select s.*,
    case s.state
      when 'outside' then s."outsideAt"
      when 'failed' then s."failedAt"
      when 'sent' then s."stateAt"
      else s."createdAt"
    end as "at",
    case
      when s.failure is null or s.failure = 'already_refunded' then false
      when s.purpose in ('return', 'dispute_remainder') then (
        exists (
          select 1 from cartlify.return_items as i
          join cartlify.money_log as f on f.id = i."moneyLogId"
          where f.event = 'money.refund_failed' and f."coversId" = any (s."lineIds")
        )
        -- the way back left alone, a transfer of its own: its open statement still owes it, and
        -- nothing sent it again since (a transfer, money outside the app)
        or (
          not s."hasGoods"
          and exists (
            select 1 from cartlify.returns as r where r.id = s."returnId" and r."closedAt" is null
          )
          and not exists (
            select 1 from cartlify.money_log as n
            where n."returnId" = s."returnId" and n.part = 'way_back'::cartlify."MoneyPart"
              and n.event in ('money.refund', 'money.outside') and n.id > s.id
          )
        )
      ) and not ${statementMoneyHeldOf(Prisma.sql`s."paymentId"`)}
      else s."outsideAt" is null and s.failure <> 'disputed'
        and not ${disputeOpenOf(Prisma.sql`s."paymentId"`)}
        and ${refundStillOwedOf(Prisma.sql`s."paymentId"`, Prisma.sql`s.amount::numeric`, Prisma.sql`s.purpose`, Prisma.sql`s.id`)}
    end as waiting,
    (s.purpose = 'hand' and s.failure is null and s."moneyUse" is null and s.own) as unassigned,
    case
      when s.purpose <> 'hand' or s.failure is not null or s."moneyUse" is not null or not s.own
        then null
      when s."orderStatus" is distinct from 'paid' or exists (
        select 1 from cartlify.returns as r
        join cartlify.return_items as i on i."returnId" = r.id
        where r."orderId" = s."orderId" and r."closedAt" is null
          and i.money in ('not_refunded'::cartlify."ReturnMoney", 'failed'::cartlify."ReturnMoney")
      ) then 'explain'
      else null
    end as need
  from (
    select h.id, h."orderId", h."userId", h."returnId", h.provider, h."paymentId", h.currency,
      h."refundId", h."bankReference", h."byDashboard", h."moneyUse", h.amount, h."createdAt",
      h."stateAt", h."lineIds", h."hasGoods",
      case
        when h.purpose = 'return' and exists (
          select 1 from cartlify.returns as r
          where r.id = h."returnId" and r.reason = 'dispute_lost'::cartlify."ReturnReason"
        ) then 'dispute_remainder'
        else h.purpose
      end as purpose,
      f.failure, f."failureText", f."failedAt", x."outsideAt",
      o.status::text as "orderStatus",
      -- a refund of the payment of its order: one of a payment the order could not take (a late
      -- one) is no money of its goods, nothing for root to say
      h."paymentId" is not distinct from o."paymentId" as own,
      rt.number as "returnNumber", rt.basis::text as "returnBasis",
      (
        select to_char(coalesce(sum(pl.amount), 0), 'FM99999999990.00')
        from cartlify.money_log as pl
        where pl."paymentId" = h."paymentId"
      ) as "paymentLeft",
      case
        when x."outsideAt" is not null then 'outside'
        when f."failedAt" is not null then 'failed'
        when h.sent then 'sent'
        else 'in_transit'
      end as state
    from (
      select min(l.id) as id,
        (array_agg(l.purpose::text order by l.id))[1] as purpose,
        (array_agg(l."orderId" order by l.id))[1] as "orderId",
        (array_agg(l."userId" order by l.id))[1] as "userId",
        (array_agg(l."returnId" order by l.id))[1] as "returnId",
        (array_agg(l.provider::text order by l.id))[1] as provider,
        (array_agg(l."paymentId" order by l.id))[1] as "paymentId",
        (array_agg(l.currency order by l.id))[1] as currency,
        (array_agg(l."moneyUse"::text order by l.id))[1] as "moneyUse",
        max(l."refundId") as "refundId",
        max(l."bankReference") as "bankReference",
        bool_or(l."byDashboard") as "byDashboard",
        to_char(-sum(l.amount), 'FM99999999990.00') as amount,
        min(l."createdAt") as "createdAt",
        bool_and(l.state = 'sent'::cartlify."MoneyState") as sent,
        max(l."stateAt") as "stateAt",
        array_agg(l.id) as "lineIds",
        bool_or(l.part = 'goods'::cartlify."MoneyPart") as "hasGoods"
      from cartlify.money_log as l
      where l.event = 'money.refund' and (l."transferKey" is not null or l.purpose = 'hand')
        ${linesOfPurpose(purpose)}
      group by coalesce(l."transferKey", l.id::text)
    ) as h
    left join lateral (
      select f.failure::text as failure, f."failureText" as "failureText",
        f."createdAt" as "failedAt"
      from cartlify.money_log as f
      where f.event = 'money.refund_failed' and f."coversId" = any (h."lineIds")
      order by f.id desc
      limit 1
    ) as f on true
    left join lateral (
      select x."createdAt" as "outsideAt"
      from cartlify.money_log as x
      where x.event = 'money.outside' and x."coversId" = h.id
      order by x.id
      limit 1
    ) as x on true
    left join cartlify.orders as o on o.id = h."orderId"
    left join cartlify.returns as rt on rt.id = h."returnId"
  ) as s
)`;

// the rows of every refund
export const MONEY_REFUNDS = moneyRefundsOf();

// what the open statements of the refunds still have to send, by the id of the statement: counted
// for the rows of an answer only (the function counts a statement in full, too slow for the counts
// of the alerts)
export async function returnsLeftOf(
  db: Prisma.TransactionClient,
  rows: Pick<MoneyRefundRow, 'returnId'>[],
): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((row) => row.returnId).filter((id) => id !== null))];
  const left = new Map<number, string>();
  if (ids.length === 0) return left;
  const counted = await db.$queryRaw<{ id: number; left: string }[]>(Prisma.sql`
    select r.id, cartlify.return_money_left(r.id) ->> 'total' as left
    from cartlify.returns as r
    where r.id = any(${ids}::int[]) and r."closedAt" is null
  `);
  for (const one of counted) left.set(one.id, one.left);
  return left;
}

export type MoneyRefundFilters = {
  purpose?: MoneyRefundPurpose | undefined;
  // any: every refund; failed: the failures that wait for the shop; unassigned: the refunds made by
  // hand that wait for root
  state?: 'in_transit' | 'failed' | 'unassigned' | 'any' | undefined;
  need?: MoneyRefundNeed | undefined;
  userId?: number | undefined;
  orderId?: number | undefined;
  // the time it came to its state
  from?: Date | undefined;
  to?: Date | undefined;
};

// the conditions of the filters on the rows `t`, all of which a row meets
export function moneyRefundConditions(filters: MoneyRefundFilters): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`true`];

  if (filters.purpose) where.push(Prisma.sql`t.purpose = ${filters.purpose}`);
  if (filters.state === 'in_transit') where.push(Prisma.sql`t.state = 'in_transit'`);
  if (filters.state === 'failed') where.push(Prisma.sql`t.waiting`);
  if (filters.state === 'unassigned') where.push(Prisma.sql`t.unassigned`);
  if (filters.need) where.push(Prisma.sql`t.need = ${filters.need}`);
  if (filters.userId !== undefined) where.push(Prisma.sql`t."userId" = ${filters.userId}::int`);
  if (filters.orderId !== undefined) where.push(Prisma.sql`t."orderId" = ${filters.orderId}::int`);
  if (filters.from) where.push(Prisma.sql`t."at" >= ${utcTime(filters.from)}`);
  if (filters.to) where.push(Prisma.sql`t."at" < ${utcTime(filters.to)}`);

  return Prisma.join(where, ' and ');
}

// a refund by the id of its first line, under the filters of none
export const moneyRefundById = (id: number) => Prisma.sql`t.id = ${id}::int`;
