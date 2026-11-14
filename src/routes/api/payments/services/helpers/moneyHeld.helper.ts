import { Prisma } from '@prisma/client';

// What holds the money of a payment from the shop: a dispute of the payment
// open at the bank, whose end decides where the money goes, and, for the money of the statements of
// an order, money of the payment that waits for root to say what it was for: a refund made by hand in
// the dashboard of the provider, what a bank took for a dispute lost on an order sent
// (begin_return_refund refuses the transfers of the statements of the order while any is there:
// RETURN_REFUND_DISPUTED, RETURN_HAND_REFUND_PENDING, RETURN_BANK_MONEY_PENDING, db/05). The
// list of the refunds (the failures that wait for the shop) and the list of the statements
// (moneyHeld) read it, and so do the alerts that name them: the money waits for the bank or for root,
// not for the shop

// the states that end a dispute
export const DISPUTE_ENDED_STATUSES = ['warning_closed', 'won', 'lost', 'prevented'] as const;

// a dispute of the payment (an sql expression of its id) is open at the bank
export const disputeOpenOf = (paymentId: Prisma.Sql) => Prisma.sql`exists (
    select 1 from cartlify.payment_disputes as hd
    where hd."paymentId" = ${paymentId}
      and hd.status::text not in (${Prisma.join([...DISPUTE_ENDED_STATUSES])})
  )`;

// a refund of the payment made by hand waits for root to say what it was for: no decision, not
// failed (begin_return_refund refuses the transfers of the order meanwhile, db/05)
export const handRefundPendingOf = (paymentId: Prisma.Sql) => Prisma.sql`exists (
    select 1 from cartlify.money_log as hl
    where hl."paymentId" = ${paymentId}
      and hl.purpose = 'hand'::cartlify."MoneyPurpose"
      and hl.event = 'money.refund'
      and hl."moneyUse" is null
      and not exists (
        select 1 from cartlify.money_log as hf
        where hf.event = 'money.refund_failed' and hf."coversId" = hl.id
      )
  )`;

// the money of a failed refund of the payment (sql expressions of its id, its sum above 0, its
// purpose and its first line) is still the shop's to send another way: the buyer does not have it by
// the bank (what the shop holds of the payment by what it took and what the banks took and gave back
// is at least the sum) nor by a later refund of a late payment the app sent again after a dispute the
// shop won. Other refunds that used what is left of the payment are no reason: the limit is the
// provider's (mark_payment_refund_outside refuses the same way, PAYMENT_REFUND_NOT_FAILED, db/05)
export const refundStillOwedOf = (
  paymentId: Prisma.Sql,
  amount: Prisma.Sql,
  purpose: Prisma.Sql,
  lineId: Prisma.Sql,
) => Prisma.sql`(
    (
      select coalesce(sum(pl.amount), 0) from cartlify.money_log as pl
      where pl."paymentId" = ${paymentId}
        and pl.event in ('money.payment', 'money.late_payment', 'money.dispute_withdrawn', 'money.dispute_reinstated')
    ) >= ${amount}
    and not (
      ${purpose} = 'late_payment' and exists (
        select 1 from cartlify.money_log as pr
        where pr."paymentId" = ${paymentId}
          and pr.event = 'money.refund'
          and pr.purpose = 'late_payment'::cartlify."MoneyPurpose"
          and pr.id > ${lineId}
          and not exists (
            select 1 from cartlify.money_log as pf
            where pf.event = 'money.refund_failed' and pf."coversId" = pr.id
          )
      )
    )
  )`;

// what a bank took for a dispute of the payment the shop lost waits for root to say what it was for
// (RETURN_BANK_MONEY_PENDING, db/05)
export const bankMoneyPendingOf = (paymentId: Prisma.Sql) => Prisma.sql`exists (
    select 1 from cartlify.money_log as bl
    join cartlify.payment_disputes as bd on bd.id = bl."disputeId"
    where bl."paymentId" = ${paymentId}
      and bl.event = 'money.dispute_withdrawn'
      and bl."moneyUse" is null
      and bd.status = 'lost'::cartlify."DisputeStatus"
  )`;

// the money of the statements of an order whose payment it is waits for the bank or for root
export const statementMoneyHeldOf = (paymentId: Prisma.Sql) =>
  Prisma.sql`(${disputeOpenOf(paymentId)} or ${handRefundPendingOf(paymentId)} or ${bankMoneyPendingOf(paymentId)})`;
