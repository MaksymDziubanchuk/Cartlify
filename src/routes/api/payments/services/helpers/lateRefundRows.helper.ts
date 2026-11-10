import { Prisma } from '@prisma/client';

import type { PaymentProviderName } from '../../providers/types.js';

// The refunds of the payments an order could not take, as rows. Until the refunds have a table of
// their own, the lines of the admin log are the record: the line `order.refund_late` is the refund
// made, and the lines that follow it for the same payment tell how it went (`_sent`, `_failed`,
// `_outside`). A row is one refund with the state it has reached:
// created - the refund is made, Stripe has not told that its money was sent or that it failed
// sent    - the money is sent, the buyer was mailed
// failed  - the refund failed (also after it was sent: the bank sent the money back)
// outside - root sent the money another way after it failed

export const LATE_REFUND_STATES = ['created', 'sent', 'failed', 'outside'] as const;
export type LateRefundState = (typeof LATE_REFUND_STATES)[number];

export type LateRefundRow = {
  lineId: number;
  orderId: number;
  // the buyer, the actor of the lines
  userId: number;
  createdAt: Date;
  provider: PaymentProviderName;
  paymentId: string;
  // none for a payment the provider had given back before the app asked
  refundId: string | null;
  reason: string;
  amount: string;
  currency: string | null;
  sentAt: Date | null;
  failedAt: Date | null;
  // our word for why it failed, the words of the provider
  failure: string | null;
  failureText: string | null;
  outsideAt: Date | null;
  state: LateRefundState;
};

// the first change of a line holds the refund
const FIELD = Prisma.raw(`meta->0->'new'`);

// the lines that follow the refund for the same payment, by the event
const followUp = (event: string, select: Prisma.Sql) => Prisma.sql`(
    select ${select} from cartlify.admin_audit_log as x
    where x.event = ${event}
      and x."entityType" = 'order'::cartlify."AdminAuditEntityType"
      and x."entityId" = l."entityId"
      and x.meta->0->'new'->>'paymentId' = l.meta->0->'new'->>'paymentId'
  )`;

// the refunds with their states, to be used as `from ${LATE_REFUNDS} as t`
export const LATE_REFUNDS = Prisma.sql`(
  select r.*,
    case
      when r."outsideAt" is not null then 'outside'
      when r."failedAt" is not null then 'failed'
      when r."sentAt" is not null then 'sent'
      else 'created'
    end as state
  from (
    select l.id as "lineId", l."entityId" as "orderId", l."actorId" as "userId",
      l."createdAt" as "createdAt",
      l.${FIELD}->>'provider' as provider,
      l.${FIELD}->>'paymentId' as "paymentId",
      l.${FIELD}->>'refundId' as "refundId",
      l.${FIELD}->>'reason' as reason,
      l.${FIELD}->>'amount' as amount,
      l.${FIELD}->>'currency' as currency,
      ${followUp('order.refund_late_sent', Prisma.sql`min(x."createdAt")`)} as "sentAt",
      ${followUp('order.refund_late_failed', Prisma.sql`min(x."createdAt")`)} as "failedAt",
      ${followUp('order.refund_late_failed', Prisma.sql`min(x.meta->0->'new'->>'failure')`)} as failure,
      ${followUp('order.refund_late_failed', Prisma.sql`min(x.meta->0->'new'->>'failureText')`)} as "failureText",
      ${followUp('order.refund_late_outside', Prisma.sql`min(x."createdAt")`)} as "outsideAt"
    from cartlify.admin_audit_log as l
    where l.event = 'order.refund_late'
      and l."entityType" = 'order'::cartlify."AdminAuditEntityType"
      and l.action = 'OTHER'::cartlify."AdminAuditAction"
      and l.meta @> '[{"field": "refund"}]'::jsonb
  ) as r
)`;

// the name of the lock of a payment, for the database and for the tests that hold it
export const lateRefundLockKey = (paymentId: string) => `cartlify.late_refund:${paymentId}`;

// the lock that makes the changes of the state of one refund go one after another: the line of
// its creation, the lines of its end, the mark of root. Held until the transaction ends; whoever
// comes second finds the lines of the first
export async function lockLateRefund(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  await db.$executeRaw`select pg_advisory_xact_lock(hashtext(${lateRefundLockKey(paymentId)}))`;
}

// the refund of a payment, found by its id at the provider or by the payment: the first the match
// names. None when the app made no such refund (one made by hand at the provider)
export async function readLateRefund(
  db: Prisma.TransactionClient,
  match: { provider: PaymentProviderName; refundId: string | null; paymentId: string | null },
): Promise<LateRefundRow | null> {
  const by: Prisma.Sql[] = [];
  if (match.refundId) by.push(Prisma.sql`t."refundId" = ${match.refundId}`);
  if (match.paymentId) by.push(Prisma.sql`t."paymentId" = ${match.paymentId}`);
  if (!by.length) return null;

  const rows = await db.$queryRaw<LateRefundRow[]>(Prisma.sql`
    select * from ${LATE_REFUNDS} as t
    where t.provider = ${match.provider} and (${Prisma.join(by, ' or ')})
    order by t."lineId" asc
    limit 1
  `);

  return rows[0] ?? null;
}

// the refund made at the provider under this id, the way root and the lists name it
export async function readLateRefundById(
  db: Prisma.TransactionClient,
  refundId: string,
): Promise<LateRefundRow | null> {
  const rows = await db.$queryRaw<LateRefundRow[]>(Prisma.sql`
    select * from ${LATE_REFUNDS} as t
    where t."refundId" = ${refundId}
    order by t."lineId" asc
    limit 1
  `);

  return rows[0] ?? null;
}
