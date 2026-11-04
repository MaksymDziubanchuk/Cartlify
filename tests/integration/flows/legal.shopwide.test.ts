import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { shippingData } from '../../helpers/orders.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The versions of the terms, each step with what its actor sees: a buyer accepts the versions in
// force the page asks for, root publishes a new version of the terms, the buyer is asked for it
// when confirming the cart, reads it, accepts it and the order is confirmed; an admin finds the
// consents of the buyer by the email. A version in force is for the whole shop: the file runs alone
// (.shopwide.test.ts). The refusals of each route are in tests/integration/api/legal.
let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Iryna Terms' });
});

afterAll(async () => {
  try {
    await closeSessions([root.id, admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

type Version = { id: number; kind: string; version: number; title: string };

describe('a new version of the terms', () => {
  it('is published by root, accepted by the buyer at the confirmation and seen by an admin in the log of consents', async () => {
    const tag = uniqueTag();
    const product = await createProduct({ price: 12, stock: 3 });

    // the terms the shop starts with; the buyer accepts what the page asks for
    const first = await j.post(root, '/api/root/legal-documents', {
      kind: 'terms',
      title: `Terms before ${tag}`,
      content: `The terms of the shop before ${tag}.`,
    });
    expect(first.statusCode).toBe(201);
    const asked = await j.get(buyer, '/api/legal/acceptances/me');
    expect(asked.statusCode).toBe(200);
    expect(asked.json().required).toContain('terms');
    const inForce = (asked.json().current as Version[]).map(({ id }) => id);
    const accepted = await j.post(buyer, '/api/legal/acceptances', { documentIds: inForce });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().required).toEqual([]);

    const added = await j.post(buyer, '/api/orders/current/items', {
      variantId: product.variantId,
      quantity: 1,
    });
    expect(added.statusCode).toBe(200);
    const orderId = (await j.get(buyer, '/api/orders/current')).json().id as number;

    // root publishes a new version of the terms, the first of the list now
    const content = `The terms of the shop, ${tag}.`;
    const published = await j.post(root, '/api/root/legal-documents', {
      kind: 'terms',
      title: `Terms ${tag}`,
      content,
    });
    expect(published.statusCode).toBe(201);
    const versions = await j.get(root, '/api/root/legal-documents?kind=terms&limit=1');
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items).toMatchObject([
      { title: `Terms ${tag}`, publishedBy: { id: root.id } },
    ]);

    // the confirmation names the new version; the buyer reads it, accepts it and confirms
    const refused = await j.post(buyer, '/api/orders/current/confirm', {
      orderId,
      ...shippingData,
    });
    expect(refused.statusCode).toBe(409);
    const newTerms = (refused.json().details.current as Version[]).find(
      ({ kind }) => kind === 'terms',
    )!;
    const text = await j.get(null, `/api/legal/documents/${newTerms.id}`);
    expect(text.statusCode).toBe(200);
    expect(text.json()).toMatchObject({ title: `Terms ${tag}`, content });
    expect(
      (await j.post(buyer, '/api/legal/acceptances', { documentIds: [newTerms.id] })).json()
        .required,
    ).toEqual([]);
    const confirmed = await j.post(buyer, '/api/orders/current/confirm', {
      orderId,
      ...shippingData,
    });
    expect(confirmed.statusCode).toBe(200);

    const mine = await j.get(buyer, '/api/legal/acceptances/me');
    expect(mine.json().accepted).toEqual(
      expect.arrayContaining([expect.objectContaining({ documentId: newTerms.id, kind: 'terms' })]),
    );

    // an admin finds the buyer by the email and reads the consents, the new version among them
    const found = await j.get(admin, `/api/users?email=${encodeURIComponent(buyer.email)}`);
    const buyerId = (found.json().items as { id: number }[])[0]!.id;
    const log = await j.get(admin, `/api/admin/consent-log?userId=${buyerId}`);
    expect(log.statusCode).toBe(200);
    expect(
      (log.json().items as { documentId: number }[]).map(({ documentId }) => documentId),
    ).toEqual(expect.arrayContaining([...inForce, newTerms.id]));
  });
});
