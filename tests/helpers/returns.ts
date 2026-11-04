import { setUserContext } from '@db/dbContext.service.js';

import { cancelPaidOrder, cancelPaidOrderIn } from './cancel.js';
import { asAdmin, testTx, type DbSession } from './db.js';

// A return whose money went back, for the tests of the reports and the statistics that need one as
// their data. The cancel of a paid order is a statement of the admin with the reason shop_cancel
// for the whole order (helpers/cancel.ts): the units are back in their batches at once. The money
// goes in the three steps of a refund (db/05), the answer of the provider played by the test:
// begin_return_refund puts the rows under a key, finish_return_refund with `succeeded` settles them
// and stamps the time of the database, the time the money went back

type Begun = { key: string; amount: string; itemIds: number[] };

export type RefundedReturn = { returnId: number; refundedAt: Date; amount: number };

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
      select cartlify.finish_return_refund(
        ${begun.key}::uuid, 'succeeded', ${`re_test_${begun.key}`}::text, null, null
      ) as done
    `;
  });

  const row = await testTx(async (tx) => {
    await setUserContext(tx, { userId: adminId, role: 'ADMIN' });
    return tx.orderReturnItem.findFirstOrThrow({
      where: { returnId, refundKey: begun.key },
      select: { refundedAt: true },
    });
  });

  return { returnId, refundedAt: row.refundedAt!, amount: Number(begun.amount) };
}

// the transfer of the rows of a statement fails: the rows are put on their way and the provider
// says it failed, so they are back to not refunded with the reason (a later refund may go through)
export async function failReturnRefund(
  adminId: number,
  returnId: number,
  failure: 'card_unavailable' | 'shop_balance' | 'disputed' | 'unknown' = 'shop_balance',
): Promise<void> {
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
      select cartlify.finish_return_refund(
        ${begun.key}::uuid, 'failed', null, ${failure}::cartlify."ReturnRefundFailure", 'test'
      ) as done
    `;
  });
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
    `select cartlify.finish_return_refund($1::uuid, 'succeeded', $2::text, null, null) as done`,
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
