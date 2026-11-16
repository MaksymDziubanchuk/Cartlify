import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';
import { voidPendingParcels } from '@routes/api/orders/services/voidParcels.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { CARRIER_SHOP, SIZED, carrierOrder, type CARRIERS } from '../../helpers/carrierOrders.js';
import { cancelPaidOrder } from '../../helpers/cancel.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';
import { shippingCostOf } from '../../helpers/orders.js';
import { deliveryHarness } from '../../helpers/providers.js';
import { breakShippyPro, mockParcel, resetShippyPro } from '../../helpers/shippyPro.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// the worker of the voids (decision 10 of the delivery, scenario 28): the parcels of a cancelled
// order the carrier never took wait for their void; the provider voids the ones of a carrier that
// can, the app closes them with their cost taken back; the others, and every one while the provider
// does not answer, keep waiting for the admin. Each run is kept to the order of its test: the
// parcels of other files are not its own

const harness = deliveryHarness[deliveryProvider.name];

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetShopSettings();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a logger of the worker that keeps what it got
const workerLog = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

// a paid order of the carrier with its parcel made, then cancelled by the shop: the parcel waits
async function cancelledWithParcel(carrier: keyof typeof CARRIERS) {
  setShopSettings(CARRIER_SHOP);
  const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
  const { buyer, orderId } = await carrierOrder(
    app,
    csrf,
    [{ variantId: mug.variantId, quantity: 1 }],
    { carrier },
  );
  userIds.push(buyer.id);
  const made = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/parcels`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: {},
  });
  expect(made.statusCode).toBe(200);
  await cancelPaidOrder(admin.id, orderId);

  const parcel = await asAdmin((tx) =>
    tx.orderShipment.findFirstOrThrow({
      where: { orderId },
      select: { id: true, providerParcelId: true, trackingNumber: true },
    }),
  );
  return { orderId, parcel: { ...parcel, parcelId: parcel.providerParcelId! } };
}

const parcelOf = (shipmentId: number) =>
  asAdmin((tx) =>
    tx.orderShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { state: true, expense: true },
    }),
  );

describe('the worker of the voids of the parcels', () => {
  it('voids the parcel of a carrier that can, its cost taken back, once', async () => {
    const { orderId, parcel } = await cancelledWithParcel('MockExpress');
    expect(await parcelOf(parcel.id)).toEqual({ state: 'void_pending', expense: true });
    const log = workerLog();

    expect(await voidPendingParcels(log, { orderId })).toBe(1);

    expect(await parcelOf(parcel.id)).toEqual({ state: 'voided', expense: true });
    expect(await shippingCostOf(parcel.id)).toBe(0);
    expect(mockParcel(parcel.parcelId)?.voided).toBe(true);
    expect(await voidPendingParcels(log, { orderId })).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves waiting the parcel of a carrier that cannot be asked, for the admin', async () => {
    const { orderId, parcel } = await cancelledWithParcel('Generic');
    const log = workerLog();

    expect(await voidPendingParcels(log, { orderId })).toBe(0);

    expect(await parcelOf(parcel.id)).toEqual({ state: 'void_pending', expense: true });
    expect(mockParcel(parcel.parcelId)?.voided).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reaches every waiting parcel: the ones a carrier cannot void never keep the others from their turn', async () => {
    // an order whose parcel of a carrier that cannot be asked waits, older than the one that can
    const stuck = await cancelledWithParcel('Generic');
    const { orderId, parcel } = await cancelledWithParcel('MockExpress');
    const log = workerLog();

    // the waiting parcels of both orders, one a batch: the first batch holds the one left waiting
    await voidPendingParcels(log, { orderIds: [stuck.orderId, orderId], batch: 1 });

    expect(await parcelOf(parcel.id)).toEqual({ state: 'voided', expense: true });
    expect(await parcelOf(stuck.parcel.id)).toEqual({ state: 'void_pending', expense: true });
    expect(orderId).toBeGreaterThan(stuck.orderId);
  });

  it('leaves it waiting while the provider does not answer, and voids it on the next run', async () => {
    const { orderId, parcel } = await cancelledWithParcel('MockExpress');
    const log = workerLog();
    breakShippyPro('unreachable');

    expect(await voidPendingParcels(log, { orderId })).toBe(0);

    expect(await parcelOf(parcel.id)).toEqual({ state: 'void_pending', expense: true });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: parcel.id }),
      'the delivery provider did not void a parcel',
    );

    resetShippyPro();
    expect(await voidPendingParcels(workerLog(), { orderId })).toBe(1);
    expect(await parcelOf(parcel.id)).toEqual({ state: 'voided', expense: true });
  });

  it('keeps a parcel the carrier took while its void was asked: sent, its cost kept', async () => {
    const { orderId, parcel } = await cancelledWithParcel('MockExpress');
    const log = workerLog();
    // the event of the pickup lands between the answer of the provider and the void of the app
    jest.spyOn(deliveryProvider, 'voidParcel').mockImplementationOnce(async () => {
      const res = await app.inject({
        method: 'POST',
        url: DELIVERY_WEBHOOK_PATH,
        headers: harness.webhookHeaders(),
        payload: JSON.stringify(harness.eventBody('collected', { ...parcel, reference: 'x' })),
      });
      expect(res.statusCode).toBe(200);
      return 'voided';
    });

    expect(await voidPendingParcels(log, { orderId })).toBe(0);

    expect(await parcelOf(parcel.id)).toEqual({ state: 'sent', expense: true });
    expect(await shippingCostOf(parcel.id)).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalledWith(
      { shipmentId: parcel.id },
      'a parcel voided at the provider moved on before its void',
    );
  });
});
