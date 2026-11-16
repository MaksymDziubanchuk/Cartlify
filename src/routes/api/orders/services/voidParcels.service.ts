import type { Role } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';
import { deliveryProvider } from '@providers/delivery/index.js';
import { ConflictError, NotFoundError } from '@utils/errors.js';

import { mapOrderRowToResponse, orderContextOf, readOrderResponse } from './helpers/index.js';

import type { OrderResponseDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// The void of a parcel of the delivery provider the carrier never took (decision 10 of the delivery):
// the provider is asked to void it when its carrier can be asked; then the app closes it, its cost
// taken back (void_order_parcel, db/05). A carrier that cannot be asked (or a provider out of reach)
// leaves it waiting for its void, the admin cancels it in the dashboard of the carrier and confirms

type Log = Pick<FastifyBaseLogger, 'warn'>;
type Actor = { actorId: UserId; actorRole: Role };

const BATCH = 20;

type PendingParcel = { id: number; orderId: number; providerParcelId: string; carrier: string };

// asks the provider for one parcel: voided now, left (its carrier cannot be asked), or failed (the
// provider did not answer)
async function voidAtProvider(
  parcel: PendingParcel,
  log: Log,
): Promise<'voided' | 'left' | 'failed'> {
  try {
    const result = await deliveryProvider.voidParcel({
      parcelId: parcel.providerParcelId,
      carrierName: parcel.carrier,
    });
    return result === 'voided' ? 'voided' : 'left';
  } catch (err) {
    log.warn(
      { ...failureOf(err), shipmentId: parcel.id },
      'the delivery provider did not void a parcel',
    );
    return 'failed';
  }
}

// the parcel closed as voided, its cost taken back; false when it moved on meanwhile (the carrier
// took it after all, an event made it sent): the void is no longer the app's to write
async function closeVoided(shipmentId: number, actor: Actor | null, log: Log): Promise<boolean> {
  try {
    await tx(async (db) => {
      if (actor) await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
      else await setAdminContext(db);
      await db.$queryRaw`select cartlify.void_order_parcel(${shipmentId}::int) as result`;
    });
    return true;
  } catch (err) {
    if (getPgMessage(err) !== 'ORDER_PARCEL_STATE_INVALID') throw err;
    log.warn({ shipmentId }, 'a parcel voided at the provider moved on before its void');
    return false;
  }
}

// the sweep of the worker: every parcel waiting for its void, the oldest first, a batch after
// another (the ones of a carrier that cannot be asked wait for an admin and never keep the others
// from their turn); a provider that does not answer ends the sweep, the next one starts over. How
// many it voided. A test keeps it to its own orders
export async function voidPendingParcels(
  log: Log,
  opts: { orderId?: number; orderIds?: number[]; batch?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? BATCH;
  let voided = 0;
  let after = 0;

  for (;;) {
    const from = after;
    const pending = await tx(async (db) => {
      await setAdminContext(db);
      return db.orderShipment.findMany({
        where: {
          id: { gt: from },
          state: 'void_pending',
          providerParcelId: { not: null },
          ...(opts.orderId === undefined ? {} : { orderId: opts.orderId }),
          ...(opts.orderIds === undefined ? {} : { orderId: { in: opts.orderIds } }),
        },
        orderBy: { id: 'asc' },
        take: batch,
        select: { id: true, orderId: true, providerParcelId: true, carrier: true },
      });
    });

    for (const parcel of pending) {
      const one = {
        ...parcel,
        providerParcelId: parcel.providerParcelId!,
        carrier: parcel.carrier ?? '',
      };
      const result = await voidAtProvider(one, log);
      if (result === 'failed') return voided;
      if (result === 'voided' && (await closeVoided(parcel.id, null, log))) voided += 1;
    }

    if (pending.length < batch) return voided;
    after = pending[pending.length - 1]!.id;
  }
}

async function readAdminOrder(actor: Actor, orderId: number): Promise<OrderResponseDto> {
  return tx(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    const row = await readOrderResponse(db, orderId);
    if (!row) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });
    return mapOrderRowToResponse(row, await orderContextOf(db, [row], 'admin'), 'admin');
  });
}

// POST /api/orders/:orderId/parcels/void: an admin made the parcels wrong and makes them again; each
// parcel only made waits for its void, the provider voids the ones it can at once
export async function voidOrderParcels(
  args: Actor & { orderId: number; shipmentId?: number },
  log: Log,
): Promise<OrderResponseDto> {
  const parcels = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const order = await db.order.findUnique({
      where: { id: args.orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: args.orderId });

    const made = await db.orderShipment.findMany({
      where: {
        orderId: args.orderId,
        state: 'created',
        providerParcelId: { not: null },
        // one parcel when it is named, else every one only made
        ...(args.shipmentId === undefined ? {} : { id: args.shipmentId }),
      },
      select: { id: true, orderId: true, providerParcelId: true, carrier: true },
    });
    if (!made.length) throw new ConflictError('PARCELS_NOT_VOIDABLE');

    // only the ones still made: a parcel the carrier took meanwhile is sent
    await db.orderShipment.updateMany({
      where: { id: { in: made.map((one) => one.id) }, state: 'created' },
      data: { state: 'void_pending' },
    });
    await writeAdminAuditLog(db, {
      actorId: args.actorId,
      actorRole: args.actorRole,
      entityType: 'order',
      entityId: args.orderId,
      action: 'ORDER_SHIPMENT_CHANGE',
      event: 'order.parcel_void',
      changes: [{ field: 'parcels', old: made.map((one) => one.id), new: 'void_pending' }],
    });
    return made;
  });

  for (const parcel of parcels) {
    const one = {
      ...parcel,
      providerParcelId: parcel.providerParcelId!,
      carrier: parcel.carrier ?? '',
    };
    if ((await voidAtProvider(one, log)) === 'voided') await closeVoided(parcel.id, args, log);
  }

  return readAdminOrder(args, args.orderId);
}

// POST /api/orders/:orderId/shipments/:shipmentId/void-confirmation: the admin cancelled the parcel
// in the dashboard of the carrier; the app closes it, its cost taken back
export async function confirmParcelVoid(
  args: Actor & { orderId: number; shipmentId: number },
): Promise<OrderResponseDto> {
  await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const parcel = await db.orderShipment.findFirst({
      where: { id: args.shipmentId, orderId: args.orderId, providerParcelId: { not: null } },
      select: { state: true },
    });
    if (!parcel) throw new NotFoundError('ORDER_SHIPMENT_NOT_FOUND');
    if (parcel.state !== 'void_pending') {
      throw new ConflictError('PARCEL_STATE_INVALID', { state: parcel.state });
    }
    try {
      await db.$queryRaw`select cartlify.void_order_parcel(${args.shipmentId}::int) as result`;
    } catch (err) {
      // another admin confirmed it, or an event moved it on, since it was read
      if (getPgMessage(err) === 'ORDER_PARCEL_STATE_INVALID') {
        throw new ConflictError('PARCEL_STATE_INVALID');
      }
      throw err;
    }
    await writeAdminAuditLog(db, {
      actorId: args.actorId,
      actorRole: args.actorRole,
      entityType: 'order',
      entityId: args.orderId,
      action: 'ORDER_SHIPMENT_CHANGE',
      event: 'order.parcel_void_confirm',
      changes: [{ field: 'parcel', old: args.shipmentId, new: 'voided' }],
    });
  });

  return readAdminOrder(args, args.orderId);
}
