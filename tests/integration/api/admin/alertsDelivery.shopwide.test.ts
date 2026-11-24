import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { deliveryProvider } from '@providers/delivery/index.js';
import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';

import { accessCookie } from '../../../helpers/actors.js';
import { writeAlertNumbers } from '../../../helpers/alerts.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';
import { CARRIER_SHOP } from '../../../helpers/carrierOrders.js';
import { breakShippyPro, resetShippyPro } from '../../../helpers/shippyPro.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// The alert of a delivery provider that does not answer (decision 13 of the delivery): every call to
// the provider tells its health, the time of its first failure to answer after its last answer
// stays in redis, and the alert counts 1 once that time is further back than the threshold (900
// seconds unless set), with occurredAt the time it stopped; any answer takes it away. The mark is one
// of the whole shop, which the calls of the other files move, so this file runs alone (shopwide)

let app: FastifyInstance;
let admin: TestUser;
let csrf: Csrf;
let clock: { restore: () => void } | null = null;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  await writeAlertNumbers(admin);
});

afterEach(() => {
  clock?.restore();
  clock = null;
  resetShopSettings();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

type Alert = { kind: string; count: number; threshold: number; occurredAt: string | null };

const alert = async (): Promise<Alert> => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/alerts?kinds=delivery_provider_down',
    headers: { cookie: accessCookie(admin) },
  });
  expect(res.statusCode).toBe(200);
  return (res.json().alerts as Alert[]).find((one) => one.kind === 'delivery_provider_down')!;
};

// a call to the provider: it answers, or it does not
const ask = () => deliveryProvider.findParcel('cartlify-shopwide-health');
const askUnanswered = () =>
  expect(ask()).rejects.toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });

describe('delivery_provider_down', () => {
  it('counts a provider that has not answered for the threshold, from its first failure, until it answers', async () => {
    setShopSettings(CARRIER_SHOP);
    await ask();
    expect(await alert()).toMatchObject({ count: 0, threshold: 900, occurredAt: null, list: null });

    breakShippyPro('unreachable');
    const before = Date.now();
    await askUnanswered();
    const after = Date.now();
    // just now: not for the threshold yet
    expect(await alert()).toMatchObject({ count: 0, occurredAt: null });

    // the failures after the first keep its time
    clock = moveClock(10 * 60_000);
    await askUnanswered();
    clock.restore();

    clock = moveClock(16 * 60_000);
    const down = await alert();
    expect(down.count).toBe(1);
    const since = new Date(down.occurredAt!).getTime();
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);

    // a shop that sends by no carrier has nothing to fix
    setShopSettings({ deliveryMethods: ['manual'] });
    expect(await alert()).toMatchObject({ count: 0, occurredAt: null });
    setShopSettings(CARRIER_SHOP);

    resetShippyPro();
    await ask();
    expect(await alert()).toMatchObject({ count: 0, occurredAt: null });
  });

  it('says nothing once nobody asked the provider for an hour after its last failure, and starts anew', async () => {
    setShopSettings(CARRIER_SHOP);
    breakShippyPro('unreachable');
    await askUnanswered();
    clock = moveClock(16 * 60_000);
    expect((await alert()).count).toBe(1);

    // the mark of the last failure lives an hour: after it nobody knows the provider is still down
    const redis = await getRedis();
    await redis.del(redisKeys.deliveryProviderDownLast);
    expect(await alert()).toMatchObject({ count: 0, occurredAt: null });
    clock.restore();

    // the next failure is the first one again
    const before = Date.now();
    await askUnanswered();
    clock = moveClock(16 * 60_000);
    const down = await alert();
    expect(down.count).toBe(1);
    expect(new Date(down.occurredAt!).getTime()).toBeGreaterThanOrEqual(before);
    clock.restore();

    resetShippyPro();
    await ask();
    expect(await alert()).toMatchObject({ count: 0, occurredAt: null });
  });

  it('is a single state: nothing of it is put aside', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/alerts/dismissals/delivery_provider_down/1',
      headers: withCsrf(csrf, accessCookie(admin)),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });
});
