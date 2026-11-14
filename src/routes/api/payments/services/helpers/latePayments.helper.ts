import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

import type { PaymentProviderName } from '../../providers/types.js';
import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

// The payments an order could not take, as the money journal keeps them (db/05, money_log): the line
// money.late_payment of the payment, written once by record_late_payment, with the reason pay_order
// gave and the number of the order in its meta (the row of the order may be gone since). The money
// is the shop's until its refund is sent; the journal is the record that the order never takes it

export type LatePayment = {
  lineId: number;
  // the order the page was for: the row when it is there, the number the line keeps when it is gone
  orderId: number | null;
  // the buyer: the owner of the order, or the one of the payment page; none when neither is there
  userId: number | null;
  provider: PaymentProviderName;
  paymentId: string;
  // digits with two decimals, and its currency
  amount: string;
  currency: string | null;
  reason: PayOrderRefundReason;
};

// the value of a field of the meta of a line, a list of { field, new }
const metaField = (field: string) => Prisma.sql`(
  select e.value->>'new' from jsonb_array_elements(coalesce(l.meta, '[]'::jsonb)) as e (value)
  where e.value->>'field' = ${field}
  limit 1
)`;

// the late payment of this payment, none when the payment is not one
export async function readLatePayment(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<LatePayment | null> {
  const rows = await db.$queryRaw<LatePayment[]>(Prisma.sql`
    select l.id as "lineId",
      coalesce(l."orderId", (${metaField('orderRef')})::int) as "orderId",
      l."userId" as "userId",
      l.provider::text as provider,
      l."paymentId" as "paymentId",
      to_char(l.amount, 'FM99999999990.00') as amount,
      l.currency as currency,
      ${metaField('reason')} as reason
    from cartlify.money_log as l
    where l.event = 'money.late_payment' and l."paymentId" = ${paymentId}
    limit 1
  `);

  return rows[0] ?? null;
}

// the payment is one the order could not take: the money goes back (or went back), so a later
// delivery of its event never makes the order take it, also when the stock came back meanwhile
export async function isLatePayment(paymentId: string): Promise<boolean> {
  return tx(async (db) => {
    await setAdminContext(db);
    return (await readLatePayment(db, paymentId)) !== null;
  });
}

// what is left of the money of a payment: the sum of every line that names it (the late payment,
// its refunds and their failures, money sent another way, what a dispute took and gave back), as
// digits with two decimals
export async function paidLeftOf(db: Prisma.TransactionClient, paymentId: string): Promise<string> {
  const [row] = await db.$queryRaw<{ left: string }[]>(Prisma.sql`
    select to_char(coalesce(sum(l.amount), 0), 'FM99999999990.00') as left
    from cartlify.money_log as l
    where l."paymentId" = ${paymentId}
  `);

  return row!.left;
}
