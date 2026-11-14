import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { giveMoneyBack } from '@routes/api/returns/services/refundReturn.service.js';

import type { PaymentRefundMailLogger } from './paymentRefundMails.helper.js';

// The statements whose money goes by itself (the app sends it without a person) while the goods are
// still in the shop, and the step that sends it once what
// stopped it is over: the end of a dispute of the payment (followDisputes.service.ts), the decision
// of root on money given back by hand or taken by a bank (moneyDecision.service.ts)

const TX_OPTIONS = {
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

// the refusals of a transfer of a statement that only mean nothing can go now: no row waits that can
// be paid, another dispute of the payment is open, money given back by hand or taken by a bank waits
// for root to say what it was for, the statement of the form waits for the check of an admin
const NOTHING_TO_SEND = new Set([
  'RETURN_ITEMS_REQUIRED',
  'RETURN_REFUND_DISPUTED',
  'RETURN_HAND_REFUND_PENDING',
  'RETURN_BANK_MONEY_PENDING',
  'RETURN_NOT_ACCEPTED',
]);

// made by the buyer from the account or by the public form with the code, a cancel of the shop (the
// one root decides on with it) or of the system; no parcel to the shop (the order was not handed
// over) and rows that wait for their money. Goods that came back from the buyer are paid by an admin
// (r: the statement)
export const goesByItselfSql = Prisma.sql`r."closedAt" is null
  and (
    r.source in ('account'::cartlify."ReturnSource", 'form_code'::cartlify."ReturnSource", 'system'::cartlify."ReturnSource")
    or r.reason = 'shop_cancel'::cartlify."ReturnReason"
  )
  and not exists (
    select 1 from cartlify.order_shipments as p
    where p."returnId" = r.id and p.direction = 'to_shop'::cartlify."ShipmentDirection"
  )
  and exists (
    select 1 from cartlify.return_items as i
    where i."returnId" = r.id
      and i.money in ('not_refunded'::cartlify."ReturnMoney", 'failed'::cartlify."ReturnMoney")
      and i.goods = 'to_stock'::cartlify."ReturnGoods"
  )`;

// the statements of the order whose money goes by itself and waits
export async function waitingStatementsOf(orderId: number): Promise<number[]> {
  const rows = await tx(async (db) => {
    await setAdminContext(db);
    return db.$queryRaw<{ id: number }[]>(Prisma.sql`
      select r.id from cartlify.returns as r
      where r."orderId" = ${orderId}::int and ${goesByItselfSql}
      order by r.id
    `);
  }, TX_OPTIONS);
  return rows.map((row) => row.id);
}

// the money of one such statement goes by itself; a refusal that only means it cannot go now is
// quiet, any other is logged (the alerts of the statements tell a person)
export async function sendStatementMoney(
  returnId: number,
  log: PaymentRefundMailLogger,
): Promise<void> {
  try {
    await giveMoneyBack({ returnId, actor: null, log });
  } catch (err) {
    const code = (err as { errorCode?: string }).errorCode;
    if (code && NOTHING_TO_SEND.has(code)) return;
    log.warn(
      { ...failureOf(err), returnId },
      'the money of a statement that goes by itself was not sent',
    );
  }
}

// the money of every such statement of the order goes on
export async function sendWaitingStatements(
  orderId: number,
  log: PaymentRefundMailLogger,
): Promise<void> {
  for (const returnId of await waitingStatementsOf(orderId)) {
    await sendStatementMoney(returnId, log);
  }
}
