import { failureOf } from '@helpers/failureOf.js';

import { issuePendingReceipts } from '../routes/api/orders/services/receipts.service.js';

// The fiscal receipts that wait (docs/taxes.md): once a minute each one whose try is due goes to the
// provider of the receipts of the server (RECEIPT_PROVIDER), and what it answered is written; a
// provider that does not answer leaves them for a later try. Started only when the provider makes
// receipts; needs the database only, so it runs without redis

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const RECEIPTS_SWEEP_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

// the run going on now, so a stop waits for it and two runs never overlap
let currentRun: Promise<void> | null = null;

async function sweep(log: WorkerLogger): Promise<void> {
  try {
    const sent = await issuePendingReceipts(log);
    if (sent > 0) log.info({ sent }, 'receipts worker sent receipts');
  } catch (err: unknown) {
    // a failure of the sweep is logged and the next run tries again; the receipts keep waiting
    log.error(failureOf(err), 'receipts worker failed');
  }
}

export function startReceiptsWorker(log: WorkerLogger): void {
  if (timer) return;

  timer = setInterval(() => {
    if (currentRun) return;

    currentRun = sweep(log).finally(() => {
      currentRun = null;
    });
  }, RECEIPTS_SWEEP_INTERVAL_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();
}

export async function stopReceiptsWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  await currentRun;
}
