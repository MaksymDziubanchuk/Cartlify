import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { resetDelivery, setDelivery } from '../../../helpers/delivery.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';

// GET /api/delivery/methods: how this shop gets an order to its buyer, for the page that confirms an
// order: the methods it has enabled, what the manual one costs, from which sum it is free, the
// countries it goes to, and where and when a buyer collects an order. Everybody reads it, a guest too

let app: FastifyInstance;
let buyer: TestUser;

beforeAll(async () => {
  app = await startApp();
  buyer = await createUser();
});

afterEach(resetDelivery);

afterAll(async () => {
  try {
    await closeSessions([buyer.id]);
  } finally {
    await stopApp();
  }
});

const read = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/api/delivery/methods', headers });

describe('GET /api/delivery/methods', () => {
  it('gives a guest the methods of the shop with the price of each', async () => {
    setDelivery({
      DELIVERY_METHODS: ['manual', 'pickup'],
      DELIVERY_FLAT_PRICE: 4.99,
      DELIVERY_FREE_FROM: 50,
      DELIVERY_COUNTRIES: ['UA', 'PL'],
      PICKUP_ADDRESS: 'Main street 1, Kyiv',
      PICKUP_HOURS: 'Mon-Fri 10:00-18:00',
    });

    const res = await read({ cookie: `guestId=${randomUUID()}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      currency: 'eur',
      methods: [
        {
          method: 'manual',
          price: 4.99,
          freeFrom: 50,
          countries: ['UA', 'PL'],
          address: null,
          hours: null,
        },
        {
          method: 'pickup',
          price: 0,
          freeFrom: null,
          countries: [],
          address: 'Main street 1, Kyiv',
          hours: 'Mon-Fri 10:00-18:00',
        },
      ],
    });
  });

  it('gives a buyer the same', async () => {
    const res = await read({ cookie: accessCookie(buyer) });

    expect(res.statusCode).toBe(200);
    expect(res.json().methods.map((m: { method: string }) => m.method)).toEqual([
      'manual',
      'pickup',
    ]);
  });

  it('says a delivery costs nothing when the shop names no price', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: null, DELIVERY_FREE_FROM: null });

    const manual = (await read()).json().methods[0];

    expect(manual).toMatchObject({ method: 'manual', price: 0, freeFrom: null });
  });

  it('leaves out a method the shop has not enabled', async () => {
    setDelivery({ DELIVERY_METHODS: ['pickup'] });

    const res = await read();

    expect(res.json().methods.map((m: { method: string }) => m.method)).toEqual(['pickup']);
  });

  it('lists the countries the shop has named, and none for a shop that only has a pickup', async () => {
    setDelivery({ DELIVERY_METHODS: ['manual'], DELIVERY_COUNTRIES: ['DE', 'GB'] });
    expect((await read()).json().methods[0].countries).toEqual(['DE', 'GB']);

    setDelivery({ DELIVERY_METHODS: ['pickup'] });
    expect((await read()).json().methods[0].countries).toEqual([]);
  });
});
