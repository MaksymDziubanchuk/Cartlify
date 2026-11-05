import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

// GET /api/shop-settings: the data of the shop a guest or a buyer is shown (the name, the logo,
// the languages, the seller the shop names). Delivery is its own route (GET /api/delivery/methods)

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(stopApp);

describe('GET /api/shop-settings', () => {
  it('gives a guest the public data of the shop, nothing more', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shop-settings' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'shopName',
        'logoUrl',
        'shopLocale',
        'enabledLocales',
        'sellerLegalName',
        'sellerAddress',
        'sellerTaxId',
        'sellerEmail',
        'sellerPhone',
      ].sort(),
    );
    expect(typeof body.shopName).toBe('string');
    expect(body.shopLocale).toMatch(/^[a-z]{2}$/);
    expect(Array.isArray(body.enabledLocales)).toBe(true);
    expect(body.enabledLocales).toContain(body.shopLocale);
  });
});
