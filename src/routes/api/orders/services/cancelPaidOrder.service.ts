import { Prisma } from '@prisma/client';
import { getPgMessage, isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import { mapOrderRowToResponse, orderResponseSelect } from './helpers/index.js';
import {
  sendOrderCancelledEmail,
  type OrderCancelLogger,
} from './helpers/sendOrderCancelledEmail.helper.js';

import type { CancelOrderDto, CancelledOrderResponseDto } from 'types/dto/orders.dto.js';

// an admin cancels a paid or shipped order, for example one that cannot be delivered: the payment
// is refunded in full by the provider that took it, the stock comes back, the buyer gets a mail.
// The refund runs inside the transaction before its commit, so an order is cancelled only together
// with its refund; a refund that went through while the commit failed is not repeated on the next
// try, the provider gives no money twice for the same payment. The answer names the buyer, also a deleted one, so the admin
// can reach them: the recipient and the phone of the order stay on it
export async function cancelPaidOrder(
  { actorId, actorRole, orderId }: CancelOrderDto,
  log: OrderCancelLogger,
): Promise<CancelledOrderResponseDto> {
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const id = Number(orderId);

  try {
    const result = await tx(
      async (db) => {
        // the admin context with the admin id: the audit log names who cancelled
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const before = await db.order.findUnique({ where: { id }, select: { status: true } });
        if (!before) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: id });

        // checks the status, locks the order, returns the stock, marks it cancelled
        await db.$executeRaw`select cartlify.cancel_paid_order(${id}::int)`;

        const payment = await db.order.findUnique({
          where: { id },
          select: {
            paymentProvider: true,
            paymentId: true,
            user: { select: { id: true, email: true, deletedAt: true } },
          },
        });
        if (!payment) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CANCEL' });

        // a paid order always holds its payment and who took it; without them nothing can be refunded
        const { paymentProvider: provider, paymentId, user } = payment;
        if (!provider || !paymentId) {
          throw new ConflictError('ORDER_PAYMENT_ID_MISSING', { orderId: id });
        }

        const { refundId } = await getPaymentProvider(provider).refundPayment({
          orderId: id,
          paymentId,
        });

        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: id,
          action: 'ORDER_STATUS_CHANGE',
          changes: [
            { field: 'status', old: before.status, new: 'cancelled' },
            {
              field: 'refund',
              old: null,
              new: { initiator: 'admin', provider, paymentId, refundId },
            },
          ],
        });

        const row = await db.order.findUnique({ where: { id }, select: orderResponseSelect });
        if (!row) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CANCEL' });

        const deleted = user.deletedAt !== null;

        return {
          ...mapOrderRowToResponse(row),
          user: { id: user.id as any, deleted, ...(deleted ? {} : { email: user.email }) },
        };
      },
      {
        // the refund call to the provider runs inside, the transaction gets the time for it
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 20_000,
      },
    );

    // the cancel is committed; the mail never undoes it, a failure is only logged
    await sendOrderCancelledEmail(id, log);

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');

    const message = getPgMessage(err) ?? '';

    if (message.includes('ORDER_NOT_FOUND')) throw new NotFoundError('ORDER_NOT_FOUND');
    for (const code of [
      'ORDER_ALREADY_DELIVERED',
      'ORDER_ALREADY_CANCELLED',
      'ORDER_NOT_PAID',
      'ORDER_STATUS_CHANGED',
    ]) {
      if (message.includes(code)) throw new ConflictError(code);
    }
    if (message.includes('ORDER_CANCEL_FORBIDDEN'))
      throw new ForbiddenError('ORDER_CANCEL_FORBIDDEN');

    throw new InternalError({ reason: 'ORDERS_CANCEL_UNEXPECTED' }, err);
  }
}
