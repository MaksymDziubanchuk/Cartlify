import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import {
  ORDER_TIMEOUT_MAX_ATTEMPTS,
  claimDueOrderReservationBaseIds,
  orderTimeoutRetryDelayMs,
  processClaimedOrderReservationBase,
  processClaimedOrderReservationExpiries,
  scheduleOrderReservationExpiry,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { inCommittedTx } from '../../helpers/db.js';
import { cartOf, confirm } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { placeOrder } from '../../helpers/orders.js';
import { openPaymentPage, orderStateOf, redisStateOf } from '../../helpers/payments.js';
import {
  closeOpenSessions,
  payCheckoutSession,
  readSession,
  rememberSession,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';

// the order timeout worker, one step at a time: at the end of a reservation it closes the payment
// page of the order (the base job), after the grace window of the payment events it gives the
// reserved stock back (the grace job). A job stays in its queue until it is done: taken, it only
// moves to a later time, so a failed step or a server that stopped in the middle runs it again,
// up to a number of attempts.
// The queues are shared with the other test files: a job of this file is due at the start of
// 1970, the earliest of all, and a run takes as many jobs as the test made, so it takes only its own

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

// a logger of the worker that keeps what it got
const workerLog = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

const EARLIEST = new Date(1);

// the jobs of the order become due before any other
const dueFirst = (orderId: number) => scheduleOrderReservationExpiry(orderId, EARLIEST);

const scoreOf = async (key: string, orderId: number) =>
  (await getRedis()).zScore(key, String(orderId));

// the run of a job the worker took is over, the job is due again at once
const dueAgain = async (key: string, orderId: number) =>
  (await getRedis()).zAdd(key, [{ score: 1, value: String(orderId) }]);

const attemptsOf = async (key: string, orderId: number) =>
  (await getRedis()).hGet(`${key}:attempts`, String(orderId));

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  userIds.push(user.id);
  return user;
}

async function newProduct(): Promise<TestProduct> {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
}

// an order that waits for its payment, with a page the app opened at stripe
async function orderWithPage() {
  const user = await newUser();
  const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
  const sessionId = rememberSession(await openPaymentPage(app, csrf, user, orderId));
  return { orderId, sessionId };
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('the base job: the payment page at the end of the reservation', () => {
  // an order confirmed without a page opened is the usual case, not a failure
  it('takes a job of an order without a page off its queue without a word', async () => {
    const orderId = 2_000_000_001;
    await dueFirst(orderId);
    const log = workerLog();

    expect(await processClaimedOrderReservationBase(log, 1)).toBe(1);

    expect(await scoreOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
    expect(await attemptsOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    await (await getRedis()).zRem(redisKeys.orderTimeoutZset, String(orderId));
  });

  // a server that stops between taking a job and finishing it must not lose the job
  it('keeps a job it took, due again later, until it is done', async () => {
    const orderId = 2_000_000_002;
    await dueFirst(orderId);
    const before = Date.now();

    expect(await claimDueOrderReservationBaseIds(1)).toEqual([orderId]);

    const due = await scoreOf(redisKeys.orderTimeoutBaseZset, orderId);
    expect(due).toBeGreaterThanOrEqual(before + orderTimeoutRetryDelayMs(1));
    expect(await attemptsOf(redisKeys.orderTimeoutBaseZset, orderId)).toBe('1');

    const redis = await getRedis();
    await redis.zRem(redisKeys.orderTimeoutBaseZset, String(orderId));
    await redis.zRem(redisKeys.orderTimeoutZset, String(orderId));
    await redis.hDel(`${redisKeys.orderTimeoutBaseZset}:attempts`, String(orderId));
  });

  it('waits longer after each failed attempt', () => {
    const delays = [1, 2, 3, 4].map(orderTimeoutRetryDelayMs);

    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  // a new confirmation schedules the order again: its attempts start over
  it('starts the attempts over when the order is scheduled again', async () => {
    const orderId = 2_000_000_003;
    await dueFirst(orderId);
    await claimDueOrderReservationBaseIds(1);

    await scheduleOrderReservationExpiry(orderId, new Date(Date.now() + 60_000));

    expect(await attemptsOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
    const redis = await getRedis();
    await redis.zRem(redisKeys.orderTimeoutBaseZset, String(orderId));
    await redis.zRem(redisKeys.orderTimeoutZset, String(orderId));
  });

  describe('with a page at Stripe', () => {
    it('closes the page and forgets it', async () => {
      const { orderId, sessionId } = await orderWithPage();
      await dueFirst(orderId);
      const log = workerLog();

      expect(await processClaimedOrderReservationBase(log, 1)).toBe(1);

      expect((await readSession(sessionId)).status).toBe('expired');
      expect(await redisStateOf(orderId)).toMatchObject({ pageLink: null, reservationTimer: null });
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    // the reservation timer is the one place that closes the page: a stripe out of reach must
    // not leave it payable for the rest of its life
    it('tries again later when Stripe cannot close the page, keeping the page link', async () => {
      const { orderId, sessionId } = await orderWithPage();
      await dueFirst(orderId);
      const log = workerLog();

      await withStripeOutOfReach(() => processClaimedOrderReservationBase(log, 1));

      expect((await redisStateOf(orderId)).pageLink).toBe(`stripe:${sessionId}`);
      expect(await scoreOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeGreaterThan(Date.now());
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orderId, attempt: 1 }),
        'order reservation base expiry failed, it runs again later',
      );
      expect(log.error).not.toHaveBeenCalled();

      // the next attempt reaches stripe
      await dueAgain(redisKeys.orderTimeoutBaseZset, orderId);
      await processClaimedOrderReservationBase(log, 1);

      expect((await readSession(sessionId)).status).toBe('expired');
      expect(await redisStateOf(orderId)).toMatchObject({ pageLink: null, reservationTimer: null });
    });

    it('gives up after the last attempt with one error', async () => {
      const { orderId } = await orderWithPage();
      await dueFirst(orderId);
      await (await getRedis()).hSet(
        `${redisKeys.orderTimeoutBaseZset}:attempts`,
        String(orderId),
        String(ORDER_TIMEOUT_MAX_ATTEMPTS - 1),
      );
      const log = workerLog();

      await withStripeOutOfReach(() => processClaimedOrderReservationBase(log, 1));

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId, attempts: ORDER_TIMEOUT_MAX_ATTEMPTS }),
        'order reservation base expiry gave up',
      );
      expect(await scoreOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
      expect(await attemptsOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
    });

    // the money is taken: the payment event marks the order paid and takes the link away
    it('leaves a paid page to its payment event, without an error', async () => {
      const { orderId, sessionId } = await orderWithPage();
      await payCheckoutSession(sessionId);
      await dueFirst(orderId);
      const log = workerLog();

      expect(await processClaimedOrderReservationBase(log, 1)).toBe(1);

      expect((await redisStateOf(orderId)).pageLink).toBe(`stripe:${sessionId}`);
      expect(await scoreOf(redisKeys.orderTimeoutBaseZset, orderId)).toBeNull();
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});

describe('the grace job: the reserved stock after the grace window', () => {
  it('gives the stock of a reservation that is over back and takes the job off', async () => {
    const user = await newUser();
    const product = await newProduct();
    const orderId = await inCommittedTx(async (db) => {
      const id = await cartOf(db, user.id, [[product.id, 1]]);
      const confirmed = await confirm(db, user.id, id, '1 millisecond');
      if (!confirmed.ok) throw new Error(`confirm_order refused: ${confirmed.message}`);
      return id;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the grace job is due 2 minutes after the base one; here both are due first
    await (await getRedis()).zAdd(redisKeys.orderTimeoutZset, [{ score: 2, value: String(orderId) }]);
    const log = workerLog();

    expect(await processClaimedOrderReservationExpiries(log, 1)).toBe(1);

    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'unconfirmed',
      confirmed: false,
      reservationExpiresAt: null,
    });
    expect(await scoreOf(redisKeys.orderTimeoutZset, orderId)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  // the owner deleted the order before its timer ran: a stale job, not a failure to repeat
  it('takes the job of an order that is gone off its queue without an error', async () => {
    const orderId = 2_000_000_004;
    await (await getRedis()).zAdd(redisKeys.orderTimeoutZset, [{ score: 3, value: String(orderId) }]);
    const log = workerLog();

    expect(await processClaimedOrderReservationExpiries(log, 1)).toBe(1);

    expect(await scoreOf(redisKeys.orderTimeoutZset, orderId)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
