import { setUserContext } from '@db/dbContext.service.js';

import { cancelPaidOrder, cancelPaidOrderIn } from './cancel.js';
import { asAdmin, testTx, type DbSession } from './db.js';

// A return whose money went back, for the tests of the reports and the statistics that need one as
// their data. The cancel of a paid order is a statement of the admin with the reason shop_cancel
// for the whole order (helpers/cancel.ts): the units are back in their batches at once. The money
// goes in the three steps of a refund (db/05), the answer of the provider played by the test:
// begin_return_refund writes the transfer into the money journal under a key, settle_money_refund
// with `succeeded` tells its lines sent with the time of the database, the time the money went back.
// The reports count a movement of money from the time its line was written (bookedAt), the buyer is
// told the time it was sent (refundedAt)

type Begun = { key: string; amount: string; itemIds: number[] };

export type RefundedReturn = {
  returnId: number;
  // the time the line of the goods of the transfer was written: the reports count it from then
  bookedAt: Date;
  // the time it was told sent
  refundedAt: Date;
  amount: number;
};

// the rows of a statement whose money is not back yet, refunded as one transfer
export async function refundReturn(adminId: number, returnId: number): Promise<RefundedReturn> {
  const begun = await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    const [row] = await tx.$queryRaw<{ done: Begun }[]>`
      select cartlify.begin_return_refund(${returnId}::int, null::int[], null::jsonb) as done
    `;
    return row!.done;
  });

  await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    await tx.$queryRaw`
      select cartlify.settle_money_refund(
        ${begun.key}::text, ${`re_test_${begun.key}`}::text, 'succeeded', null, null
      ) as done
    `;
  });

  // the time the goods line of the transfer was told sent
  const line = await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    return tx.moneyLog.findFirstOrThrow({
      where: { transferKey: begun.key, event: 'money.refund', part: 'goods' },
      select: { stateAt: true, createdAt: true },
    });
  });

  return {
    returnId,
    bookedAt: line.createdAt,
    refundedAt: line.stateAt!,
    amount: Number(begun.amount),
  };
}

// the transfer of the rows of a statement fails: the rows are put on their way and the provider
// says it failed, so they owe their money again with the reason in the journal (a later refund may
// go through). The times the lines of the goods of the transfer and of its failure were written
export async function failReturnRefund(
  adminId: number,
  returnId: number,
  failure:
    | 'card_unavailable'
    | 'shop_balance'
    | 'disputed'
    | 'already_refunded'
    | 'unknown' = 'shop_balance',
): Promise<{ bookedAt: Date; failedAt: Date }> {
  const begun = await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    const [row] = await tx.$queryRaw<{ done: Begun }[]>`
      select cartlify.begin_return_refund(${returnId}::int, null::int[], null::jsonb) as done
    `;
    return row!.done;
  });

  await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    await tx.$queryRaw`
      select cartlify.settle_money_refund(
        ${begun.key}::text, null, 'failed', ${failure}::cartlify."RefundFailure", 'test'
      ) as done
    `;
  });

  const lines = await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    return tx.moneyLog.findMany({
      where: { transferKey: begun.key, part: 'goods' },
      orderBy: { id: 'asc' },
      select: { event: true, createdAt: true },
    });
  });

  return {
    bookedAt: lines.find((line) => line.event === 'money.refund')!.createdAt,
    failedAt: lines.find((line) => line.event === 'money.refund_failed')!.createdAt,
  };
}

// the rows of a statement are put on their way and the provider has not said anything yet: the
// money is pending
export async function beginReturnRefund(adminId: number, returnId: number): Promise<void> {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    await tx.$queryRaw`
      select cartlify.begin_return_refund(${returnId}::int, null::int[], null::jsonb) as done
    `;
  });
}

// the admin takes a paid order back as a whole and the money goes back at once: the units are in
// their batches, the order is cancelled, the rows are refunded
export async function cancelAndRefund(adminId: number, orderId: number): Promise<RefundedReturn> {
  const returnId = await cancelPaidOrder(adminId, orderId);
  return refundReturn(adminId, returnId);
}

// in a session of a database test: the rows of a statement whose money is not back yet are refunded
// as one transfer, the provider says `succeeded`. The time the money went back is the time of the
// transaction
export async function refundReturnIn(db: DbSession, adminId: number, returnId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ done: Begun }>(
    `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb) as done`,
    returnId,
  );
  const key = row!.done.key;
  await db.rows(
    `select cartlify.settle_money_refund($1::text, $2::text, 'succeeded', null, null) as done`,
    key,
    `re_test_${key}`,
  );
}

// in a session of a database test: the admin takes the paid order back as a whole and the money
// goes back at once
export async function cancelAndRefundIn(db: DbSession, adminId: number, orderId: number) {
  const returnId = await cancelPaidOrderIn(db, adminId, orderId);
  await refundReturnIn(db, adminId, returnId);
  return returnId;
}

// the lines of the stock log of a variant with the time the database gave them, oldest first: the
// tests of the reports cut their periods at the times of the events
export const stockLinesOf = (variantId: number) =>
  asAdmin((tx) =>
    tx.stockLog.findMany({
      where: { variantId },
      orderBy: { id: 'asc' },
      select: { id: true, event: true, quantityChange: true, createdAt: true },
    }),
  );

// in a session of a database test: root publishes a contract that says who pays the way back; the
// orders confirmed after it keep the payer
export async function publishContractIn(
  db: DbSession,
  rootId: number,
  payer: 'buyer' | 'shop',
): Promise<void> {
  await db.as({ role: 'ROOT', userId: rootId });
  await db.rows(
    `insert into cartlify.legal_documents
       (kind, title, content, "publishedById", "withdrawalDays", "returnAddress", "returnShippingPaidBy")
     values ('contract', 'The contract', 'The text of the contract.', $1, 14,
             'Returns, 1 Main Street, Madrid', $2::cartlify."ReturnShippingPayer")
     returning id`,
    rootId,
    payer,
  );
}

// in a session of a database test: an admin writes a statement of withdrawal for units of an item
// (a buyer who called the shop); its id
export async function withdrawalStatementIn(
  db: DbSession,
  adminId: number,
  orderId: number,
  itemId: number,
  quantity: number,
): Promise<number> {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'withdrawal'::cartlify."ReturnBasis",
       'other'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: itemId, quantity }]),
  );
  return row!.id;
}

// in a session of a database test: an admin records a parcel back the shop paid for
export async function returnParcelIn(
  db: DbSession,
  adminId: number,
  returnId: number,
  cost: number | null,
): Promise<void> {
  await db.as({ role: 'ADMIN', userId: adminId });
  await db.rows(
    `select cartlify.record_return_shipment(
       $1::int, 'DHL', null, null, $2::numeric, (now() at time zone 'UTC')::timestamp(3)
     ) as id`,
    returnId,
    cost,
  );
}
