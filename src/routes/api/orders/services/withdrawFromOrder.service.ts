import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { tx, isRetryableTxError } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import {
  manualStatementsTakenOf,
  sendReturnChangedEmail,
} from '@routes/api/returns/services/helpers/sendReturnChangedEmail.helper.js';
import { sendReturnReceivedEmail } from '@routes/api/returns/services/helpers/sendReturnReceivedEmail.helper.js';
import { giveMoneyBack } from '@routes/api/returns/services/refundReturn.service.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse, orderContextOf, readOrderResponse } from './helpers/index.js';
import { withdrawalItemsOf } from './helpers/withdrawalItems.helper.js';

import type { OrderResponseDto, WithdrawDto } from 'types/dto/orders.dto.js';

// The buyer withdraws from the contract from their account: from the whole order (what is left of
// it that has the right of withdrawal) or from the units named. The database makes the statement
// (create_return: the order is theirs, the period and the right of each item are checked). For a
// paid order that was not sent the goods are on the shelf and come back at once, the order is
// cancelled when it is all of it, and the money goes back right away in the three steps of a refund
// in the name of the shop. For a sent order the statement waits for the parcel. Units an open
// statement of the form without the code holds are taken over: that statement gives them up and its
// person is told. The buyer is mailed the notice of it either way; the answer is their order
export async function withdrawFromOrder({
  actorId,
  actorRole,
  orderId,
  items,
  description,
  log,
}: WithdrawDto): Promise<OrderResponseDto> {
  // only the buyer withdraws from their account; an admin makes a statement through the routes of the returns
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  let made: { returnId: number; sent: boolean; changed: number[] };
  try {
    made = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // an order of another is not found; the answers go to the name and the email of the account
        const order = await db.order.findFirst({
          where: { id: orderId, userId: Number(actorId) },
          select: {
            id: true,
            status: true,
            items: { select: { id: true, quantity: true, withdrawal: true } },
          },
        });
        if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

        const buyer = await db.user.findUniqueOrThrow({
          where: { id: Number(actorId) },
          select: { name: true, email: true },
        });

        // no units named: whatever is left of the order that has the right of withdrawal
        const units = await withdrawalItemsOf(db, order, items, true);

        const [row] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
          select cartlify.create_return(
            ${orderId}::int,
            ${JSON.stringify(units)}::jsonb,
            'account'::cartlify."ReturnSource",
            'withdrawal'::cartlify."ReturnBasis",
            null::cartlify."ReturnReason",
            ${description ?? null}::text,
            ${(buyer.name?.trim() || buyer.email).slice(0, 200)}::text,
            ${buyer.email}::text,
            null::timestamp,
            null::int,
            ${shopSettings().withdrawalGraceDays}::int,
            ${env.SHOP_TIME_ZONE}::text
          ) as id
        `);
        if (!row) throw new InternalError({ reason: 'RETURN_NOT_MADE' });

        const after = await db.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        });
        // the goods came back at once, or they wait for the parcel: the statement says which (the
        // order may have been sent between the read and the lock of the statement)
        const waiting = await db.orderReturnItem.count({
          where: { returnId: row.id, goods: 'expected' },
        });
        // the statements of the form without the code that gave units up to this one
        const changed = await manualStatementsTakenOf(db, orderId);

        // the log accepts a line in the admin context only; the line names the buyer, as the line of a
        // payment given back late does
        await setAdminContext(db);
        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: orderId,
          action: 'OTHER',
          event: 'return.create',
          changes: [
            { field: 'returnId', old: null, new: row.id },
            { field: 'basis', old: null, new: 'withdrawal' },
            { field: 'items', old: null, new: units },
            // the journal is never cleaned: the words of the buyer stay on the statement only
            ...(description ? [{ field: 'described', old: null, new: true }] : []),
            ...(changed.length ? [{ field: 'takenFrom', old: null, new: changed }] : []),
            ...(after.status !== order.status
              ? [{ field: 'status', old: order.status, new: after.status }]
              : []),
          ],
        });

        return { returnId: row.id, sent: waiting > 0, changed };
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    const mapped = returnErrorOf(err);
    if (mapped !== err) throw mapped;

    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'ORDERS_WITHDRAW_UNEXPECTED' }, err);
  }

  // after the commit: the notice of the statement and of the statements it took units from, then the
  // money of an order that was not sent; a failure of either is logged, the statement stands and the
  // admin can give the money back
  await sendReturnReceivedEmail(made.returnId, log);
  for (const returnId of made.changed) await sendReturnChangedEmail(returnId, log);

  if (!made.sent) {
    try {
      await giveMoneyBack({ returnId: made.returnId, actor: null, log });
    } catch (err) {
      log.error({ ...failureOf(err), returnId: made.returnId }, 'return refund was not started');
    }
  }

  return tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });

    const order = await readOrderResponse(db, orderId);
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

    return mapOrderRowToResponse(order, await orderContextOf(db, [order]), 'buyer');
  });
}
