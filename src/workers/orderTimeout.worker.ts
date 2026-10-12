import env from '@config/env.js';
import { isRedisReady } from '@redis/client.js';
import {
  processClaimedOrderReservationBase,
  processClaimedOrderReservationExpiries,
  processMissedOrderReservationExpiries,
} from '../routes/api/orders/services/helpers/index.js';

// how often to look in the db for reservations the redis queue missed
const MISSED_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

// keep a single interval instance for the worker
let timer: NodeJS.Timeout | null = null;

// prevent overlapping worker runs
let running = false;

// keep the db sweep on its own interval so a stuck redis call cannot block it
let missedExpiryTimer: NodeJS.Timeout | null = null;

// prevent overlapping db sweeps
let missedExpiryRunning = false;

export function startOrderTimeoutWorker(log: {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): void {
  // do not start the worker twice
  if (timer) return;

  timer = setInterval(async () => {
    // skip redis jobs entirely while redis is down
    if (!isRedisReady()) return;

    // skip a new tick while the previous one is still running
    if (running) return;
    running = true;

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
      // log worker-level failures without crashing the app
      log.error({ err }, 'order timeout worker failed');
    } finally {
      // release the worker lock for the next tick
      running = false;
    }
  }, env.REDIS_ORDER_TIMEOUT_WORKER_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();

  missedExpiryTimer = setInterval(async () => {
    // skip a new sweep while the previous one is still running
    if (missedExpiryRunning) return;
    missedExpiryRunning = true;

    try {
      // release reservations that expired in db but were never processed through redis
      const processed = await processMissedOrderReservationExpiries(log, 100);

      // log only when something was actually released
      if (processed > 0) {
        log.info({ processed }, 'order timeout worker released missed reservations');
      }
    } catch (err: unknown) {
      // log sweep-level failures without crashing the app
      log.error({ err }, 'order timeout worker missed reservations sweep failed');
    } finally {
      // release the sweep lock for the next run
      missedExpiryRunning = false;
    }
  }, MISSED_EXPIRY_SWEEP_INTERVAL_MS);

  missedExpiryTimer.unref?.();
}

export function stopOrderTimeoutWorker(): void {
  // nothing to stop if the worker was not started
  if (!timer) return;

  clearInterval(timer);
  timer = null;

  if (missedExpiryTimer) {
    clearInterval(missedExpiryTimer);
    missedExpiryTimer = null;
  }
}
