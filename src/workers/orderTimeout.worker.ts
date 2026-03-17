import env from '@config/env.js';
import { processClaimedOrderReservationExpiries } from '../routes/api/orders/services/helpers/index.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startOrderTimeoutWorker(log: {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): void {
  if (timer) return;

  timer = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      let totalProcessed = 0;

      while (true) {
        const processed = await processClaimedOrderReservationExpiries(100);
        totalProcessed += processed;

        if (processed < 100) break;
      }

      if (totalProcessed > 0) {
        log.info({ totalProcessed }, 'order timeout worker processed jobs');
      }
    } catch (err: unknown) {
      log.error({ err }, 'order timeout worker failed');
    } finally {
      running = false;
    }
  }, env.REDIS_ORDER_TIMEOUT_WORKER_MS);

  timer.unref?.();
}

export function stopOrderTimeoutWorker(): void {
  if (!timer) return;

  clearInterval(timer);
  timer = null;
}
