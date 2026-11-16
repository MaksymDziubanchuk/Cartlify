import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError, getPgMessage } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { holdReasonsOf } from '@helpers/orderHolds.js';
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
  orderContextOf,
  readOrderResponse,
  recordShipmentCost,
  shipmentCostsOf,
  shipmentLogOf,
} from './helpers/index.js';
import {
  assertLaidOut,
  boxDataOf,
  itemsToSendOf,
  oneBoxOf,
  type BoxData,
  type BoxItem,
} from './helpers/parcelItems.helper.js';
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

const NO_SIZES = { weightGrams: null, lengthMm: null, widthMm: null, heightMm: null };

// the boxes of a parcel, numbered from 1 in the order given; the database checks the items
// (shipment_boxes_before_insert)
async function writeBoxes(
  db: Prisma.TransactionClient,
  shipmentId: number,
  boxes: readonly BoxData[],
): Promise<void> {
  await db.shipmentBox.createMany({
    data: boxes.map((box, i) => ({
      shipmentId,
      number: i + 1,
      weightGrams: box.weightGrams,
      lengthMm: box.lengthMm,
      widthMm: box.widthMm,
      heightMm: box.heightMm,
      items: box.items,
    })),
  });
}

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

// an admin moves an order one step. Shipping a manual order records its parcels (who carries each,
// the number, the link, each only if known; the boxes and what is in them, one box of every unit for
// the one parcel given without them) and what the shop pays the carrier for each, a line of the money
// journal in the same transaction (none while it is not known); an order of a carrier of the delivery
// provider is sent by hand with the parcels made for it before, which then count as taken
// (PARCELS_REQUIRED without them); a pickup is shipped when it is ready to be collected and has no
// send. An order something holds (orders.holds: a dispute, a refund by
// hand root has not decided on, a warning or a review of the provider) is not sent: the guard of
// orders refuses it and the admin is told the reasons. A step back of a manual order takes the send
// back, and the admin says whether the cost of it stays owed (the carrier was used) or was a
// mistake (the journal corrects it to nothing). Every step goes to the admin log in the name of the
// admin with what it did; the buyer is mailed after the commit unless the account is deleted. A
// second request of the same step (a double click) finds the order moved on and is 409 with no
// second mail
export async function updateOrderStatus(
  {
    actorId,
    actorRole,
    orderId,
    status,
    shipments,
    keepShippingCost,
    deliveredAt,
    bulk,
  }: UpdateOrderStatusDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // a cancel is a statement of return (POST /api/returns), no step of the status
  if (!isStepStatus(status)) throw new BadRequestError('STATUS_INVALID');

  // what a request may carry: a send with the step to shipped, the choice with the step back to paid
  if (shipments !== undefined && status !== 'shipped')
    throw new BadRequestError('SHIPMENT_NOT_ALLOWED');
  if (keepShippingCost !== undefined && status !== 'paid') {
    throw new BadRequestError('KEEP_SHIPPING_COST_NOT_ALLOWED');
  }
  // the moment the carrier delivered comes with the step to delivered only; the database checks it
  if (deliveredAt !== undefined && status !== 'delivered') {
    throw new BadRequestError('DELIVERED_AT_NOT_ALLOWED');
  }
  const sends =
    shipments !== undefined
      ? shipments.map((one) => ({
          data: buildShipmentData(one),
          boxes: one.boxes?.map(boxDataOf) ?? null,
        }))
      : null;

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
            // the parcels on their way, and the parcels of the provider made and not taken yet
            shipments: {
              where: {
                returnId: null,
                rolledBackAt: null,
                state: { notIn: ['void_pending', 'voided'] },
              },
              orderBy: { id: 'asc' },
              select: {
                id: true,
                carrier: true,
                trackingNumber: true,
                trackingUrl: true,
                state: true,
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

        // a pickup has no carrier to record; the parcels of a carrier of the provider are made by
        // the app (POST /api/orders/{orderId}/parcels), never written here
        const pickup = current.delivery?.method === 'pickup';
        const carrierOrder = current.delivery?.method === 'carrier';
        if (sends && (pickup || carrierOrder)) throw new BadRequestError('SHIPMENT_NOT_ALLOWED');

        // a step back of an order that has parcels on their way: the cost of them stays owed or not,
        // the admin says which
        // The parcels of a carrier of the provider are not taken back: their labels live at the
        // carrier, so a step back only says the carrier has not taken them yet (made again), and
        // their cost stays; a parcel the carrier moved further on (delivered, going back, back,
        // lost) keeps the order sent (PARCEL_STATE_INVALID)
        const onTheirWay = carrierOrder
          ? []
          : current.shipments.filter((one) => one.state !== 'created');
        if (status === 'paid') {
          if (!pickup && onTheirWay.length && keepShippingCost === undefined) {
            throw new BadRequestError('KEEP_SHIPPING_COST_REQUIRED');
          }
          if ((pickup || !onTheirWay.length) && keepShippingCost !== undefined) {
            throw new BadRequestError('KEEP_SHIPPING_COST_NOT_ALLOWED');
          }
          const further = current.shipments.find(
            (one) => carrierOrder && one.state !== 'created' && one.state !== 'sent',
          );
          if (further) {
            throw new ConflictError('PARCEL_STATE_INVALID', {
              shipmentId: further.id,
              state: further.state,
            });
          }
        }

        // what travels: the units less those statements brought back before; the live parcels of
        // a carrier must hold them all to be sent by hand, the ones only made and the ones the
        // carrier took already (its events came for some of them, or for all while something held
        // the order: the events move an order only when they come)
        const items =
          status === 'shipped' && current.status === 'paid' && !pickup
            ? await itemsToSendOf(db, orderIdRaw)
            : [];
        const made = current.shipments.filter((one) => one.state === 'created');
        if (status === 'shipped' && current.status === 'paid' && carrierOrder) {
          if (!current.shipments.length) throw new ConflictError('PARCELS_REQUIRED');
          const boxes = await db.shipmentBox.findMany({
            where: { shipmentId: { in: current.shipments.map((one) => one.id) } },
            select: { items: true },
          });
          try {
            assertLaidOut(
              boxes.map((box) => ({ ...NO_SIZES, items: box.items as BoxItem[] })),
              items,
            );
          } catch {
            throw new ConflictError('PARCELS_REQUIRED');
          }
        }

        // the parcels the admin gives, each with its boxes; the one parcel given without boxes (or
        // none given) holds one box of every unit
        const parcels = (sends ?? [{ data: buildShipmentData(undefined), boxes: null }]).map(
          (one, _i, all) => ({
            ...one,
            boxes: one.boxes ?? (all.length === 1 ? [oneBoxOf(items)] : null),
          }),
        );
        if (status === 'shipped' && current.status === 'paid' && !pickup && !carrierOrder) {
          if (parcels.some((one) => one.boxes === null)) {
            throw new BadRequestError('PARCEL_ITEMS_MISMATCH');
          }
          assertLaidOut(
            parcels.flatMap((one) => one.boxes!),
            items,
          );
        }

        // the step only from the status it was read in: a request that read the order before
        // another one moved it changes nothing (the update waits for the row, then finds the new
        // status); rls holds the same rule
        const moved = await db.order.updateMany({
          where: { id: orderIdRaw, status: current.status },
          data: {
            status,
            ...(deliveredAt !== undefined ? { deliveredAt: new Date(deliveredAt) } : {}),
          },
        });
        if (moved.count !== 1) {
          throw new ConflictError('ORDER_STATUS_CHANGED', { orderId: orderIdRaw });
        }

        const changes: { field: string; old: unknown; new: unknown }[] = [
          { field: 'status', old: current.status, new: status },
          // the moment the admin gave for the delivery, the one of the carrier
          ...(deliveredAt !== undefined
            ? [{ field: 'deliveredAt', old: null, new: new Date(deliveredAt).toISOString() }]
            : []),
        ];

        // shipped by hand: each parcel is recorded with its boxes, with nothing known of it when
        // nothing is said, and what the shop pays the carrier is a line of the money journal once
        // it is known
        if (status === 'shipped' && current.status === 'paid' && !pickup && !carrierOrder) {
          for (const parcel of parcels) {
            const { cost, ...details } = parcel.data;
            const created = await db.orderShipment.create({
              data: { orderId: orderIdRaw, ...details },
              select: { id: true, carrier: true, trackingNumber: true, trackingUrl: true },
            });
            await writeBoxes(db, created.id, parcel.boxes!);
            if (cost !== null) await recordShipmentCost(db, created.id, cost);
            changes.push({
              field: 'shipment',
              old: null,
              new: shipmentLogOf({ ...created, cost }),
            });
          }
        }

        // an order of a carrier sent by hand: the parcels still only made count as taken by the
        // carrier now, the events that come later change nothing of them; a parcel an event moved
        // meanwhile keeps its state and its time
        if (status === 'shipped' && current.status === 'paid' && carrierOrder) {
          await db.orderShipment.updateMany({
            where: { id: { in: made.map((one) => one.id) }, state: 'created' },
            data: { state: 'sent', shippedAt: new Date() },
          });
          changes.push({ field: 'parcelsSent', old: null, new: made.map((one) => one.id) });
        }

        // delivered by hand: the parcels of the provider on their way are delivered too, and back
        if (carrierOrder && (status === 'delivered' || current.status === 'delivered')) {
          await db.orderShipment.updateMany({
            where: {
              id: { in: current.shipments.map((one) => one.id) },
              state: status === 'delivered' ? 'sent' : 'delivered',
            },
            data: { state: status === 'delivered' ? 'delivered' : 'sent' },
          });
        }

        // an order of a carrier taken back: its parcels are only made again, the events of the
        // carrier move them from there
        if (status === 'paid' && carrierOrder) {
          const sent = current.shipments.filter((one) => one.state === 'sent');
          await db.orderShipment.updateMany({
            where: { id: { in: sent.map((one) => one.id) }, state: 'sent' },
            data: { state: 'created', shippedAt: null },
          });
          changes.push({ field: 'parcelsSent', old: sent.map((one) => one.id), new: null });
        }

        // taken back: every parcel on its way stays as history, marked rolled back. Its cost stays
        // owed (the carrier was used), or the send was a mistake and cost nothing: the journal
        // corrects the cost it had to 0 with a line of its own, and the admin log keeps the cost it
        // had
        if (status === 'paid' && onTheirWay.length) {
          const oldCosts = await shipmentCostsOf(
            db,
            onTheirWay.map((one) => one.id),
          );
          for (const parcel of onTheirWay) {
            const oldCost = oldCosts.get(parcel.id) ?? null;
            await db.orderShipment.update({
              where: { id: parcel.id },
              data: { rolledBackAt: new Date(), expense: keepShippingCost === true },
            });
            if (keepShippingCost !== true) await recordShipmentCost(db, parcel.id, 0);
            changes.push(
              { field: 'shipment', old: shipmentLogOf({ ...parcel, cost: oldCost }), new: null },
              ...(keepShippingCost === true
                ? []
                : [{ field: 'shippingCost', old: oldCost, new: 0 }]),
            );
          }
          changes.push({ field: 'shippingCostKept', old: null, new: keepShippingCost === true });
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

    // something holds the order from its sending (the guard of orders, db/05): the admin is told why
    if (getPgMessage(err) === 'ORDER_ON_HOLD') {
      throw new ConflictError('ORDER_ON_HOLD', {
        orderId: orderIdRaw,
        holds: await holdReasonsOfOrder(actorId, actorRole, orderIdRaw),
      });
    }

    // a parcel the buyer refused is on its way back (the guard of orders, db/05)
    if (getPgMessage(err) === 'ORDER_HAS_OPEN_REFUSAL') {
      throw new ConflictError('ORDER_HAS_OPEN_REFUSAL', { orderId: orderIdRaw });
    }

    // the moment of the delivery the admin gave is before the send or of the future (db/05)
    if (getPgMessage(err) === 'ORDER_DELIVERED_AT_INVALID') {
      throw new BadRequestError('ORDER_DELIVERED_AT_INVALID', { orderId: orderIdRaw });
    }

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    throw new InternalError({ reason: 'ORDERS_UPDATE_STATUS_UNEXPECTED' }, err);
  }
}

// the reasons that hold the order, each once, read after the guard refused the step
async function holdReasonsOfOrder(
  actorId: UpdateOrderStatusDto['actorId'],
  actorRole: UpdateOrderStatusDto['actorRole'],
  orderId: number,
) {
  return tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });

    const order = await db.order.findUnique({ where: { id: orderId }, select: { holds: true } });
    return holdReasonsOf(order?.holds);
  });
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

    return mapOrderRowToResponse(order, await orderContextOf(db, [order], 'admin'), 'admin');
  });
}
