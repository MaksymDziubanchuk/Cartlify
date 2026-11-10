import { Prisma } from '@prisma/client';

import {
  andOf,
  returnConditions,
} from '@routes/api/returns/services/helpers/returnFilters.helper.js';

import { LATE_REFUNDS } from './lateRefundRows.helper.js';

// The refunds that wait for the shop, as rows of one kind: the list of GET /api/payments/refunds
// and the two alerts that name it (failed_refunds, refunded_payments_not_sent) read the same rows,
// so the count of an alert is the total of its list.
// - failed: money that did not reach the buyer and that the shop has to send another way: the
//   transfer of a statement of return whose last try failed (the statement is open), and the refund
//   of a payment the order could not take, until root marks it sent another way
// - unsent: the refund of a payment the order could not take that the provider has not told sent or
//   failed (a refund the provider made, on its way, whose end did not come)

export const WAITING_REFUND_STATES = ['failed', 'unsent'] as const;
export type WaitingRefundState = (typeof WAITING_REFUND_STATES)[number];

export type WaitingRefundRow = {
  // the key of the order of the list (the time, the source, this number) and of a page after it
  num: number;
  rank: number;
  // the id of a case: the statement for a return, the refund at the provider for a payment
  id: string;
  source: 'return' | 'payment';
  orderId: number;
  // the buyer
  userId: number;
  returnId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  amount: string | null;
  currency: string | null;
  failure: string | null;
  failureText: string | null;
  // when it came to the state it is in: the transfer failed, the refund was made
  at: Date;
};

// the columns every part gives, in the order they are given
const returnsPart = (now: number) => Prisma.sql`
  select r.id as num, 0 as rank, 'return'::text as source, r.id::text as id,
    r."orderId" as "orderId", o."userId" as "userId", r.id as "returnId",
    null::text as provider, null::text as "paymentId", null::text as "refundId",
    (
      select sum(i.amount + coalesce(i."deliveryShare", 0) - coalesce(i."shippingDeduction", 0))
      from cartlify.return_items as i
      where i."returnId" = r.id
        and i.money = 'not_refunded'::cartlify."ReturnMoney"
        and i."refundFailure" is not null
    )::text as amount,
    null::text as currency,
    (
      select i."refundFailure"::text
      from cartlify.return_items as i
      where i."returnId" = r.id
        and i.money = 'not_refunded'::cartlify."ReturnMoney"
        and i."refundFailure" is not null
      order by i.id asc
      limit 1
    ) as failure,
    null::text as "failureText",
    r."updatedAt"::timestamp as "at"
  from cartlify.returns as r
  join cartlify.orders as o on o.id = r."orderId"
  where ${andOf(returnConditions({ state: 'open', money: 'failed' }, 'r', now))}`;

const paymentsPart = (state: WaitingRefundState) => Prisma.sql`
  select l."lineId" as num, 1 as rank, 'payment'::text as source,
    coalesce(l."refundId", 'line' || l."lineId"::text) as id,
    l."orderId" as "orderId", l."userId" as "userId", null::int as "returnId",
    l.provider as provider, l."paymentId" as "paymentId", l."refundId" as "refundId",
    l.amount as amount, l.currency as currency,
    l.failure as failure, l."failureText" as "failureText",
    (case when l.state = 'failed' then l."failedAt" else l."createdAt" end)::timestamp as "at"
  from ${LATE_REFUNDS} as l
  where l.state = ${state === 'failed' ? 'failed' : 'created'}`;

// the rows of a state, to be used as `from (${waitingRefunds(state, now)}) as t`; now is the time
// the days of the filters of the statements count from
export const waitingRefunds = (state: WaitingRefundState, now: number): Prisma.Sql =>
  state === 'failed'
    ? Prisma.sql`${returnsPart(now)} union all ${paymentsPart(state)}`
    : paymentsPart(state);
