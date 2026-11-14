import { failureOf } from '@helpers/failureOf.js';
import { followDisputes } from '../routes/api/payments/services/followDisputes.service.js';
import { settleRefundsInTransit } from '../routes/api/payments/services/settleRefundsInTransit.service.js';

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// how often to ask the provider about the refunds of the app that are still in transit
const MONEY_REFUND_SWEEP_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

// the run going on now, so a stop waits for it and two runs never overlap
let currentRun: Promise<void> | null = null;

async function sweep(log: WorkerLogger): Promise<void> {
  try {
    const settled = await settleRefundsInTransit(log);
    // the disputes whose step did not finish when their event came
    const followed = await followDisputes(log);

    // log only when something was done
    if (settled > 0 || followed > 0) {
      log.info({ settled, followed }, 'money refund worker settled refunds');
    }
  } catch (err: unknown) {
    // a failure of the sweep is logged and the next run tries again; the refunds stay in transit
    log.error(failureOf(err), 'money refund worker failed');
  }
}

// asks the provider about the refunds of the app that stayed in transit (the transfers of the
// statements, the refunds of the late payments): no answer was got, or the provider had not decided;
// and follows the disputes whose step did not finish (the draft of the evidence, a cancel after a
// dispute lost, the money of a statement after a dispute ended).
// Needs the database only, so it runs without redis
export function startMoneyRefundWorker(log: WorkerLogger): void {
  if (timer) return;

  timer = setInterval(() => {
    if (currentRun) return;

    currentRun = sweep(log).finally(() => {
      currentRun = null;
    });
  }, MONEY_REFUND_SWEEP_INTERVAL_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();
}

// no new runs start, and the one going on ends first
export async function stopMoneyRefundWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  await currentRun;
}
