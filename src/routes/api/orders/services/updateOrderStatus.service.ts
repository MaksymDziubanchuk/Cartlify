import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import {
  ConflictError,
  ForbiddenError,
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import {
  buildShipmentData,
  mapOrderRowToResponse,
  expiredOfOrders,
  readOrderResponse,
  shipmentLogOf,
} from './helpers/index.js';
import { sendOrderNoticeEmail } from './helpers/sendOrderNoticeEmail.helper.js';
import {
  sendOrderStatusEmail,
  type OrderStatusMailLogger,
} from './helpers/sendOrderStatusEmail.helper.js';

import type { AuditEvent, WrittenEvent } from '@config/journalEvents.js';
import type { UpdateOrderStatusDto, OrderResponseDto, OrderStatus } from 'types/dto/orders.dto.js';

// the statuses an admin takes an order to, each with the statuses it may come from: the steps go on
// (paid, shipped, delivered) and one step back (delivered to shipped, shipped to paid). The database
// holds the same steps (trg_orders_update_columns)
const STEP_STATUSES = ['paid', 'shipped', 'delivered'] as const;
type StepStatus = (typeof STEP_STATUSES)[number];

const ALLOWED_FROM: Record<StepStatus, OrderStatus[]> = {
  paid: ['shipped'],
  shipped: ['paid', 'delivered'],
  delivered: ['shipped'],
};

const isStepStatus = (status: OrderStatus): status is StepStatus =>
  (STEP_STATUSES as readonly string[]).includes(status);

// the event of the line of a step: what the step is for the method of the order (a manual order goes
// to a carrier and is delivered, a pickup is ready and collected), and whether it came from the
// route of many
type StepEvents = Record<string, { one: AuditEvent; bulk: AuditEvent }>;
const STEP_EVENTS: Record<'manual' | 'pickup', StepEvents> = {
  manual: {
    'paid>shipped': { one: 'order.ship', bulk: 'order.ship_bulk' },
    'shipped>delivered': { one: 'order.deliver', bulk: 'order.deliver_bulk' },
    'shipped>paid': { one: 'order.ship_back', bulk: 'order.ship_back_bulk' },
    'delivered>shipped': { one: 'order.deliver_back', bulk: 'order.deliver_back_bulk' },
  },
  pickup: {
    'paid>shipped': { one: 'order.pickup_ready', bulk: 'order.pickup_ready_bulk' },
    'shipped>delivered': { one: 'order.pickup_collected', bulk: 'order.pickup_collected_bulk' },
    'shipped>paid': { one: 'order.pickup_ready_back', bulk: 'order.pickup_ready_back_bulk' },
    'delivered>shipped': {
      one: 'order.pickup_collected_back',
      bulk: 'order.pickup_collected_back_bulk',
    },
  },
};

// an admin moves an order one step. Shipping a manual order records the send (who carries it, the
// number, the link, what the shop pays the carrier, each only if known); a pickup is shipped when it
// is ready to be collected and has no send. A step back of a manual order takes the send back, and
// the admin says whether the cost of it stays owed (the carrier was used) or was a mistake. Every
// step goes to the admin log in the name of the admin with what it did; the buyer is mailed after
// the commit unless the account is deleted. A second request of the same step (a double click)
// finds the order moved on and is 409 with no second mail
export async function updateOrderStatus(
  { actorId, actorRole, orderId, status, shipment, keepShippingCost, bulk }: UpdateOrderStatusDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // a cancel returns the money and the stock, it goes through POST /:orderId/cancel
  if (!isStepStatus(status)) throw new BadRequestError('STATUS_INVALID');

  // what a request may carry: a send with the step to shipped, the choice with the step back to paid
  if (shipment !== undefined && status !== 'shipped')
    throw new BadRequestError('SHIPMENT_NOT_ALLOWED');
  if (keepShippingCost !== undefined && status !== 'paid') {
    throw new BadRequestError('KEEP_SHIPPING_COST_NOT_ALLOWED');
  }
  const send = shipment !== undefined ? buildShipmentData(shipment) : null;

  const orderIdRaw = Number(orderId);

  try {
    const from = await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // an admin sees every order: a missing one is not found, an order whose status does not
        // allow the step is a conflict with the reason, never "not found"
        const current = await db.order.findUnique({
          where: { id: orderIdRaw },
          select: {
            status: true,
            delivery: { select: { method: true } },
            // the send on its way
            shipments: {
              where: { rolledBackAt: null },
              orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                carrier: true,
                trackingNumber: true,
                trackingUrl: true,
                cost: true,
              },
            },
          },
        });
        if (!current) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: orderIdRaw });

        if (!ALLOWED_FROM[status].includes(current.status)) {
          throw new ConflictError('ORDER_STATUS_TRANSITION_INVALID', {
            status: current.status,
            requested: status,
          });
        }

        // a pickup has no carrier to record
        const pickup = current.delivery?.method === 'pickup';
        if (send && pickup) throw new BadRequestError('SHIPMENT_NOT_ALLOWED');

        // a step back of a manual order that has a send on its way: the cost of it stays owed or not,
        // the admin says which
        const onItsWay = current.shipments[0];
        if (status === 'paid') {
          if (!pickup && onItsWay && keepShippingCost === undefined) {
            throw new BadRequestError('KEEP_SHIPPING_COST_REQUIRED');
          }
          if ((pickup || !onItsWay) && keepShippingCost !== undefined) {
            throw new BadRequestError('KEEP_SHIPPING_COST_NOT_ALLOWED');
          }
        }

        // the step only from the status it was read in: a request that read the order before
        // another one moved it changes nothing (the update waits for the row, then finds the new
        // status); rls holds the same rule
        const moved = await db.order.updateMany({
          where: { id: orderIdRaw, status: current.status },
          data: { status },
        });
        if (moved.count !== 1) {
          throw new ConflictError('ORDER_STATUS_CHANGED', { orderId: orderIdRaw });
        }

        const changes: { field: string; old: unknown; new: unknown }[] = [
          { field: 'status', old: current.status, new: status },
        ];

        // shipped by hand: the send is recorded, with nothing known of it when nothing is said
        if (status === 'shipped' && current.status === 'paid' && !pickup) {
          const created = await db.orderShipment.create({
            data: { orderId: orderIdRaw, ...(send ?? buildShipmentData(undefined)) },
            select: {
              id: true,
              carrier: true,
              trackingNumber: true,
              trackingUrl: true,
              cost: true,
            },
          });
          changes.push({ field: 'shipment', old: null, new: shipmentLogOf(created) });
        }

        // taken back: the send stays as history, marked rolled back. Its cost stays owed (the carrier
        // was used), or the send was a mistake and cost nothing: 0, the cost it had stays in the log
        if (status === 'paid' && onItsWay) {
          const oldCost = onItsWay.cost === null ? null : Number(onItsWay.cost);
          await db.orderShipment.update({
            where: { id: onItsWay.id },
            data:
              keepShippingCost === true
                ? { rolledBackAt: new Date(), expense: true }
                : { rolledBackAt: new Date(), expense: false, cost: 0 },
          });
          changes.push(
            { field: 'shipment', old: shipmentLogOf(onItsWay), new: null },
            { field: 'shippingCostKept', old: null, new: keepShippingCost === true },
            ...(keepShippingCost === true ? [] : [{ field: 'shippingCost', old: oldCost, new: 0 }]),
          );
        }

        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: orderIdRaw,
          action: 'ORDER_STATUS_CHANGE',
          event: STEP_EVENTS[pickup ? 'pickup' : 'manual'][`${current.status}>${status}`]![
            bulk ? 'bulk' : 'one'
          ] as WrittenEvent<AuditEvent>,
          changes,
        });

        return current.status;
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    // the answer is read after the step, in a transaction of its own
    const result = await readOrder(actorId, actorRole, orderIdRaw);

    // the status is committed; the mail never undoes it, a failure is only logged
    if (status === 'shipped' && from === 'paid')
      await sendOrderStatusEmail(orderIdRaw, 'shipped', log);
    else if (status === 'delivered') await sendOrderStatusEmail(orderIdRaw, 'delivered', log);
    else if (status === 'paid') await sendOrderNoticeEmail(orderIdRaw, 'details_changed', log);
    else await sendOrderNoticeEmail(orderIdRaw, 'delivery_corrected', log);

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    throw new InternalError({ reason: 'ORDERS_UPDATE_STATUS_UNEXPECTED' }, err);
  }
}

// the order as the admin sees it: with its sends and weight
async function readOrder(
  actorId: UpdateOrderStatusDto['actorId'],
  actorRole: UpdateOrderStatusDto['actorRole'],
  orderId: number,
): Promise<OrderResponseDto> {
  return tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });

    const order = await readOrderResponse(db, orderId);
    if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_STATUS_UPDATE' });

    return mapOrderRowToResponse(order, await expiredOfOrders(db, [order]), 'admin');
  });
}
