import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { prisma } from '@db/client.js';

import type { OrderId } from 'types/ids.js';

export async function scheduleOrderReservationExpiry(
  orderId: OrderId,
  reservationExpiresAt: Date | null,
): Promise<void> {
  if (!reservationExpiresAt) return;

  const runAtMs = reservationExpiresAt.getTime();
  if (Number.isNaN(runAtMs)) {
    throw new Error(`invalid reservationExpiresAt for order ${orderId}`);
  }

  const redis = await getRedis();

  await redis.zAdd(redisKeys.orderTimeoutZset, [
    {
      score: runAtMs,
      value: String(orderId),
    },
  ]);
}

export async function claimDueOrderReservationExpiryIds(batchSize = 100): Promise<number[]> {
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

  const raw = (await redis.sendCommand([
    'EVAL',
    lua,
    '1',
    redisKeys.orderTimeoutZset,
    String(nowMs),
    String(batchSize),
  ])) as string[];

  return raw.map((value) => Number(value)).filter((value) => Number.isInteger(value));
}

export async function processClaimedOrderReservationExpiries(batchSize = 100): Promise<number> {
  const orderIds = await claimDueOrderReservationExpiryIds(batchSize);
  if (orderIds.length === 0) return 0;

  let processed = 0;

  for (const orderId of orderIds) {
    try {
      await prisma.$queryRaw`
        select cartlify.expire_order_reservation(${orderId}::int)
      `;

      processed += 1;
    } catch (err: unknown) {
      console.error({
        scope: 'redis-order-timeout',
        orderId,
        err,
      });
    }
  }

  return processed;
}

export async function cancelOrderReservationExpiry(orderId: number): Promise<void> {
  const redis = await getRedis();
  await redis.zRem(redisKeys.orderTimeoutZset, String(orderId));
}
