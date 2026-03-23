import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { prisma } from '@db/client.js';
import { expireCheckoutSession } from '@routes/api/payments/services/helpers/checkoutSession.helper.js';

import type { OrderId } from 'types/ids.js';
import { AppError } from '@utils/errors.js';

// give payment webhook processing extra time after reservation expiry
const PAYMENT_WEBHOOK_GRACE_MS = 120_000;

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

export async function processClaimedOrderReservationExpiries(batchSize = 100): Promise<number> {
  const orderIds = await claimDueOrderReservationExpiryIds(batchSize);
  if (orderIds.length === 0) return 0;

  let processed = 0;

  for (const orderId of orderIds) {
    try {
      // expire the order reservation after the webhook grace window is over
      await prisma.$queryRaw`
        select cartlify.expire_order_reservation(${orderId}::int)
      `;

      processed += 1;
    } catch (err: unknown) {
      // log per-order failures and continue processing the remaining jobs
      console.error({
        scope: 'redis-order-timeout',
        orderId,
        err,
      });
    }
  }

  return processed;
}

export async function setOrderPaymentSessionLink(
  orderId: OrderId,
  paymentSessionId: string,
): Promise<void> {
  const redis = await getRedis();

  await redis.hSet(redisKeys.orderPaymentSessionMap, String(orderId), String(paymentSessionId));
}

async function getOrderPaymentSessionLink(orderId: OrderId): Promise<string | null> {
  const redis = await getRedis();

  const paymentSessionId = await redis.hGet(redisKeys.orderPaymentSessionMap, String(orderId));

  if (!paymentSessionId) return null;
  return paymentSessionId;
}

async function deleteOrderPaymentSessionLink(orderId: OrderId): Promise<void> {
  const redis = await getRedis();
  await redis.hDel(redisKeys.orderPaymentSessionMap, String(orderId));
}

async function handleReservationExpiredBase(
  orderId: OrderId,
  paymentSessionId: string,
): Promise<void> {
  await expireCheckoutSession({ sessionId: paymentSessionId });
  await deleteOrderPaymentSessionLink(orderId);
}

export async function processClaimedOrderReservationBase(batchSize = 100): Promise<number> {
  const orderIds = await claimDueOrderReservationBaseIds(batchSize);
  if (orderIds.length === 0) return 0;

  let processed = 0;

  for (const orderId of orderIds) {
    try {
      // run the base-phase handler for jobs scheduled at reservation expiry time
      const paymentSessionId = await getOrderPaymentSessionLink(orderId);

      if (!paymentSessionId) throw new Error();

      await handleReservationExpiredBase(orderId, paymentSessionId);
      processed += 1;
    } catch (err: unknown) {
      // log per-order failures and continue processing the remaining jobs
      console.error({
        scope: 'redis-order-timeout-base',
        orderId,
        err,
      });
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
