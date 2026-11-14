import { Prisma } from '@prisma/client';

import type { MoneyActor } from '@routes/api/payments/services/helpers/settleMoneyRefund.helper.js';

// what begin_return_refund (db/05) says to ask the provider for: the key of the request (none when
// money already sent another way covered all of it: nothing is asked, the rows are refunded at once,
// settled is true), the sum, the rows (none for a way back left alone, a transfer of its own), and
// what the journal of the admins keeps of it
export type StartedRefund = {
  key: string | null;
  returnId: number;
  orderId: number;
  provider: string;
  paymentId: string;
  amount: string;
  itemIds: number[];
  // the rows root lowered in this call
  lowered: Array<{ itemId: number; from: string; to: string; note: string | null }>;
  // the cost of the way back taken off the transfer, and what money already there covered
  deduction: string;
  covered: string;
  settled: boolean;
};

// who gives money back: an admin or root, or the system for a buyer's own withdrawal
export type RefundActor = MoneyActor;

// the lines of a transfer under its key: the way back left alone goes with no row to name them
export async function linesOfTransfer(
  db: Prisma.TransactionClient,
  key: string,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    select l.id from cartlify.money_log as l
    where l.event = 'money.refund' and l."transferKey" = ${key}
    order by l.id
  `);

  return rows.map((row) => row.id);
}

// the lines of the money journal a call wrote for the rows: the parts of a transfer under its key, or
// the parts written with the goods line of the rows when there is no key (money already there paid
// all of it, money sent outside the app). The goods line is the line the rows name (moneyLogId)
export async function linesOfMovement(
  db: Prisma.TransactionClient,
  event: 'money.refund' | 'money.outside',
  returnId: number,
  itemId: number,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    select l.id
    from cartlify.return_items as i
    join cartlify.money_log as g on g.id = i."moneyLogId"
    join cartlify.money_log as l
      on l.event = ${event}
      and l."returnId" = ${returnId}::int
      and (
        (g."transferKey" is not null and l."transferKey" = g."transferKey")
        or (g."transferKey" is null and l."transferKey" is null and l."createdAt" = g."createdAt")
      )
    where i.id = ${itemId}::int
    order by l.id
  `);

  return rows.map((row) => row.id);
}
