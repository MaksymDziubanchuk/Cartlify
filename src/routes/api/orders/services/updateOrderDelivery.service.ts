import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { isPhone } from '@helpers/profileText.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import {
  buildAddressData,
  isRecipientName,
  mapOrderRowToResponse,
  expiredOfOrders,
  readOrderResponse,
} from './helpers/index.js';
import { sendOrderNoticeEmail } from './helpers/sendOrderNoticeEmail.helper.js';
import type { OrderStatusMailLogger } from './helpers/sendOrderStatusEmail.helper.js';

import type { OrderResponseDto, UpdateOrderDeliveryDto } from 'types/dto/orders.dto.js';

const PERSON_FIELDS = ['recipientFirstName', 'recipientLastName', 'recipientPhone'] as const;
const ADDRESS_FIELDS = ['country', 'postalCode', 'city', 'street', 'house', 'apartment'] as const;

// an admin corrects where a paid order goes and to whom, until it is sent: the buyer writes to the
// shop that the apartment is wrong. The method and the price stay (a buyer who wants another method
// cancels and orders again). An address is sent whole and is checked the way the confirmation checks
// it; the person can be changed alone. Every change goes to the admin log with the old and the new
// value of each field and the buyer is mailed; a request that changes nothing writes no line and
// sends no mail
export async function updateOrderDelivery(
  { actorId, actorRole, orderId, changes }: UpdateOrderDeliveryDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // fastify drops a field the schema does not name: a body of only such a field says nothing
  if (Object.values(changes).every((value) => value === undefined)) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }

  try {
    const changed = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const order = await db.order.findUnique({
          where: { id: orderId },
          select: { status: true, delivery: true },
        });
        if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

        // until it is sent: the order is paid and has where it goes
        if (order.status !== 'paid' || !order.delivery) {
          throw new ConflictError('ORDER_DELIVERY_NOT_EDITABLE', { status: order.status });
        }
        const current = order.delivery;

        // the person: a name has a letter and no digit, the phone is in the international form
        const next: Record<string, string | null> = {};
        if (changes.recipientFirstName !== undefined) {
          const name = changes.recipientFirstName.trim();
          if (!isRecipientName(name)) throw new BadRequestError('RECIPIENT_FIRST_NAME_INVALID');
          next.recipientFirstName = name;
        }
        if (changes.recipientLastName !== undefined) {
          const name = changes.recipientLastName.trim();
          if (!isRecipientName(name)) throw new BadRequestError('RECIPIENT_LAST_NAME_INVALID');
          next.recipientLastName = name;
        }
        if (changes.recipientPhone !== undefined) {
          if (!isPhone(changes.recipientPhone))
            throw new BadRequestError('RECIPIENT_PHONE_INVALID');
          next.recipientPhone = changes.recipientPhone;
        }

        // the address: whole, for the manual method only
        if (changes.address !== undefined) {
          if (current.method !== 'manual')
            throw new BadRequestError('DELIVERY_ADDRESS_NOT_ALLOWED');
          Object.assign(next, buildAddressData(changes.address));
        }

        // an empty note removes it
        if (changes.note !== undefined) next.note = changes.note.trim() || null;

        const diff = [...PERSON_FIELDS, ...ADDRESS_FIELDS, 'note' as const]
          .filter((field) => field in next && next[field] !== current[field])
          .map((field) => ({ field, old: current[field], new: next[field] }));
        if (diff.length === 0) return false;

        await db.orderDelivery.update({ where: { orderId }, data: next });

        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: orderId,
          action: 'ORDER_DELIVERY_CHANGE',
          event: 'order.delivery_change',
          changes: diff,
        });

        return true;
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    const result = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      const row = await readOrderResponse(db, orderId);
      if (!row) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_DELIVERY_UPDATE' });

      return mapOrderRowToResponse(row, await expiredOfOrders(db, [row]), 'admin');
    });

    // the change is committed; the mail never undoes it, a failure is only logged
    if (changed) await sendOrderNoticeEmail(orderId, 'delivery_data_changed', log);

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'ORDERS_UPDATE_DELIVERY_UNEXPECTED' }, err);
  }
}
