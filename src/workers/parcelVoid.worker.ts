import { failureOf } from '@helpers/failureOf.js';

import { voidPendingParcels } from '../routes/api/orders/services/voidParcels.service.js';

// The parcels of the delivery provider that wait for their void (the order was cancelled before the
// carrier took them, or an admin voids them to make them again): once a minute the provider is asked
// to void the ones of a carrier that can, and the app closes them with their cost taken back. The
// others stay waiting; the alert parcels_void_pending tells the admin to cancel them in the
// dashboard of the carrier and confirm (POST /api/orders/{orderId}/shipments/{shipmentId}/void-confirmation)

type WorkerLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const PARCEL_VOID_SWEEP_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

let currentRun: Promise<void> | null = null;

async function sweep(log: WorkerLogger): Promise<void> {
  try {
    const voided = await voidPendingParcels(log);
    if (voided > 0) log.info({ voided }, 'parcel void worker voided parcels');
  } catch (err: unknown) {
    // a failure of the sweep is logged and the next run tries again; the parcels keep waiting
    log.error(failureOf(err), 'parcel void worker failed');
  }
}

export function startParcelVoidWorker(log: WorkerLogger): void {
  if (timer) return;

  timer = setInterval(() => {
    if (currentRun) return;

    currentRun = sweep(log).finally(() => {
      currentRun = null;
    });
  }, PARCEL_VOID_SWEEP_INTERVAL_MS);

  // do not keep the node process alive only because of this interval
  timer.unref?.();
}

export async function stopParcelVoidWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  await currentRun;
}
