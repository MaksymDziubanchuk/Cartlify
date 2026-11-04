import { Prisma } from '@prisma/client';

import { tx, isRetryableTxError } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { returnErrorOf } from '@routes/api/returns/services/helpers/returnErrors.helper.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse, orderContextOf, readOrderResponse } from './helpers/index.js';

import type { OrderResponseDto, ProvideReturnProofDto } from 'types/dto/orders.dto.js';

// The buyer writes how they sent the goods of their statement back: the carrier and the number of
// the parcel, and a link to follow it when there is one. The statement is then in the state "proof
// given" for the admin, who checks it. The buyer may correct it until the admin confirms it. The
// answer is their order
export async function provideReturnProof({
  actorId,
  actorRole,
  orderId,
  returnId,
  carrier,
  trackingNumber,
  trackingUrl,
}: ProvideReturnProofDto): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the statement is one of this order and of this buyer: the database does not find another's
        const statement = await db.orderReturn.findFirst({
          where: { id: returnId, orderId },
          select: { id: true },
        });
        if (!statement) throw new NotFoundError('RETURN_NOT_FOUND');

        await db.$executeRaw(Prisma.sql`
          select 1 as done from cartlify.provide_return_proof(
            ${returnId}::int, ${carrier}::text, ${trackingNumber}::text, ${trackingUrl ?? null}::text
          )
        `);

        // the log accepts a line in the admin context only; the line names the buyer
        await setAdminContext(db);
        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
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

        await setUserContext(db, { userId: actorId, role: actorRole });
        const order = await readOrderResponse(db, orderId);
        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_PROOF' });

        return mapOrderRowToResponse(order, await orderContextOf(db, [order]), 'buyer');
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

    throw new InternalError({ reason: 'ORDERS_RETURN_PROOF_UNEXPECTED' }, err);
  }
}
