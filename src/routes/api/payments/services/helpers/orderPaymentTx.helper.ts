import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';

// finalize paid order from stripe webhook
async function payOrderFromStripeWebhook(orderId: number): Promise<{ paidNow: boolean }> {
  return tx(
    async (db) => {
      // set admin context for system-side order read
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // load order owner and current status
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          userId: true,
          status: true,
        },
      });

      // require existing order
      if (!order) {
        throw new InternalError({
          reason: 'STRIPE_ORDER_NOT_FOUND',
          orderId,
        });
      }

      // skip duplicate paid webhook
      if (order.status === 'paid') {
        return { paidNow: false as const };
      }

      // switch to owner context for db pay_order function
      await setUserContext(db, { userId: order.userId, role: 'USER' });
      await db.$executeRaw`select cartlify.pay_order(${orderId}::int)`;

      return { paidNow: true as const };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

// unconfirm waiting order from stripe webhook
async function unconfirmOrderFromStripeWebhook(
  orderId: number,
): Promise<{ unconfirmedNow: boolean }> {
  return tx(
    async (db) => {
      // set admin context for system-side order read
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // load order owner and current state
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          userId: true,
          status: true,
          confirmed: true,
        },
      });

      // require existing order
      if (!order) {
        throw new InternalError({
          reason: 'STRIPE_ORDER_NOT_FOUND',
          orderId,
        });
      }

      // skip already paid order
      if (order.status === 'paid') {
        return { unconfirmedNow: false as const };
      }

      // skip order that no longer needs unconfirm
      if (!order.confirmed || order.status !== 'waiting') {
        return { unconfirmedNow: false as const };
      }

      // switch to owner context for db unconfirm_order function
      await setUserContext(db, { userId: order.userId, role: 'USER' });
      await db.$executeRaw`select cartlify.unconfirm_order(${orderId}::int)`;

      return { unconfirmedNow: true as const };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

export { payOrderFromStripeWebhook, unconfirmOrderFromStripeWebhook };
