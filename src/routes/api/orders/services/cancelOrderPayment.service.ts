import { Prisma } from '@prisma/client';
import { getPgMessage, isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertRedisReady } from '@redis/client.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  ServiceUnavailableError,
  isAppError,
} from '@utils/errors.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import {
  cancelOrderReservationExpiry,
  deleteOrderPaymentPageLink,
  getOrderPaymentPageLink,
  mapOrderRowToResponse,
  orderResponseSelect,
} from './helpers/index.js';

import type { OrderCancelLogger } from './helpers/sendOrderCancelledEmail.helper.js';
import type { CancelOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';

const txOptions = {
  // keep default isolation and retry only transient lock/conflict errors
  maxRetries: 3,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1500,
  timeout: 10_000,
};

// the payment page of the order is closed first, by the provider that opened it: once it says the
// page is closed, no payment can come for it. A page that took the money cannot be closed, the
// order is paid then
async function closePaymentPage(orderId: number): Promise<void> {
  // no page was opened for the order: nothing can be paid
  const page = await getOrderPaymentPageLink(orderId);
  if (!page) return;

  // the provider could not be asked: throws PAYMENT_PROVIDER_UNAVAILABLE
  const closed = await getPaymentProvider(page.provider).closePaymentPage(page.pageId);

  // the money is taken, the payment event marks the order paid
  if (closed.state === 'paid') throw new ConflictError('ORDER_ALREADY_PAID');

  // a delayed payment method is still deciding, the order cannot be cancelled meanwhile
  if (closed.state === 'in_progress') throw new ConflictError('ORDER_PAYMENT_IN_PROGRESS');

  // the page is open and the provider did not close it: cancelling now would let a payment through
  if (closed.state === 'open') {
    throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, closed.cause);
  }
}

// the owner cancels the payment of an order that waits for it: the payment page is closed, the
// reservation goes, the order becomes unconfirmed with its items and shipping data, the owner can
// change them and confirm it again
export async function cancelOrderPayment(
  { actorId, actorRole, orderId }: CancelOrderDto,
  log: OrderCancelLogger,
): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  const id = Number(orderId);

  // the payment page and the reservation timers live in redis
  assertRedisReady();

  try {
    // the order must be own and wait for the payment before its payment page is touched;
    // the database function checks it again under the lock
    const order = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      return db.order.findFirst({
        where: { id, userId: actorId as any },
        select: { status: true, confirmed: true },
      });
    }, txOptions);

    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: id });
    if (order.status === 'paid') throw new ConflictError('ORDER_ALREADY_PAID');
    if (!order.confirmed || order.status !== 'waiting') {
      throw new ConflictError('ORDER_STATUS_NOT_WAITING');
    }

    await closePaymentPage(id);

    const response = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      await db.$executeRaw`select cartlify.cancel_order_payment(${id}::int)`;

      const row = await db.order.findUnique({ where: { id }, select: orderResponseSelect });
      if (!row) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CANCEL_PAYMENT' });

      return mapOrderRowToResponse(row);
    }, txOptions);

    // the reservation timers and the page link have nothing left to do; a leftover is harmless,
    // the timer touches only a waiting order
    try {
      await cancelOrderReservationExpiry(id);
      await deleteOrderPaymentPageLink(id);
    } catch (err) {
      log.warn({ err, orderId: id }, 'reservation timers of a cancelled payment were not removed');
    }

    return response;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');

    const message = getPgMessage(err) ?? '';

    if (message.includes('ORDER_NOT_FOUND')) throw new NotFoundError('ORDER_NOT_FOUND');
    if (message.includes('ORDER_ALREADY_PAID')) throw new ConflictError('ORDER_ALREADY_PAID');
    if (message.includes('ORDER_STATUS_NOT_WAITING')) {
      throw new ConflictError('ORDER_STATUS_NOT_WAITING');
    }
    if (message.includes('ORDER_ITEMS_REQUIRED')) throw new BadRequestError('ORDER_ITEMS_REQUIRED');

    throw new InternalError({ reason: 'ORDERS_CANCEL_PAYMENT_UNEXPECTED' }, err);
  }
}
