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
import { failureOf } from '@helpers/failureOf.js';
import { InternalError, ServiceUnavailableError, isAppError } from '@utils/errors.js';

import type { OrderId } from 'types/ids.js';

export type { OrderPaymentPage };

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// give payment webhook processing extra time after reservation expiry
export const PAYMENT_WEBHOOK_GRACE_MS = 120_000;

// treat a reservation as missed by redis when it expired this long ago
const MISSED_RESERVATION_EXPIRY_MS = 300_000;

// how many times a job runs before the worker gives it up with an error
export const ORDER_TIMEOUT_MAX_ATTEMPTS = 5;

// the pause before the next run of a job that failed, longer after each attempt: 30 s, 1 min,
// 2 min, 4 min, at most 5 min. A job the worker takes moves this far ahead at once, so a server
// that stops in the middle of it leaves it to run again then
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;

export function orderTimeoutRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

// the attempts of the jobs of a queue, a hash next to it
const attemptsKeyOf = (queueKey: string) => `${queueKey}:attempts`;

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

    // a new reservation: the jobs of the order start their attempts over
    await redis.hDel(attemptsKeyOf(redisKeys.orderTimeoutBaseZset), String(orderId));
    await redis.hDel(attemptsKeyOf(redisKeys.orderTimeoutZset), String(orderId));
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// a job the worker took: the order, which attempt this is, and the time the job moved to
type ClaimedJob = { orderId: OrderId; attempt: number; leaseScore: string };

// takes the due jobs of a queue: each moves ahead by the pause of its attempt and counts the
// attempt, in one step, so two workers never take the same job and none is lost on a stop
const CLAIM_LUA = `
  local queue = KEYS[1]
  local attempts = KEYS[2]
  local now = tonumber(ARGV[1])
  local base = tonumber(ARGV[3])
  local cap = tonumber(ARGV[4])

  local ids = redis.call('ZRANGE', queue, '0', ARGV[1], 'BYSCORE', 'LIMIT', '0', ARGV[2])
  local out = {}

  for _, id in ipairs(ids) do
    local attempt = redis.call('HINCRBY', attempts, id, 1)
    local delay = math.min(base * 2 ^ (attempt - 1), cap)
    local lease = string.format('%.0f', now + delay)

    redis.call('ZADD', queue, lease, id)
    table.insert(out, id)
    table.insert(out, tostring(attempt))
    table.insert(out, lease)
  end

  return out
`;

// the job is done or given up: it goes, unless a new confirmation scheduled the order again
// meanwhile (its time is not the one the worker moved it to)
const COMPLETE_LUA = `
  if redis.call('ZSCORE', KEYS[1], ARGV[1]) == ARGV[2] then
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('HDEL', KEYS[2], ARGV[1])
  end
  return 1
`;

async function claimDueJobs(queueKey: string, batchSize: number): Promise<ClaimedJob[]> {
  const redis = await getRedis();

  const raw = (await redis.sendCommand([
    'EVAL',
    CLAIM_LUA,
    '2',
    queueKey,
    attemptsKeyOf(queueKey),
    String(Date.now()),
    String(batchSize),
    String(RETRY_BASE_MS),
    String(RETRY_MAX_MS),
  ])) as string[];

  const jobs: ClaimedJob[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const orderId = Number(raw[i]);
    if (!Number.isInteger(orderId)) continue;

    jobs.push({
      orderId: orderId as OrderId,
      attempt: Number(raw[i + 1]),
      leaseScore: raw[i + 2]!,
    });
  }

  return jobs;
}

async function completeJob(queueKey: string, job: ClaimedJob): Promise<void> {
  const redis = await getRedis();

  await redis.sendCommand([
    'EVAL',
    COMPLETE_LUA,
    '2',
    queueKey,
    attemptsKeyOf(queueKey),
    String(job.orderId),
    job.leaseScore,
  ]);
}

// runs the due jobs of a queue one by one: a job that fails stays for its next attempt with a
// warning; when its last attempt fails the job is given up with one error
async function runDueJobs(
  queueKey: string,
  batchSize: number,
  log: WorkerLogger,
  label: string,
  run: (orderId: OrderId) => Promise<void>,
): Promise<number> {
  const jobs = await claimDueJobs(queueKey, batchSize);
  let processed = 0;

  for (const job of jobs) {
    try {
      await run(job.orderId);
      await completeJob(queueKey, job);
      processed += 1;
    } catch (err: unknown) {
      if (job.attempt >= ORDER_TIMEOUT_MAX_ATTEMPTS) {
        log.error(
          { orderId: job.orderId, attempts: job.attempt, ...failureOf(err) },
          `${label} gave up`,
        );
        await completeJob(queueKey, job);
      } else {
        log.warn(
          {
            orderId: job.orderId,
            attempt: job.attempt,
            retryInMs: orderTimeoutRetryDelayMs(job.attempt),
            ...failureOf(err),
          },
          `${label} failed, it runs again later`,
        );
      }
    }
  }

  return processed;
}

export async function claimDueOrderReservationExpiryIds(batchSize = 100): Promise<OrderId[]> {
  // claim grace-phase jobs from the main timeout queue
  return (await claimDueJobs(redisKeys.orderTimeoutZset, batchSize)).map((job) => job.orderId);
}

export async function claimDueOrderReservationBaseIds(batchSize = 100): Promise<OrderId[]> {
  // claim base-phase jobs from the exact-expiry queue
  return (await claimDueJobs(redisKeys.orderTimeoutBaseZset, batchSize)).map((job) => job.orderId);
}

export async function processClaimedOrderReservationExpiries(
  log: WorkerLogger,
  batchSize = 100,
): Promise<number> {
  return runDueJobs(
    redisKeys.orderTimeoutZset,
    batchSize,
    log,
    'order reservation expiry',
    (orderId) =>
      // expire the order reservation after the webhook grace window is over; a stale job (paid,
      // confirmed again, deleted) changes nothing. The db function accepts only the admin context
      prisma.$transaction(async (db) => {
        await setAdminContext(db);

        await db.$queryRaw`
        select cartlify.expire_order_reservation(${orderId}::int)
      `;
      }),
  );
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
      log.error({ orderId, ...failureOf(err) }, 'missed order reservation expiry failed');
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
  try {
    const redis = await getRedis();

    return parsePaymentPageLink(
      await redis.hGet(redisKeys.orderPaymentSessionMap, String(orderId)),
    );
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the order needs no page any more (paid, released): its link and the time of a closed page go
export async function deleteOrderPaymentPageLink(orderId: OrderId): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.hDel(redisKeys.orderPaymentSessionMap, String(orderId));
    await redis.hDel(redisKeys.orderPaymentPageClosedAtMap, String(orderId));
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the app closed the page of the order to open one at another provider: the link goes, the time
// stays, and the next page of the order gets a key of its own with it
export async function markOrderPaymentPageClosed(orderId: OrderId): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.hDel(redisKeys.orderPaymentSessionMap, String(orderId));
    await redis.hSet(redisKeys.orderPaymentPageClosedAtMap, String(orderId), String(Date.now()));
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// when the app last closed a page of the order for another provider, null when it never did
export async function getOrderPaymentPageClosedAt(orderId: OrderId): Promise<Date | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.hGet(redisKeys.orderPaymentPageClosedAtMap, String(orderId));
    const ms = raw === null || raw === undefined ? Number.NaN : Number(raw);

    return Number.isSafeInteger(ms) && ms > 0 ? new Date(ms) : null;
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the reservation is over: the page closes, so no payment comes for it any more. An order
// confirmed without a page opened has nothing to close. A page the provider did not close because
// the money is taken or on its way keeps its link, the payment event takes it away; one it could
// not close (out of reach) is tried again
async function closePageOfExpiredReservation(orderId: OrderId, log: WorkerLogger): Promise<void> {
  const page = await getOrderPaymentPageLink(orderId);
  if (!page) return;

  const closed = await getPaymentProvider(page.provider).closePaymentPage(page.pageId);

  if (closed.state === 'closed') {
    await deleteOrderPaymentPageLink(orderId);
    return;
  }

  if (closed.state === 'paid' || closed.state === 'in_progress') {
    log.info(
      { orderId, provider: page.provider, state: closed.state },
      'payment page of a reservation that is over is paid or paying, its payment event decides',
    );
    return;
  }

  throw new InternalError(
    { reason: 'PAYMENT_PAGE_NOT_CLOSED', provider: page.provider, state: closed.state },
    closed.cause,
  );
}

export async function processClaimedOrderReservationBase(
  log: WorkerLogger,
  batchSize = 100,
): Promise<number> {
  return runDueJobs(
    redisKeys.orderTimeoutBaseZset,
    batchSize,
    log,
    'order reservation base expiry',
    (orderId) => closePageOfExpiredReservation(orderId, log),
  );
}

// how many jobs wait in both queues, due or not, for the pulse of the worker in /health
export async function countQueuedOrderReservationJobs(): Promise<number> {
  const redis = await getRedis();

  return (
    (await redis.zCard(redisKeys.orderTimeoutBaseZset)) +
    (await redis.zCard(redisKeys.orderTimeoutZset))
  );
}

export async function cancelOrderReservationExpiry(orderId: number): Promise<void> {
  try {
    const redis = await getRedis();

    // remove both timeout jobs when the order no longer needs reservation cleanup
    await redis.zRem(redisKeys.orderTimeoutBaseZset, String(orderId));
    await redis.zRem(redisKeys.orderTimeoutZset, String(orderId));
    await redis.hDel(attemptsKeyOf(redisKeys.orderTimeoutBaseZset), String(orderId));
    await redis.hDel(attemptsKeyOf(redisKeys.orderTimeoutZset), String(orderId));
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}
