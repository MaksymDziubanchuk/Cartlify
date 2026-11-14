import { Prisma } from '@prisma/client';

import { parseReturnCode, REFUND_DAYS } from '@helpers/returns.js';
import { utcTime } from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import { statementMoneyHeldOf } from '@routes/api/payments/services/helpers/moneyHeld.helper.js';

import type { ReturnBasis, ReturnReason, ReturnSource } from '@prisma/client';

// The filters of the list of the statements of return (GET /api/returns) as sql on the table of the
// statements under an alias. The alerts of the admins count their cases with the same conditions
// (alerts.service.ts), so the count of an alert and the total of the list it names are one number.

export const RETURN_STATE_FILTERS = ['open', 'closed'] as const;
// waiting: some row waits for its goods; waiting_no_proof: and the buyer has told nothing of the
// parcel and the shop has confirmed none; proof_provided: and the buyer told, the shop has not
// confirmed it; received: no row waits
export const RETURN_GOODS_FILTERS = [
  'waiting',
  'waiting_no_proof',
  'proof_provided',
  'received',
] as const;
// not_refunded: a row whose money is not back, a failed transfer too; failed: a row whose last
// transfer failed
export const RETURN_MONEY_FILTERS = [
  'not_refunded',
  'pending',
  'failed',
  'refunded',
  'refused',
] as const;

export type ReturnFilters = {
  state?: (typeof RETURN_STATE_FILTERS)[number] | undefined;
  goods?: (typeof RETURN_GOODS_FILTERS)[number] | undefined;
  money?: (typeof RETURN_MONEY_FILTERS)[number] | undefined;
  source?: ReturnSource | undefined;
  basis?: ReturnBasis | undefined;
  reason?: ReturnReason | undefined;
  orderId?: number | undefined;
  // the buyer of the order
  userId?: number | undefined;
  productId?: number | undefined;
  variantId?: number | undefined;
  // a whole number is the number of an order; any other text a part of the name or the email
  q?: string | undefined;
  statedFrom?: Date | undefined;
  statedTo?: Date | undefined;
  closedFrom?: Date | undefined;
  closedTo?: Date | undefined;
  // some row whose money went back in the period: the time the line of the money journal that
  // sent it was written
  refundedFrom?: Date | undefined;
  refundedTo?: Date | undefined;
  // stated more than so many days ago
  olderThanDays?: number | undefined;
  // the money is due (the goods are in, or the shop confirmed the proof) and is not back, so many
  // days after the statement
  moneyDueForDays?: number | undefined;
  // the money went back so many days ago and the goods are not in yet
  paidAheadForDays?: number | undefined;
  // the buyer told of the parcel more than so many days ago
  proofOlderThanDays?: number | undefined;
  // a statement of the form without the code that an admin accepted (true) or not yet (false)
  accepted?: boolean | undefined;
  // the money is not back and its days (REFUND_DAYS from the statement) are over, or end within so
  // many days
  moneyOverdue?: boolean | undefined;
  moneyDueWithinDays?: number | undefined;
  // a part of a chain of extensions (it extends one, or one extends it), or not
  extended?: boolean | undefined;
  // the money waits for the bank or for root (true) or not (false): a dispute of the payment of the
  // order is open, or a refund of it made by hand waits for root (moneyHeld.helper.ts)
  moneyHeld?: boolean | undefined;
  // what is due, or the way back beside the money the other statements of the order owe, does not
  // fit in what is left of the payment (return_money_left, db/05)
  moneyShort?: boolean | undefined;
  // money already with the buyer gave the goods of the order more than its statements took
  // (order_money_overpaid, db/05)
  moneyOverpaid?: boolean | undefined;
};

const DAY = 86_400_000;

// the sql of a condition on the rows of a statement `a`
const someRow = (a: Prisma.Sql, condition: Prisma.Sql) =>
  Prisma.sql`exists (
    select 1 from cartlify.return_items as i
    where i."returnId" = ${a}.id and (${condition})
  )`;

// the text between the wildcards of a LIKE pattern, escaped
const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// the conditions of the filters on the statements `alias` names, all of which a statement meets
export function returnConditions(filters: ReturnFilters, alias: string, now: number): Prisma.Sql[] {
  const a = Prisma.raw(alias);
  const where: Prisma.Sql[] = [];
  const before = (days: number) => utcTime(new Date(now - days * DAY));

  if (filters.state === 'open') where.push(Prisma.sql`${a}."closedAt" is null`);
  if (filters.state === 'closed') where.push(Prisma.sql`${a}."closedAt" is not null`);

  const waiting = someRow(a, Prisma.sql`i.goods = 'expected'::cartlify."ReturnGoods"`);
  if (filters.goods === 'waiting') where.push(waiting);
  if (filters.goods === 'waiting_no_proof') {
    where.push(
      waiting,
      Prisma.sql`not exists (
        select 1 from cartlify.order_shipments as p
        where p."returnId" = ${a}.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
      )`,
    );
  }
  if (filters.goods === 'proof_provided') {
    where.push(
      waiting,
      Prisma.sql`exists (
        select 1 from cartlify.order_shipments as p
        where p."returnId" = ${a}.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
          and p."confirmedAt" is null
      )`,
    );
  }
  if (filters.goods === 'received') where.push(Prisma.sql`not ${waiting}`);

  if (filters.money === 'not_refunded') {
    where.push(
      someRow(
        a,
        Prisma.sql`i.money in ('not_refunded'::cartlify."ReturnMoney", 'failed'::cartlify."ReturnMoney")`,
      ),
    );
  } else if (filters.money) {
    where.push(someRow(a, Prisma.sql`i.money = ${filters.money}::cartlify."ReturnMoney"`));
  }

  if (filters.source)
    where.push(Prisma.sql`${a}.source = ${filters.source}::cartlify."ReturnSource"`);
  if (filters.basis) where.push(Prisma.sql`${a}.basis = ${filters.basis}::cartlify."ReturnBasis"`);
  if (filters.reason)
    where.push(Prisma.sql`${a}.reason = ${filters.reason}::cartlify."ReturnReason"`);
  if (filters.orderId !== undefined)
    where.push(Prisma.sql`${a}."orderId" = ${filters.orderId}::int`);
  if (filters.userId !== undefined) {
    where.push(Prisma.sql`exists (
      select 1 from cartlify.orders as o
      where o.id = ${a}."orderId" and o."userId" = ${filters.userId}::int
    )`);
  }
  if (filters.productId !== undefined) {
    where.push(
      someRow(
        a,
        Prisma.sql`exists (
          select 1 from cartlify.order_items as oi
          where oi.id = i."orderItemId" and oi."productId" = ${filters.productId}::int
        )`,
      ),
    );
  }
  if (filters.variantId !== undefined) {
    where.push(
      someRow(
        a,
        Prisma.sql`exists (
          select 1 from cartlify.order_items as oi
          where oi.id = i."orderItemId" and oi."variantId" = ${filters.variantId}::int
        )`,
      ),
    );
  }
  // the code of a statement (W42-2) finds that statement
  const code = filters.q ? parseReturnCode(filters.q) : null;
  if (code) {
    where.push(
      Prisma.sql`(${a}."orderId" = ${code.orderId}::int and ${a}.number = ${code.number}::int)`,
    );
  } else if (filters.q) {
    const pattern = likeOf(filters.q);
    const byNumber = /^[1-9][0-9]{0,9}$/.test(filters.q) && Number(filters.q) <= 2_147_483_647;
    where.push(
      byNumber
        ? Prisma.sql`(${a}."orderId" = ${Number(filters.q)}::int
            or ${a}."contactName" ilike ${pattern} or ${a}."contactEmail" ilike ${pattern})`
        : Prisma.sql`(${a}."contactName" ilike ${pattern} or ${a}."contactEmail" ilike ${pattern})`,
    );
  }

  if (filters.statedFrom) where.push(Prisma.sql`${a}."statedAt" >= ${utcTime(filters.statedFrom)}`);
  if (filters.statedTo) where.push(Prisma.sql`${a}."statedAt" < ${utcTime(filters.statedTo)}`);
  if (filters.closedFrom) where.push(Prisma.sql`${a}."closedAt" >= ${utcTime(filters.closedFrom)}`);
  if (filters.closedTo) where.push(Prisma.sql`${a}."closedAt" < ${utcTime(filters.closedTo)}`);
  if (filters.refundedFrom || filters.refundedTo) {
    where.push(
      someRow(
        a,
        Prisma.sql`i.money = 'refunded'::cartlify."ReturnMoney" and exists (
          select 1 from cartlify.money_log as m
          where m.id = i."moneyLogId"
          ${filters.refundedFrom ? Prisma.sql`and m."createdAt" >= ${utcTime(filters.refundedFrom)}` : Prisma.empty}
          ${filters.refundedTo ? Prisma.sql`and m."createdAt" < ${utcTime(filters.refundedTo)}` : Prisma.empty}
        )`,
      ),
    );
  }

  if (filters.olderThanDays !== undefined) {
    where.push(Prisma.sql`${a}."statedAt" < ${before(filters.olderThanDays)}`);
  }
  // the money of some row is due and not back (on its way too): the shop may hold it until the goods
  // are in or the proof of the parcel is confirmed, so only then does it count; a statement whose
  // goods were not sent yet is a case of the goods (goods=waiting_no_proof, olderThanDays)
  const moneyOwed = someRow(
    a,
    Prisma.sql`i.money in (
        'not_refunded'::cartlify."ReturnMoney",
        'pending'::cartlify."ReturnMoney",
        'failed'::cartlify."ReturnMoney"
      )
      and (
        i.goods in (
          'to_stock'::cartlify."ReturnGoods",
          'written_off'::cartlify."ReturnGoods",
          'lost'::cartlify."ReturnGoods"
        )
        or (i.goods = 'expected'::cartlify."ReturnGoods" and exists (
          select 1 from cartlify.order_shipments as p
          where p."returnId" = ${a}.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
            and p."confirmedAt" is not null
        ))
      )`,
  );
  if (filters.moneyDueForDays !== undefined) {
    where.push(Prisma.sql`${a}."statedAt" < ${before(filters.moneyDueForDays)}`, moneyOwed);
  }
  // the end of the days of the money: the statement and the days the law gives
  const due = Prisma.sql`${a}."statedAt" + ${REFUND_DAYS}::int * interval '1 day'`;
  if (filters.moneyOverdue === true) {
    where.push(moneyOwed, Prisma.sql`${due} < ${utcTime(new Date(now))}`);
  }
  if (filters.moneyOverdue === false) {
    where.push(Prisma.sql`not (${moneyOwed} and ${due} < ${utcTime(new Date(now))})`);
  }
  if (filters.moneyDueWithinDays !== undefined) {
    where.push(
      moneyOwed,
      Prisma.sql`${due} >= ${utcTime(new Date(now))}`,
      Prisma.sql`${due} < ${utcTime(new Date(now + filters.moneyDueWithinDays * DAY))}`,
    );
  }

  // a chain of extensions: the statement extends one, or one extends it
  const chain = Prisma.sql`(${a}."extendsId" is not null or exists (
    select 1 from cartlify.returns as e where e."extendsId" = ${a}.id
  ))`;
  if (filters.extended === true) where.push(chain);
  if (filters.extended === false) where.push(Prisma.sql`not ${chain}`);

  // the transfers of the statement and its money sent another way are refused meanwhile
  // (RETURN_REFUND_DISPUTED, RETURN_HAND_REFUND_PENDING, RETURN_BANK_MONEY_PENDING): the money is not
  // late for the shop
  const held = Prisma.sql`exists (
    select 1 from cartlify.orders as ho
    where ho.id = ${a}."orderId" and ho."paymentId" is not null
      and ${statementMoneyHeldOf(Prisma.sql`ho."paymentId"`)}
  )`;
  if (filters.moneyHeld === true) where.push(held);
  if (filters.moneyHeld === false) where.push(Prisma.sql`not ${held}`);

  // a transfer of what is due would ask the provider for more than is left of the payment, or the
  // way back does not fit in it beside the money the other statements of the order still owe: it
  // waits, or goes outside the app. The function counts a statement in full, which is slow over
  // every statement of the shop (each read of the alerts of root does it), so it counts only a
  // statement that could not fit at all: the rows every statement of the order owes, the delivery
  // of the order and the receipt of the way back above what is left of the payment (more than any
  // of them can owe, so no case is left out)
  if (filters.moneyShort !== undefined) {
    const short = Prisma.sql`(case when (
        coalesce((
          select sum(i.amount) from cartlify.return_items as i
          join cartlify.returns as ir on ir.id = i."returnId"
          where ir."orderId" = ${a}."orderId"
            and i.money in ('not_refunded'::cartlify."ReturnMoney", 'failed'::cartlify."ReturnMoney")
        ), 0)
        + coalesce((
          select d.price from cartlify.order_deliveries as d where d."orderId" = ${a}."orderId"
        ), 0)
        + coalesce((
          select max(sh."buyerPaid") from cartlify.order_shipments as sh
          where sh."returnId" = ${a}.id and sh.direction = 'to_shop'::cartlify."ShipmentDirection"
        ), 0)
      ) > coalesce((
        select sum(ml.amount) from cartlify.money_log as ml
        join cartlify.orders as po on po."paymentId" = ml."paymentId"
        where po.id = ${a}."orderId"
      ), 0)
      then (cartlify.return_money_left(${a}.id) ->> 'short')::boolean else false end)`;
    where.push(filters.moneyShort ? short : Prisma.sql`not ${short}`);
  }
  // money already with the buyer for goods no statement of the order owes any more; counted only
  // for an order with money a decision shared
  if (filters.moneyOverpaid !== undefined) {
    const overpaid = Prisma.sql`(case when exists (
      select 1 from cartlify.money_log as ml
      where ml."orderId" = ${a}."orderId" and ml."moneyUse" is not null
    ) then cartlify.order_money_overpaid(${a}."orderId") > 0 else false end)`;
    where.push(filters.moneyOverpaid ? overpaid : Prisma.sql`not ${overpaid}`);
  }

  if (filters.paidAheadForDays !== undefined) {
    where.push(
      someRow(
        a,
        Prisma.sql`i.goods = 'expected'::cartlify."ReturnGoods"
          and i.money = 'refunded'::cartlify."ReturnMoney"
          and exists (
            select 1 from cartlify.money_log as m
            where m.id = i."moneyLogId" and m."createdAt" < ${before(filters.paidAheadForDays)}
          )`,
      ),
    );
  }
  if (filters.proofOlderThanDays !== undefined) {
    where.push(Prisma.sql`exists (
      select 1 from cartlify.order_shipments as p
      where p."returnId" = ${a}.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
        and p.carrier is not null and p."shippedAt" < ${before(filters.proofOlderThanDays)}
    )`);
  }
  if (filters.accepted !== undefined) {
    where.push(
      Prisma.sql`${a}.source = 'form_manual'::cartlify."ReturnSource"`,
      filters.accepted
        ? Prisma.sql`${a}."acceptedAt" is not null`
        : Prisma.sql`${a}."acceptedAt" is null`,
    );
  }

  return where;
}

// the conditions joined with and; none is true
export const andOf = (conditions: Prisma.Sql[]): Prisma.Sql =>
  conditions.length ? Prisma.join(conditions, ' and ') : Prisma.sql`true`;
