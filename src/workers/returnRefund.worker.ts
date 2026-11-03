import { failureOf } from '@helpers/failureOf.js';
import { settlePendingReturnRefunds } from '../routes/api/returns/services/settlePendingReturnRefunds.service.js';

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// how often to ask the provider about the transfers of money back that are still on their way
const RETURN_REFUND_SWEEP_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

// the run going on now, so a stop waits for it and two runs never overlap
let currentRun: Promise<void> | null = null;

async function sweep(log: WorkerLogger): Promise<void> {
  try {
    const settled = await settlePendingReturnRefunds(log);

    // log only when something was settled
    if (settled > 0) log.info({ settled }, 'return refund worker settled transfers');
  } catch (err: unknown) {
    // a failure of the sweep is logged and the next run tries again; the rows stay pending
    log.error(failureOf(err), 'return refund worker failed');
  }
}

// asks the provider about the transfers of money back that stayed pending: no answer was got, or
// the provider had not decided. Needs the database only, so it runs without redis
export function startReturnRefundWorker(log: WorkerLogger): void {
  if (timer) return;

  timer = setInterval(() => {
    if (currentRun) return;

    currentRun = sweep(log).finally(() => {
      currentRun = null;
    });
  }, RETURN_REFUND_SWEEP_INTERVAL_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();
}

// no new runs start, and the one going on ends first
export async function stopReturnRefundWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  await currentRun;
}
