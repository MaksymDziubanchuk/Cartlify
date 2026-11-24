import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';

// GET /api/delivery/methods: how this shop gets an order to its buyer, for the page that confirms an
// order: the methods it has enabled, where and when a buyer collects an order, and the zones it
// delivers to with what the manual delivery there costs and from which sum every delivery there is
// free. Everybody reads it, a guest too

let app: FastifyInstance;
let buyer: TestUser;

beforeAll(async () => {
  app = await startApp();
  buyer = await createUser();
});

afterEach(resetShopSettings);

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
  it('gives a guest the methods of the shop and its zones', async () => {
    setShopSettings({
      deliveryMethods: ['manual', 'pickup', 'carrier'],
      deliveryZones: [
        { name: 'Spain', countries: ['ES'], manualPrice: 5, freeFrom: 60 },
        { name: 'EU', countries: ['FR', 'DE'], manualPrice: null, freeFrom: null },
      ],
      pickupAddress: 'Main street 1, Kyiv',
      pickupHours: 'Mon-Fri 10:00-18:00',
    });

    const res = await read({ cookie: `guestId=${randomUUID()}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      currency: 'eur',
      methods: [
        { method: 'manual', address: null, hours: null },
        { method: 'pickup', address: 'Main street 1, Kyiv', hours: 'Mon-Fri 10:00-18:00' },
        { method: 'carrier', address: null, hours: null },
      ],
      zones: [
        { name: 'Spain', countries: ['ES'], manualPrice: 5, freeFrom: 60 },
        { name: 'EU', countries: ['FR', 'DE'], manualPrice: null, freeFrom: null },
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

  it('leaves out a method the shop has not enabled, and gives no zone a shop has not set', async () => {
    setShopSettings({ deliveryMethods: ['pickup'], deliveryZones: [] });

    const body = (await read()).json();

    expect(body.methods.map((m: { method: string }) => m.method)).toEqual(['pickup']);
    expect(body.zones).toEqual([]);
  });
});
