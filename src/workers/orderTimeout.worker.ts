import env from '@config/env.js';
import {
  processClaimedOrderReservationBase,
  processClaimedOrderReservationExpiries,
} from '../routes/api/orders/services/helpers/index.js';

// keep a single interval instance for the worker
let timer: NodeJS.Timeout | null = null;

// prevent overlapping worker runs
let running = false;

export function startOrderTimeoutWorker(log: {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): void {
  // do not start the worker twice
  if (timer) return;

  timer = setInterval(async () => {
    // skip a new tick while the previous one is still running
    if (running) return;
    running = true;

    try {
      // accumulate processed jobs from both queues for one worker tick
      let totalProcessed = 0;

      while (true) {
        // process jobs scheduled exactly at reservation expiry time
        const processedBase = await processClaimedOrderReservationBase(100);

        // process jobs scheduled after payment webhook grace period
        const processedGrace = await processClaimedOrderReservationExpiries(100);

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
}

export function stopOrderTimeoutWorker(): void {
  // nothing to stop if the worker was not started
  if (!timer) return;

  clearInterval(timer);
  timer = null;
}
