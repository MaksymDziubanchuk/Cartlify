import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { getPgMessage, isRetryableTxError, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import { withdrawalItemsOf } from '@routes/api/orders/services/helpers/withdrawalItems.helper.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import {
  manualStatementsTakenOf,
  sendReturnChangedEmail,
} from '@routes/api/returns/services/helpers/sendReturnChangedEmail.helper.js';
import { sendReturnReceivedEmail } from '@routes/api/returns/services/helpers/sendReturnReceivedEmail.helper.js';
import { giveMoneyBack } from '@routes/api/returns/services/refundReturn.service.js';
import {
  BadRequestError,
  ConflictError,
  InternalError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';

import { factsMatch, formOrderOf } from './helpers/formFacts.helper.js';

import type {
  WithdrawalFormDto,
  WithdrawalReceivedResponseDto,
} from 'types/dto/withdrawals.dto.js';

// Any failure of the form is one answer, whatever it was: a visitor learns nothing about orders
const rejected = () => new BadRequestError('WITHDRAWAL_REJECTED');

// A buyer withdraws through the public form: a person whose account is deleted, or who has not got
// the mail at hand. The form names the order, the facts of its recipient (checked against the
// delivery of the order as POST /api/withdrawals/items checks them: with the code the name, without
// it the name, the phone and the country and the postal code of an address) and an email for the
// answers. With the code of the order from the link of a mail the
// statement is the one of an account (`form_code`): a paid order that was not sent gets its goods
// back at once and the money follows, as from the account. Without it the statement waits for an
// admin who checks it by hand (`form_manual`), nothing is automatic: a person who knows an order
// number and the name of its recipient can only open a statement, no money moves without the parcel
// or a decision of the admin. A statement with the code takes over the units such a statement holds,
// and its person is told. Every failure is the same answer (WITHDRAWAL_REJECTED)
export async function submitWithdrawalForm({
  orderId,
  recipientName,
  email,
  code,
  phone,
  country,
  postalCode,
  items,
  description,
  log,
}: WithdrawalFormDto): Promise<WithdrawalReceivedResponseDto> {
  const viaCode = isWithdrawalCode(orderId, code);

  let made: { returnId: number; goodsBack: boolean; changed: number[] };
  try {
    made = await tx(
      async (db) => {
        await setAdminContext(db);
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const order = await formOrderOf(db, orderId);
        if (
          !order ||
          !factsMatch(order.delivery, { orderId, recipientName, code, phone, country, postalCode })
        ) {
          throw rejected();
        }

        const units = await withdrawalItemsOf(db, order, items, viaCode);

        const [row] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
          select cartlify.create_return(
            ${orderId}::int,
            ${JSON.stringify(units)}::jsonb,
            ${viaCode ? 'form_code' : 'form_manual'}::cartlify."ReturnSource",
            'withdrawal'::cartlify."ReturnBasis",
            null::cartlify."ReturnReason",
            ${description ?? null}::text,
            ${recipientName.trim().slice(0, 200)}::text,
            ${email.trim()}::text,
            null::timestamp,
            null::int,
            ${env.WITHDRAWAL_GRACE_DAYS}::int,
            ${env.SHOP_TIME_ZONE}::text
          ) as id
        `);
        if (!row) throw new InternalError({ reason: 'RETURN_NOT_MADE' });

        // the statements of the form without the code that gave units up to one with the code
        const changed = viaCode ? await manualStatementsTakenOf(db, orderId) : [];

        // the line names the buyer of the order, as the line of a payment given back late does
        await writeAdminAuditLog(db, {
          actorId: order.userId,
          actorRole: 'USER',
          entityType: 'order',
          entityId: orderId,
          action: 'OTHER',
          event: 'return.create',
          changes: [
            { field: 'returnId', old: null, new: row.id },
            { field: 'basis', old: null, new: 'withdrawal' },
            { field: 'source', old: null, new: viaCode ? 'form_code' : 'form_manual' },
            { field: 'items', old: null, new: units },
            // the journal is never cleaned: the words of the buyer stay on the statement only
            ...(description ? [{ field: 'described', old: null, new: true }] : []),
            ...(changed.length ? [{ field: 'takenFrom', old: null, new: changed }] : []),
          ],
        });

        const waiting = await db.orderReturnItem.count({
          where: { returnId: row.id, goods: 'expected' },
        });

        return { returnId: row.id, goodsBack: viaCode && waiting === 0, changed };
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
  } catch (err) {
    // a lock that did not come in time or a transaction out of its time is not a refusal: the buyer
    // tries again; a fault of the server stays one
    if (err instanceof ResourceBusyError || isRetryableTxError(err)) throw new ResourceBusyError();
    if (err instanceof InternalError) throw err;
    // the facts matched: one statement without the code waits for the check of an admin, the
    // visitor is told so and how to withdraw at once (the link of a mail, the account)
    if (getPgMessage(err) === 'RETURN_MANUAL_UNDER_REVIEW') {
      throw new ConflictError('WITHDRAWAL_UNDER_REVIEW');
    }
    // a refusal of the order, the period, the units or the database is one answer for all
    if (isAppError(err) || returnErrorOf(err) !== err) throw rejected();

    throw new InternalError({ reason: 'WITHDRAWALS_FORM_UNEXPECTED' }, err);
  }

  // after the commit: the notice of the statement and of the statements it took units from, then the
  // money of an order that was not sent; a failure of either is logged, the statement stands
  await sendReturnReceivedEmail(made.returnId, log);
  for (const returnId of made.changed) await sendReturnChangedEmail(returnId, log);

  if (made.goodsBack) {
    try {
      await giveMoneyBack({ returnId: made.returnId, actor: null, log });
    } catch (err) {
      log.error({ ...failureOf(err), returnId: made.returnId }, 'return refund was not started');
    }
  }

  return { received: true };
}
