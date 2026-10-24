import { prisma } from '@db/client.js';
import { assertRedisReady } from '@redis/client.js';
import {
  getOrderPaymentPageClosedAt,
  getOrderPaymentPageLink,
  markOrderPaymentPageClosed,
  setOrderPaymentPageLink,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { setUserContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  isAppError,
} from '@utils/errors.js';

import { getPaymentProvider } from '../providers/index.js';

import type { UnavailableOrderItem } from '@routes/api/orders/services/helpers/confirmOrder.helper.js';
import type { PaymentProviderName } from '../providers/types.js';
import type {
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
} from 'types/dto/payments.dto.js';

// the buyer picked another provider than the one whose page is open for the order: that page is
// closed first, so the order cannot be paid twice; one that took the money keeps the order as it is
async function closePageOfOtherProvider(orderId: number, provider: PaymentProviderName) {
  const page = await getOrderPaymentPageLink(orderId);
  if (!page || page.provider === provider) return;

  const closed = await getPaymentProvider(page.provider).closePaymentPage(page.pageId);

  if (closed.state === 'paid') throw new ConflictError('ORDER_ALREADY_PAID');
  if (closed.state === 'in_progress') throw new ConflictError('ORDER_PAYMENT_IN_PROGRESS');
  if (closed.state === 'open') {
    throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, closed.cause);
  }

  // the time of the close goes into the key of the next page of the order
  await markOrderPaymentPageClosed(orderId);
}

// the payment page of a confirmed order at the provider the buyer picked
export async function createCheckoutSession({
  actorId,
  actorRole,
  orderId,
  provider,
}: CreateCheckoutSessionDto): Promise<CheckoutSessionResponseDto> {
  // enforce user-only checkout create
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  // refuse early so no payment page is opened while redis is down
  assertRedisReady();

  const paymentProvider = getPaymentProvider(provider);

  try {
    const orderSnapshot = await prisma.$transaction(async (db) => {
      // set rls session context
      await setUserContext(db, { userId: actorId, role: actorRole });

      // load order snapshot for checkout create
      const order = await db.order.findUnique({
        where: { id: Number(orderId) },
        select: {
          id: true,
          userId: true,
          status: true,
          confirmed: true,
          reservationExpiresAt: true,
          total: true,
          // the buyer reads their own account: the page fills in the email
          user: { select: { email: true, deletedAt: true } },
          items: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              productId: true,
              quantity: true,
              unitPrice: true,
              productName: true,
              product: {
                select: {
                  name: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundError('ORDER_NOT_FOUND', { orderId: Number(orderId) });
      }

      // require confirmed order
      if (!order.confirmed) {
        throw new ConflictError('ORDER_NOT_CONFIRMED');
      }

      // block already paid order
      if (order.status === 'paid') {
        throw new ConflictError('ORDER_ALREADY_PAID');
      }

      // allow checkout only from waiting status
      if (order.status !== 'waiting') {
        throw new ConflictError('ORDER_STATUS_NOT_WAITING');
      }

      // require active reservation deadline
      if (!order.reservationExpiresAt) {
        throw new ConflictError('ORDER_RESERVATION_MISSING');
      }

      // block expired reservation
      if (order.reservationExpiresAt.getTime() <= Date.now()) {
        throw new ConflictError('ORDER_RESERVATION_EXPIRED');
      }

      // require at least one order item
      if (!Array.isArray(order.items) || order.items.length === 0) {
        throw new BadRequestError('ORDER_ITEMS_REQUIRED');
      }

      // an item removed from the catalog after the confirmation is named the way the confirmation
      // names it: the buyer cancels the payment, changes the order and confirms it again. Its own
      // reservation is in the stock numbers, so only a removed product is unavailable here
      const removed: UnavailableOrderItem[] = order.items
        .filter((item) => item.product.deletedAt)
        .map((item) => ({
          itemId: item.id,
          productId: item.productId,
          reason: 'deleted',
          available: 0,
          requested: item.quantity,
        }));

      if (removed.length > 0) {
        throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', { items: removed });
      }

      // validate order total
      const totalRaw = Number(order.total);

      if (!Number.isFinite(totalRaw) || totalRaw <= 0) {
        throw new BadRequestError('ORDER_TOTAL_INVALID');
      }

      // the provider refuses a smaller payment, the page tells the buyer the smallest total
      if (totalRaw < paymentProvider.minimumTotal) {
        throw new BadRequestError('ORDER_TOTAL_BELOW_MINIMUM', {
          minimum: paymentProvider.minimumTotal,
          currency: paymentProvider.currency,
        });
      }

      return {
        orderId: order.id,
        userId: order.userId,
        total: totalRaw,
        reservationExpiresAt: order.reservationExpiresAt,
        // the name each item was confirmed with, the page shows what is bought
        items: order.items.map((item) => ({
          name: item.productName ?? item.product.name,
          unitPrice: Number(item.unitPrice),
          quantity: item.quantity,
        })),
        customerEmail: order.user.deletedAt ? null : order.user.email,
      };
    });

    await closePageOfOtherProvider(orderSnapshot.orderId, provider);
    const pageClosedAt = await getOrderPaymentPageClosedAt(orderSnapshot.orderId);

    // the same order with the same reservation gets the same page, not a second payment
    const { pageId, checkoutSession } = await paymentProvider.openPaymentPage({
      ...orderSnapshot,
      pageClosedAt,
    });

    // the link from the order to its page, for closing it at the reservation end or on a cancel;
    // the page is not closed when this fails: the retry gets the same page back and links it
    await setOrderPaymentPageLink(orderSnapshot.orderId, { provider, pageId });

    return { checkoutSession };
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_CREATE_CHECKOUT_SESSION_UNEXPECTED' }, err);
  }
}
