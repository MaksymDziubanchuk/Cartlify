import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { withdrawalCodeOf } from '@helpers/withdrawalCode.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';

// the limits of the public form of withdrawal. Nobody is signed in, so the requests count by address,
// by order and by the facts of a recipient. This file has its own counters: the address of every test is the same, so the
// limit of the address is tried first, before any other request of the file

let app: FastifyInstance;
let csrf: Csrf;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  await stopApp();
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf), payload });

// the three routes of the form share the limits; each answers an order there is not without a trace
const calls = {
  route: (orderId: number) => post('/api/withdrawals/route', { orderId }),
  form: (orderId: number) =>
    post('/api/withdrawals', { orderId, recipientName: 'Anna Koval', email: 'anna@example.com' }),
  proof: (orderId: number) =>
    post('/api/withdrawals/proof', {
      orderId,
      code: 'AAAA-AAAA-AAAA',
      returnId: 1,
      carrier: 'DHL',
      trackingNumber: 'X1',
    }),
};

// the tests raise every limit a thousand times: here a limit counts as the server has it
async function withLimits<T>(
  limits: { address?: number; order?: number; data?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const before = {
    address: env.LIMIT_WITHDRAWAL_FORM_PER_ADDRESS,
    order: env.LIMIT_WITHDRAWAL_FORM_PER_ORDER,
    data: env.LIMIT_WITHDRAWAL_FORM_PER_DATA,
    scale: env.REQUEST_LIMITS_SCALE,
  };
  if (limits.address !== undefined) env.LIMIT_WITHDRAWAL_FORM_PER_ADDRESS = limits.address;
  if (limits.order !== undefined) env.LIMIT_WITHDRAWAL_FORM_PER_ORDER = limits.order;
  // the facts of the recipient of the form are the same in every request of the file
  env.LIMIT_WITHDRAWAL_FORM_PER_DATA = limits.data ?? 1000;
  env.REQUEST_LIMITS_SCALE = 1;

  try {
    return await fn();
  } finally {
    env.LIMIT_WITHDRAWAL_FORM_PER_ADDRESS = before.address;
    env.LIMIT_WITHDRAWAL_FORM_PER_ORDER = before.order;
    env.LIMIT_WITHDRAWAL_FORM_PER_DATA = before.data;
    env.REQUEST_LIMITS_SCALE = before.scale;
  }
}

describe('the limits of the public form of withdrawal', () => {
  it('stops an address that asks too much in an hour, whatever the route or the order (429 RATE_LIMITED)', async () => {
    await withLimits({ address: 3 }, async () => {
      // three requests of three routes for three orders: each count against the one address
      expect((await calls.route(2_000_000_001)).statusCode).toBe(200);
      expect((await calls.form(2_000_000_002)).statusCode).toBe(400);
      expect((await calls.proof(2_000_000_003)).statusCode).toBe(400);

      for (const call of Object.values(calls)) {
        const refused = await call(2_000_000_004);
        expect(refused.statusCode).toBe(429);
        expect(refused.json()).toMatchObject({
          errorCode: 'RATE_LIMITED',
          details: { limit: 'withdrawalForm' },
        });
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      }
    });
  });

  it('stops the requests for one order, so a script cannot guess the codes of it, while another order is still served', async () => {
    await withLimits({ order: 2, address: 1000 }, async () => {
      for (let i = 0; i < 2; i += 1)
        expect((await calls.proof(2_000_000_010)).statusCode).toBe(400);

      const refused = await calls.proof(2_000_000_010);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'withdrawalForm' },
      });

      // the count is the order's: its form and its route are stopped too, another order is not
      expect((await calls.route(2_000_000_010)).statusCode).toBe(429);
      expect((await calls.form(2_000_000_010)).statusCode).toBe(429);
      expect((await calls.route(2_000_000_011)).statusCode).toBe(200);
    });
  });

  // a script that guesses the name of the recipient of an order from many addresses meets one count
  it('counts the requests for one order from every address', async () => {
    await withLimits({ order: 2, address: 1000 }, async () => {
      const from = (remoteAddress: string) =>
        app.inject({
          method: 'POST',
          url: '/api/withdrawals/route',
          headers: withCsrf(csrf),
          payload: { orderId: 2_000_000_030 },
          remoteAddress,
        });

      expect((await from('203.0.113.1')).statusCode).toBe(200);
      expect((await from('203.0.113.2')).statusCode).toBe(200);
      expect((await from('203.0.113.3')).statusCode).toBe(429);
    });
  });

  // the code comes with the mails of the buyer and cannot be guessed (the limit of the address
  // stops a try): a request with it is the buyer's, and nobody can use up their requests
  it('never stops a request that carries the code of the order, however many others came for it', async () => {
    await withLimits({ order: 2, address: 1000 }, async () => {
      const orderId = 2_000_000_040;
      for (let i = 0; i < 2; i += 1) expect((await calls.route(orderId)).statusCode).toBe(200);
      expect((await calls.route(orderId)).statusCode).toBe(429);

      for (let i = 0; i < 3; i += 1) {
        const own = await post('/api/withdrawals/route', {
          orderId,
          code: withdrawalCodeOf(orderId),
        });
        expect(own.statusCode).toBe(200);
      }
    });
  });

  // a script that tries the orders of one person, from many addresses, meets one count: the phone
  // of the recipient by its digits (the name when no phone is given); the code counts nothing
  it('counts the facts of one recipient for every order and every address', async () => {
    await withLimits({ data: 2, order: 1000, address: 1000 }, async () => {
      const items = (orderId: number, phone: string, remoteAddress: string, code?: string) =>
        app.inject({
          method: 'POST',
          url: '/api/withdrawals/items',
          headers: withCsrf(csrf),
          payload: {
            orderId,
            recipientName: 'Anna Koval',
            phone,
            country: 'UA',
            ...(code ? { code } : {}),
          },
          remoteAddress,
        });

      expect((await items(2_000_000_050, '+380501234567', '203.0.113.11')).statusCode).toBe(400);
      expect((await items(2_000_000_051, '+38 050 123 45 67', '203.0.113.12')).statusCode).toBe(
        400,
      );
      const refused = await items(2_000_000_052, '380501234567', '203.0.113.13');
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED' });

      // another recipient is served, and so is a request with the code of its order
      expect((await items(2_000_000_053, '+380671112233', '203.0.113.14')).statusCode).toBe(400);
      const orderId = 2_000_000_054;
      expect(
        (await items(orderId, '+380501234567', '203.0.113.15', withdrawalCodeOf(orderId)!))
          .statusCode,
      ).toBe(400);
    });
  });

  it('counts an order sent as a text of its number as the same order, so the limit cannot be passed by the type', async () => {
    await withLimits({ order: 2, address: 1000 }, async () => {
      expect((await post('/api/withdrawals/route', { orderId: 2_000_000_020 })).statusCode).toBe(
        200,
      );
      expect((await post('/api/withdrawals/route', { orderId: '2000000020' })).statusCode).toBe(
        200,
      );

      const refused = await post('/api/withdrawals/route', { orderId: 2_000_000_020 });
      expect(refused.statusCode).toBe(429);
    });
  });
});
