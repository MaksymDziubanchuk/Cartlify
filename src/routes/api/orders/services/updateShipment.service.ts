import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse, expiredOfOrders, readOrderResponse } from './helpers/index.js';
import { sendOrderNoticeEmail } from './helpers/sendOrderNoticeEmail.helper.js';
import type { OrderStatusMailLogger } from './helpers/sendOrderStatusEmail.helper.js';

import type { OrderResponseDto, UpdateShipmentDto } from 'types/dto/orders.dto.js';

// a text of a send as the admin wrote it: not sent keeps what the send has, null clears it, a text
// is the text without the spaces around it, and spaces only is a mistake
function nextText(
  sent: string | null | undefined,
  current: string | null,
  invalidCode: string,
): string | null {
  if (sent === undefined) return current;
  if (sent === null) return null;

  const text = sent.trim();
  if (!text) throw new BadRequestError(invalidCode);

  return text;
}

// an admin writes what the shop pays the carrier when the invoice comes, and corrects the carrier,
// the number and the link of a send on its way. The details are changed only on the send of a
// shipped order that was not taken back, and the buyer is mailed all of them; the cost is written
// while the shop owes the carrier for the send, whatever became of the order, and is never mailed.
// Every change goes to the admin log with the old and the new value; a request that changes
// nothing writes no line and sends no mail
export async function updateShipment(
  { actorId, actorRole, orderId, shipmentId, changes }: UpdateShipmentDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // fastify drops a field the schema does not name: a body of only such a field says nothing
  if (Object.values(changes).every((value) => value === undefined)) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }

  try {
    const detailsChanged = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const order = await db.order.findUnique({
          where: { id: orderId },
          select: { status: true },
        });
        if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

        // the row is locked: two corrections at once do not mix their fields
        const [send] = await db.$queryRaw<
          {
            id: number;
            carrier: string | null;
            trackingNumber: string | null;
            trackingUrl: string | null;
            cost: Prisma.Decimal | null;
            expense: boolean;
            rolledBackAt: Date | null;
          }[]
        >`select id, carrier, "trackingNumber", "trackingUrl", cost, expense, "rolledBackAt"
          from cartlify.order_shipments
          where id = ${shipmentId}::int and "orderId" = ${orderId}::int
          for update`;
        if (!send) throw new NotFoundError('SHIPMENT_NOT_FOUND', { orderId, shipmentId });

        const carrier = nextText(changes.carrier, send.carrier, 'SHIPMENT_CARRIER_INVALID');
        const trackingNumber = nextText(
          changes.trackingNumber,
          send.trackingNumber,
          'SHIPMENT_NUMBER_INVALID',
        );
        const trackingUrl =
          changes.trackingUrl === undefined ? send.trackingUrl : changes.trackingUrl;
        const cost =
          changes.cost === undefined
            ? send.cost === null
              ? null
              : Number(send.cost)
            : changes.cost;

        // the send holds together: a number and a link each name their carrier
        if ((trackingNumber || trackingUrl) && !carrier) {
          throw new BadRequestError('SHIPMENT_CARRIER_REQUIRED');
        }

        // the details the buyer is mailed, and the cost, which the buyer never sees: each goes to the
        // admin log as an event of its own
        const tracking: { field: string; old: unknown; new: unknown }[] = [];
        const same = <T>(a: T, b: T) => a === b;
        if (!same(carrier, send.carrier))
          tracking.push({ field: 'carrier', old: send.carrier, new: carrier });
        if (!same(trackingNumber, send.trackingNumber)) {
          tracking.push({ field: 'trackingNumber', old: send.trackingNumber, new: trackingNumber });
        }
        if (!same(trackingUrl, send.trackingUrl)) {
          tracking.push({ field: 'trackingUrl', old: send.trackingUrl, new: trackingUrl });
        }
        const details = tracking.length > 0;

        const oldCost = send.cost === null ? null : Number(send.cost);
        const costChanged = !same(cost, oldCost);

        if (!details && !costChanged) return false;

        // the details of a send that is on its way: the order is shipped and the send not taken back
        if (details && (send.rolledBackAt !== null || order.status !== 'shipped')) {
          throw new ConflictError('SHIPMENT_NOT_EDITABLE', {
            orderId,
            shipmentId,
            status: order.status,
          });
        }

        // the cost of a send the shop owes the carrier for
        if (costChanged && !send.expense) {
          throw new ConflictError('SHIPMENT_COST_NOT_OWED', { orderId, shipmentId });
        }

        await db.orderShipment.update({
          where: { id: shipmentId },
          data: { carrier, trackingNumber, trackingUrl, cost },
        });

        const sendLine = { field: 'shipment', old: shipmentId, new: shipmentId };
        if (details) {
          await writeAdminAuditLog(db, {
            actorId,
            actorRole,
            entityType: 'order',
            entityId: orderId,
            action: 'ORDER_SHIPMENT_CHANGE',
            event: 'order.shipment_tracking_change',
            changes: [sendLine, ...tracking],
          });
        }
        if (costChanged) {
          await writeAdminAuditLog(db, {
            actorId,
            actorRole,
            entityType: 'order',
            entityId: orderId,
            action: 'ORDER_SHIPMENT_CHANGE',
            event: 'order.shipment_cost_change',
            changes: [sendLine, { field: 'cost', old: oldCost, new: cost }],
          });
        }

        return details;
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
      if (!row) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_SHIPMENT_UPDATE' });

      return mapOrderRowToResponse(row, await expiredOfOrders(db, [row]), 'admin');
    });

    // the change is committed; the mail never undoes it, a failure is only logged
    if (detailsChanged) await sendOrderNoticeEmail(orderId, 'shipment_changed', log);

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'ORDERS_UPDATE_SHIPMENT_UNEXPECTED' }, err);
  }
}
