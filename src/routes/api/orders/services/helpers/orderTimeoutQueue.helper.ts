import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import {
  formatPaymentPageLink,
  parsePaymentPageLink,
  type OrderPaymentPage,
} from '@routes/api/payments/providers/pageLink.js';
import { InternalError, ServiceUnavailableError, isAppError } from '@utils/errors.js';

import type { OrderId } from 'types/ids.js';

export type { OrderPaymentPage };

type WorkerLogger = {
  error: (obj: unknown, msg?: string) => void;
};

// give payment webhook processing extra time after reservation expiry
export const PAYMENT_WEBHOOK_GRACE_MS = 120_000;

// treat a reservation as missed by redis when it expired this long ago
const MISSED_RESERVATION_EXPIRY_MS = 300_000;

// report redis command failures to api callers as a stable 503
function toRedisUnavailableError(err: unknown): unknown {
  if (isAppError(err)) return err;

  return new ServiceUnavailableError('REDIS_UNAVAILABLE', undefined, err);
}

export async function scheduleOrderReservationExpiry(
  orderId: OrderId,
  reservationExpiresAt: Date | null,
): Promise<void> {
  // skip scheduling when the order has no reservation expiry time
  if (!reservationExpiresAt) return;

  // schedule the first job exactly at reservation expiry time
  const baseRunAtMs = reservationExpiresAt.getTime();
  if (Number.isNaN(baseRunAtMs)) {
    throw new Error(`invalid reservationExpiresAt for order ${orderId}`);
  }

  // schedule the second job after the payment webhook grace window
  const graceRunAtMs = baseRunAtMs + PAYMENT_WEBHOOK_GRACE_MS;

  try {
    const redis = await getRedis();

    // queue the base-phase job that must run at reservation expiry time
    await redis.zAdd(redisKeys.orderTimeoutBaseZset, [
      {
        score: baseRunAtMs,
        value: String(orderId),
      },
    ]);

    // queue the grace-phase job that will run after webhook waiting time
    await redis.zAdd(redisKeys.orderTimeoutZset, [
      {
        score: graceRunAtMs,
        value: String(orderId),
      },
    ]);
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

async function claimDueOrderIdsByKey(redisKey: string, batchSize = 100): Promise<OrderId[]> {
  const redis = await getRedis();
  const nowMs = Date.now();

  const lua = `
    local key = KEYS[1]
    local now = ARGV[1]
    local limit = tonumber(ARGV[2])

    local ids = redis.call('ZRANGE', key, '0', now, 'BYSCORE', 'LIMIT', '0', limit)

    if #ids == 0 then
      return ids
    end

    redis.call('ZREM', key, unpack(ids))
    return ids
  `;

  // atomically claim due jobs from the target sorted set
  const raw = (await redis.sendCommand([
    'EVAL',
    lua,
    '1',
    redisKey,
    String(nowMs),
    String(batchSize),
  ])) as string[];

  // convert claimed redis values into numeric order ids
  return raw.map((value) => Number(value) as OrderId).filter((value) => Number.isInteger(value));
}

export async function claimDueOrderReservationExpiryIds(batchSize = 100): Promise<OrderId[]> {
  // claim grace-phase jobs from the main timeout queue
  return claimDueOrderIdsByKey(redisKeys.orderTimeoutZset, batchSize);
}

export async function claimDueOrderReservationBaseIds(batchSize = 100): Promise<OrderId[]> {
  // claim base-phase jobs from the exact-expiry queue
  return claimDueOrderIdsByKey(redisKeys.orderTimeoutBaseZset, batchSize);
}

export async function processClaimedOrderReservationExpiries(
  log: WorkerLogger,
  batchSize = 100,
): Promise<number> {
  const orderIds = await claimDueOrderReservationExpiryIds(batchSize);
  if (orderIds.length === 0) return 0;

  let processed = 0;

  for (const orderId of orderIds) {
    try {
      // expire the order reservation after the webhook grace window is over;
      // the db function accepts only the admin context
      await prisma.$transaction(async (db) => {
        await setAdminContext(db);

        await db.$queryRaw`
          select cartlify.expire_order_reservation(${orderId}::int)
        `;
      });

      processed += 1;
    } catch (err: unknown) {
      // log per-order failures and continue processing the remaining jobs
      log.error({ orderId, err }, 'order reservation expiry failed');
    }
  }

  return processed;
}

export async function processMissedOrderReservationExpiries(
  log: WorkerLogger,
  batchSize = 100,
): Promise<number> {
  const expiredBefore = new Date(Date.now() - MISSED_RESERVATION_EXPIRY_MS);

  // read overdue reservations from db, admin context is required to pass rls
  const orders = await prisma.$transaction(async (db) => {
    await setAdminContext(db);

    return db.order.findMany({
      where: {
        confirmed: true,
        status: 'waiting',
        reservationExpiresAt: { lt: expiredBefore },
      },
      select: { id: true },
      orderBy: { reservationExpiresAt: 'asc' },
      take: batchSize,
    });
  });

  let processed = 0;

  for (const { id: orderId } of orders) {
    try {
      // db function rechecks the order state under lock, so repeated calls are safe;
      // it accepts only the admin context
      const rows = await prisma.$transaction(async (db) => {
        await setAdminContext(db);

        return db.$queryRaw<{ expired: boolean }[]>`
          select cartlify.expire_order_reservation(${orderId}::int) as expired
        `;
      });

      if (rows[0]?.expired) processed += 1;
    } catch (err: unknown) {
      // log per-order failures and continue processing the remaining orders
      log.error({ orderId, err }, 'missed order reservation expiry failed');
    }
  }

  return processed;
}

export async function setOrderPaymentPageLink(
  orderId: OrderId,
  page: OrderPaymentPage,
): Promise<void> {
  try {
    const redis = await getRedis();

    await redis.hSet(
      redisKeys.orderPaymentSessionMap,
      String(orderId),
      formatPaymentPageLink(page),
    );
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the payment page of the order, null when none was linked
export async function getOrderPaymentPageLink(orderId: OrderId): Promise<OrderPaymentPage | null> {
  const redis = await getRedis();

  return parsePaymentPageLink(await redis.hGet(redisKeys.orderPaymentSessionMap, String(orderId)));
}

export async function deleteOrderPaymentPageLink(orderId: OrderId): Promise<void> {
  const redis = await getRedis();
  await redis.hDel(redisKeys.orderPaymentSessionMap, String(orderId));
}

// the reservation is over: the page closes, so no payment comes for it any more. A page the
// provider did not close (paid meanwhile, a payment on its way) keeps its link, the payment event
// takes it away
async function handleReservationExpiredBase(
  orderId: OrderId,
  page: OrderPaymentPage,
): Promise<void> {
  const closed = await getPaymentProvider(page.provider).closePaymentPage(page.pageId);

  if (closed.state !== 'closed') {
    throw new InternalError(
      { reason: 'PAYMENT_PAGE_NOT_CLOSED', provider: page.provider, state: closed.state },
      closed.state === 'open' ? closed.cause : undefined,
    );
  }

  await deleteOrderPaymentPageLink(orderId);
}

export async function processClaimedOrderReservationBase(
  log: WorkerLogger,
  batchSize = 100,
): Promise<number> {
  const orderIds = await claimDueOrderReservationBaseIds(batchSize);
  if (orderIds.length === 0) return 0;

  let processed = 0;

  for (const orderId of orderIds) {
    try {
      // run the base-phase handler for jobs scheduled at reservation expiry time
      const page = await getOrderPaymentPageLink(orderId);

      if (!page) throw new Error();

      await handleReservationExpiredBase(orderId, page);
      processed += 1;
    } catch (err: unknown) {
      // log per-order failures and continue processing the remaining jobs
      log.error({ orderId, err }, 'order reservation base expiry failed');
    }
  }

  return processed;
}

export async function cancelOrderReservationExpiry(orderId: number): Promise<void> {
  const redis = await getRedis();

  // remove both timeout jobs when the order no longer needs reservation cleanup
  await redis.zRem(redisKeys.orderTimeoutBaseZset, String(orderId));
  await redis.zRem(redisKeys.orderTimeoutZset, String(orderId));
}
