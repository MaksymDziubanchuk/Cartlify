import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@utils/errors.js';

import { findById } from './findById.service.js';

import type { OrderResponseDto, RecordCarrierMoneyDto } from 'types/dto/orders.dto.js';

// Root, or an admin root allowed to handle the money, records money a carrier paid the shop outside
// the app for a send of an order it lost or damaged, on the day it really came
// (record_carrier_money, db/05): one line money.received of the purpose shipping that names the
// send, money of the shop (no cost of the send, no statement counts it); the journal of the admins
// gets the line of the actor with it. The answer is the order

const REFUSALS: Record<string, () => Error> = {
  MONEY_RECEIVED_NOT_FOUND: () => new NotFoundError('MONEY_RECEIVED_NOT_FOUND'),
  MONEY_RECEIVED_INVALID: () => new BadRequestError('MONEY_RECEIVED_INVALID'),
  MONEY_RECEIVED_NOTE_REQUIRED: () => new BadRequestError('MONEY_RECEIVED_NOTE_REQUIRED'),
  MONEY_RECEIVED_AT_INVALID: () => new BadRequestError('MONEY_RECEIVED_AT_INVALID'),
  MONEY_RECEIVED_NOT_REFUNDED: () => new ConflictError('MONEY_RECEIVED_NOT_REFUNDED'),
  MONEY_RECEIVED_EXCEEDS: () => new ConflictError('MONEY_RECEIVED_EXCEEDS'),
  MONEY_RECEIVED_FORBIDDEN: () => new ForbiddenError('MONEY_RECEIVED_FORBIDDEN'),
};

export async function recordCarrierMoney({
  actorId,
  actorRole,
  orderId,
  shipmentId,
  amount,
  method,
  note,
  at,
}: RecordCarrierMoneyDto): Promise<OrderResponseDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('MONEY_RECEIVED_AT_INVALID');

  try {
    await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // the send is one of the order of the path
      const send = await db.orderShipment.findFirst({
        where: { id: shipmentId, orderId, returnId: null },
        select: { id: true },
      });
      if (!send) throw new NotFoundError('MONEY_RECEIVED_NOT_FOUND');

      const [row] = await db.$queryRaw<{ received: { id: number; amount: string } }[]>(Prisma.sql`
        select cartlify.record_carrier_money(
          ${shipmentId}::int,
          ${amount}::numeric,
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
        entityId: orderId,
        action: 'OTHER',
        event: 'order.carrier_money',
        changes: [
          { field: 'shipmentId', old: null, new: shipmentId },
          { field: 'moneyLogId', old: null, new: received.id },
          {
            field: 'received',
            old: null,
            new: { method, at: day.toISOString(), amount: received.amount },
          },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });
    });
  } catch (err) {
    const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
    throw refusal ? refusal() : err;
  }

  return findById({ actorId, actorRole, orderId });
}
