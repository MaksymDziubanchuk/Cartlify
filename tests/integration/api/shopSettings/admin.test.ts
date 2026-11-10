import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';

// GET /api/admin/shop-settings(/missing): the current data of the shop for admin and root, every
// setting (including the ones GET /api/shop-settings leaves out); the settings that have no server
// default and still wait for root

let app: FastifyInstance;
let buyer: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  app = await startApp();
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await stopApp();
  }
});

const VALUE_KEYS = [
  'deliveryMethods',
  'deliveryFlatPrice',
  'deliveryFreeFrom',
  'deliveryCountries',
  'pickupAddress',
  'pickupHours',
  'shopName',
  'emailFromName',
  'emailReplyTo',
  'logoUrl',
  'reservationMinutes',
  'stripePageMinutes',
  'reviewCheckEnabled',
  'avatarRemovalsLimit',
  'reviewRemovalsLimit',
  'withdrawalGraceDays',
  'newsletterLimitCount',
  'newsletterLimitDays',
  'newsletterFromName',
  'newsletterTrustedDomains',
  'shopLocale',
  'enabledLocales',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
].sort();

describe('GET /api/admin/shop-settings', () => {
  it('refuses a guest and a buyer', async () => {
    const guest = await app.inject({ method: 'GET', url: '/api/admin/shop-settings' });
    expect(guest.statusCode).toBe(403);

    const asBuyer = await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(buyer) },
    });
    expect(asBuyer.statusCode).toBe(403);
  });

  it('gives admin and root every field, with keys GET /api/shop-settings leaves out', async () => {
    for (const actor of [admin, root]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/shop-settings',
        headers: { cookie: accessCookie(actor) },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(VALUE_KEYS);
      expect(body).toHaveProperty('deliveryCountries');
      expect(body).toHaveProperty('emailReplyTo');
    }
  });
});

describe('GET /api/admin/shop-settings/missing', () => {
  it('names the fields with no default of the server that are still empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings/missing',
      headers: { cookie: accessCookie(root) },
    });

    expect(res.statusCode).toBe(200);
    const { fields } = res.json();
    expect(Array.isArray(fields)).toBe(true);
    for (const field of fields) expect(VALUE_KEYS).toContain(field);
  });
});
