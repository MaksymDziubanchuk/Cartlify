import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { customsNeededFor, productsWithoutCustomsData } from '@helpers/customs.js';
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
  orderContextOf,
  readOrderResponse,
} from './helpers/index.js';
import { sendOrderNoticeEmail } from './helpers/sendOrderNoticeEmail.helper.js';
import type { OrderStatusMailLogger } from './helpers/sendOrderStatusEmail.helper.js';

import type { Role } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { sendsToAddress } from '@config/deliveryMethods.js';

import { carrierOptionsFor, cartForDelivery, optionOf } from './helpers/carrierQuotes.helper.js';

import type { OrderResponseDto, UpdateOrderDeliveryDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

const PERSON_FIELDS = ['recipientFirstName', 'recipientLastName', 'recipientPhone'] as const;
const ADDRESS_FIELDS = ['country', 'postalCode', 'city', 'street', 'house', 'apartment'] as const;
const CARRIER_FIELDS = ['method', 'carrierName', 'carrierService', 'carrierConnection'] as const;

// the carrier the admin picks is one of the prices of the delivery provider for the order to the
// address (the new one, or the one it has); a provider that does not answer is 503
async function assertCarrierPriced(
  actorId: UserId,
  actorRole: Role,
  orderId: number,
  changes: UpdateOrderDeliveryDto['changes'],
  log: FastifyBaseLogger,
): Promise<void> {
  const read = await tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });
    const delivery = await db.orderDelivery.findUnique({
      where: { orderId },
      select: {
        method: true,
        country: true,
        postalCode: true,
        city: true,
        street: true,
        house: true,
        apartment: true,
      },
    });
    return delivery ? { delivery, cart: await cartForDelivery(db, orderId) } : null;
  });
  if (!read || read.delivery.method !== 'carrier' || !read.cart.box) return;

  const address = changes.address
    ? buildAddressData(changes.address)
    : {
        country: read.delivery.country!,
        postalCode: read.delivery.postalCode,
        city: read.delivery.city!,
        street: read.delivery.street!,
        house: read.delivery.house!,
        apartment: read.delivery.apartment,
      };
  const options = await carrierOptionsFor(
    { address, box: read.cart.box, lines: read.cart.lines, value: read.cart.itemsTotal },
    log,
    { fresh: true },
  );
  const picked = optionOf(options, {
    carrierName: changes.carrier!.name.trim(),
    carrierService: changes.carrier!.service.trim(),
    connection: changes.carrier!.connection.trim(),
  });
  if (!picked) throw new ConflictError('DELIVERY_SERVICE_UNAVAILABLE');
}

// an admin corrects where a paid order goes and to whom, until it is sent: the buyer writes to the
// shop that the apartment is wrong. The price stays, and the method (a buyer who wants another method
// cancels and orders again), but for an order of a carrier of the delivery provider before its
// parcels are made: another carrier of the prices of the provider now (the one the buyer picked is
// gone, or refuses the address), or sent by hand outside the provider (manual). An address is sent whole and is checked the way the confirmation checks
// it; the person can be changed alone. Every change goes to the admin log with the old and the new
// value of each field and the buyer is mailed; a request that changes nothing writes no line and
// sends no mail
export async function updateOrderDelivery(
  { actorId, actorRole, orderId, changes, log: requestLog }: UpdateOrderDeliveryDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // fastify drops a field the schema does not name: a body of only such a field says nothing
  if (Object.values(changes).every((value) => value === undefined)) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }

  // another carrier: one of the prices of the provider now, for the address and the order; the
  // provider is asked outside the transaction
  if (changes.carrier !== undefined) {
    await assertCarrierPriced(actorId, actorRole, orderId, changes, requestLog);
  }

  try {
    const changed = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
        // one after another with the parcels of the order, which are written under its lock
        await db.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;

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

        // the address: whole, for a delivery to an address only
        if (changes.address !== undefined) {
          if (!sendsToAddress(current.method))
            throw new BadRequestError('DELIVERY_ADDRESS_NOT_ALLOWED');
          Object.assign(next, buildAddressData(changes.address));

          // another country: one with customs takes the order only with the customs data of its
          // products, as the confirmation of the buyer does
          if (next.country !== current.country && customsNeededFor(next.country ?? null)) {
            const products = productsWithoutCustomsData((await cartForDelivery(db, orderId)).lines);
            if (products.length) {
              throw new BadRequestError('DELIVERY_CUSTOMS_DATA_MISSING', { products });
            }
          }
        }

        // the carrier and the method of an order of a carrier, before its parcels are made; the
        // method it has already is no change
        const method = changes.method === current.method ? undefined : changes.method;
        if (changes.carrier !== undefined || method !== undefined) {
          if (current.method !== 'carrier')
            throw new BadRequestError('DELIVERY_CARRIER_NOT_ALLOWED');
        }
        if (method === 'manual') {
          Object.assign(next, {
            method: 'manual',
            carrierName: null,
            carrierService: null,
            carrierConnection: null,
          });
        } else if (changes.carrier !== undefined) {
          Object.assign(next, {
            carrierName: changes.carrier.name.trim(),
            carrierService: changes.carrier.service.trim(),
            carrierConnection: changes.carrier.connection.trim(),
          });
        }

        // an empty note removes it
        if (changes.note !== undefined) next.note = changes.note.trim() || null;

        const diff = [...PERSON_FIELDS, ...ADDRESS_FIELDS, 'note' as const, ...CARRIER_FIELDS]
          .filter((field) => field in next && next[field] !== current[field])
          .map((field) => ({ field, old: current[field], new: next[field] }));
        if (diff.length === 0) return false;

        // the label of a parcel of the provider carries the person, the address and the carrier:
        // while the order has such a parcel that is not voided, only the note changes
        // (PARCELS_EXIST: the admin voids the parcels first). A parcel a step back took away is
        // no parcel of the order any more
        if (current.method === 'carrier' && diff.some((one) => one.field !== 'note')) {
          const parcels = await db.orderShipment.count({
            where: {
              orderId,
              returnId: null,
              rolledBackAt: null,
              state: { notIn: ['void_pending', 'voided'] },
            },
          });
          if (parcels > 0) throw new ConflictError('PARCELS_EXIST', { orderId });
        }

        await db.orderDelivery.update({
          where: { orderId },
          data: next as Prisma.OrderDeliveryUpdateInput,
        });

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

      return mapOrderRowToResponse(row, await orderContextOf(db, [row], 'admin'), 'admin');
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
