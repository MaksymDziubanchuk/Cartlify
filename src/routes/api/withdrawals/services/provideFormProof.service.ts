import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import { BadRequestError, InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import type {
  WithdrawalProofBodyDto,
  WithdrawalReceivedResponseDto,
} from 'types/dto/withdrawals.dto.js';

// Any failure is one answer, whatever it was: a visitor learns nothing about orders and statements
const rejected = () => new BadRequestError('WITHDRAWAL_REJECTED');

// A buyer writes how they sent the goods back with the code of the order from the link of a mail:
// the carrier and the number of the parcel, and a link to follow it. Only for a statement of this
// order that came from an account or from a form with a code (the database refuses the others, as
// it refuses one that is closed, one with nothing left to wait for and one the shop confirmed). The
// code is checked here, by the server, before the database is asked
export async function provideFormProof({
  orderId,
  code,
  returnId,
  carrier,
  trackingNumber,
  trackingUrl,
  buyerPaid,
}: WithdrawalProofBodyDto): Promise<WithdrawalReceivedResponseDto> {
  if (!isWithdrawalCode(orderId, code)) throw rejected();

  try {
    await tx(
      async (db) => {
        await setAdminContext(db);
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const statement = await db.orderReturn.findFirst({
          where: { id: returnId, orderId },
          select: { id: true, order: { select: { userId: true } } },
        });
        if (!statement) throw rejected();

        await db.$executeRaw(Prisma.sql`
          select 1 as done from cartlify.provide_return_proof(
            ${returnId}::int, ${carrier}::text, ${trackingNumber}::text, ${trackingUrl ?? null}::text,
            ${buyerPaid ?? null}::numeric
          )
        `);

        // the line names the buyer of the order, as the line of a payment given back late does
        await writeAdminAuditLog(db, {
          actorId: statement.order.userId,
          actorRole: 'USER',
          entityType: 'order',
          entityId: orderId,
          action: 'OTHER',
          event: 'return.proof_provide',
          changes: [
            { field: 'returnId', old: null, new: returnId },
            // the number and the link of the parcel stay on the statement, which is cleaned after
            // its term; the journal is never cleaned, so it keeps the carrier only
            { field: 'proof', old: null, new: { carrier } },
          ],
        });
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
  } catch (err) {
    if (err instanceof ResourceBusyError || isRetryableTxError(err)) throw new ResourceBusyError();
    if (err instanceof InternalError) throw err;
    if (isAppError(err) || returnErrorOf(err) !== err) throw rejected();

    throw new InternalError({ reason: 'WITHDRAWALS_PROOF_UNEXPECTED' }, err);
  }

  return { received: true };
}
