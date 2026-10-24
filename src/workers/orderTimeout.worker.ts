import env from '@config/env.js';
import { failureOf } from '@helpers/failureOf.js';
import { isRedisReady } from '@redis/client.js';
import {
  countQueuedOrderReservationJobs,
  processClaimedOrderReservationBase,
  processClaimedOrderReservationExpiries,
  processMissedOrderReservationExpiries,
} from '../routes/api/orders/services/helpers/index.js';

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// how often to look in the db for reservations the redis queue missed
const MISSED_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

// keep a single interval instance for the worker
let timer: NodeJS.Timeout | null = null;

// keep the db sweep on its own interval so a stuck redis call cannot block it
let missedExpiryTimer: NodeJS.Timeout | null = null;

// the run of each loop that is going on now, so a stop waits for it; null between runs, which
// also keeps two runs of a loop from overlapping
let currentTick: Promise<void> | null = null;
let currentSweep: Promise<void> | null = null;

// the end of the last run of the redis loop, for /health
let lastRunAt: Date | null = null;
// when the worker started, null while it is off: the alerts tell a worker that stopped
let startedAt: Date | null = null;

async function runQueues(log: WorkerLogger): Promise<void> {
  try {
    // accumulate processed jobs from both queues for one worker tick
    let totalProcessed = 0;

    while (true) {
      // process jobs scheduled exactly at reservation expiry time
      const processedBase = await processClaimedOrderReservationBase(log, 100);

      // process jobs scheduled after payment webhook grace period
      const processedGrace = await processClaimedOrderReservationExpiries(log, 100);

      totalProcessed += processedBase + processedGrace;

      // stop when both queues return less than one full batch
      if (processedBase < 100 && processedGrace < 100) break;
    }

    // log only when something was actually processed
    if (totalProcessed > 0) {
      log.info({ totalProcessed }, 'order timeout worker processed jobs');
    }
  } catch (err: unknown) {
    // log worker-level failures without crashing the app; the jobs stay in their queues
    log.error(failureOf(err), 'order timeout worker failed');
  } finally {
    lastRunAt = new Date();
  }
}

async function sweepMissed(log: WorkerLogger): Promise<void> {
  try {
    // release reservations that expired in db but were never processed through redis
    const processed = await processMissedOrderReservationExpiries(log, 100);

    // log only when something was actually released
    if (processed > 0) {
      log.info({ processed }, 'order timeout worker released missed reservations');
    }
  } catch (err: unknown) {
    // log sweep-level failures without crashing the app
    log.error(failureOf(err), 'order timeout worker missed reservations sweep failed');
  }
}

export function startOrderTimeoutWorker(log: WorkerLogger): void {
  // do not start the worker twice
  if (timer) return;
  startedAt = new Date();

  timer = setInterval(() => {
    // skip redis jobs entirely while redis is down
    if (!isRedisReady()) return;

    // skip a new tick while the previous one is still running
    if (currentTick) return;

    currentTick = runQueues(log).finally(() => {
      currentTick = null;
    });
  }, env.REDIS_ORDER_TIMEOUT_WORKER_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();

  missedExpiryTimer = setInterval(() => {
    // skip a new sweep while the previous one is still running
    if (currentSweep) return;

    currentSweep = sweepMissed(log).finally(() => {
      currentSweep = null;
    });
  }, MISSED_EXPIRY_SWEEP_INTERVAL_MS);

  missedExpiryTimer.unref?.();
}

// no new runs start, and the one going on ends first: the server closes redis and the database
// right after this
export async function stopOrderTimeoutWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (missedExpiryTimer) {
    clearInterval(missedExpiryTimer);
    missedExpiryTimer = null;
  }

  await Promise.all([currentTick, currentSweep]);
}

// for the alerts of the admins: when the worker started (null while it is off) and when its
// redis loop last ran
export function orderTimeoutWorkerState(): { startedAt: Date | null; lastRunAt: Date | null } {
  return { startedAt, lastRunAt };
}

// for /health: when the redis loop last ran (null before the first run, or with the worker off)
// and how many jobs wait in its queues (null while redis is down)
export async function orderTimeoutWorkerPulse(): Promise<{
  lastRunAt: string | null;
  queued: number | null;
}> {
  let queued: number | null = null;

  if (isRedisReady()) {
    try {
      queued = await countQueuedOrderReservationJobs();
    } catch {
      queued = null;
    }
  }

  return { lastRunAt: lastRunAt?.toISOString() ?? null, queued };
}
