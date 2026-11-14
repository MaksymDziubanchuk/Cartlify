import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';

import type { RecordMoneyReceivedDto, ReturnDto } from 'types/dto/returns.dto.js';

// Root, or an admin root allowed to handle the money, records money the buyer gave the shop back
// outside the app for rows of a statement whose money the buyer had (goods paid ahead that never
// came, more than the statement owed), on the day it really came
// (record_money_received, db/05). The money journal gets one line money.received with the rows, the
// statement has that much less back; the journal of the admins gets the line of the actor with it.
// No mail: the buyer gave the money. The answer is the card of the statement

const REFUSALS: Record<string, () => Error> = {
  MONEY_RECEIVED_NOT_FOUND: () => new NotFoundError('MONEY_RECEIVED_NOT_FOUND'),
  MONEY_RECEIVED_INVALID: () => new BadRequestError('MONEY_RECEIVED_INVALID'),
  MONEY_RECEIVED_NOTE_REQUIRED: () => new BadRequestError('MONEY_RECEIVED_NOTE_REQUIRED'),
  MONEY_RECEIVED_AT_INVALID: () => new BadRequestError('MONEY_RECEIVED_AT_INVALID'),
  MONEY_RECEIVED_NOT_REFUNDED: () => new ConflictError('MONEY_RECEIVED_NOT_REFUNDED'),
  MONEY_RECEIVED_EXCEEDS: () => new ConflictError('MONEY_RECEIVED_EXCEEDS'),
  MONEY_RECEIVED_FORBIDDEN: () => new ForbiddenError('MONEY_RECEIVED_FORBIDDEN'),
};

export async function recordMoneyReceived({
  actorId,
  actorRole,
  returnId,
  items,
  method,
  note,
  at,
}: RecordMoneyReceivedDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('MONEY_RECEIVED_AT_INVALID');

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const [row] = await db.$queryRaw<
        { received: { id: number; orderId: number; amount: string } }[]
      >(Prisma.sql`
        select cartlify.record_money_received(
          ${returnId}::int,
          ${JSON.stringify(items)}::jsonb,
          ${method}::cartlify."OutsideMethod",
          ${note}::text,
          (${day.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ) as received
      `);
      const received = row!.received;

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: received.orderId,
        action: 'OTHER',
        event: 'return.money_received',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'moneyLogId', old: null, new: received.id },
          {
            field: 'received',
            old: null,
            new: { method, at: day.toISOString(), items, amount: received.amount },
          },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_MONEY_RECEIVED' });
      return card;
    });
  } catch (err) {
    const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
    throw refusal ? refusal() : err;
  }
}
