import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// GET /api/admin/consent-log: who agreed to which version of the terms and of the contract, and
// where. A version in force is for the whole shop and cannot be taken back: this file runs last
// and alone (.shopwide.test.ts, tests/setup/sequencer.mjs). The journal sorts, takes a period, the
// events and the columns the way the other journals do (journals.test.ts)

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await newUser({ role: 'ROOT' });
  admin = await newUser({ role: 'ADMIN' });
  buyer = await newUser();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Document = { id: number; kind: 'terms' | 'contract'; version: number; title: string };

async function published(kind: 'terms' | 'contract'): Promise<Document> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/root/legal-documents',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { kind, title: `The ${kind}`, content: `The ${kind} of the shop, ${Date.now()}.` },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Document;
}

const read = (query: string, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/consent-log?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

type Page = { items: Record<string, unknown>[]; total: number; nextCursor: string | null };

async function pageOf(query: string, actor: TestUser = admin): Promise<Page> {
  const res = await read(`${query}&limit=100`, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

// a customer who agreed to the versions in force, and an order confirmed with them
async function customerWithOrder() {
  const terms = await published('terms');
  const contract = await published('contract');
  const user = await newUser();
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/legal/acceptances',
    headers: { ...withCsrf(csrf, accessCookie(user)), 'user-agent': 'Consent browser' },
    payload: { documentIds: [terms.id, contract.id] },
  });
  expect(accepted.statusCode).toBe(200);
  const orderId = await placeOrder(
    app,
    csrf,
    user,
    await createProduct({ price: 10, stock: 5 }),
    'waiting',
  );

  return { user, terms, contract, orderId };
}

describe('GET /api/admin/consent-log', () => {
  it('lists the consents of a customer with the version, the event, the address and the browser', async () => {
    const { user, terms, contract, orderId } = await customerWithOrder();

    const page = await pageOf(`userId=${user.id}&sortBy=id&sortOrder=asc`);

    expect(page.total).toBe(4);
    expect(page.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        user: expect.objectContaining({
          id: user.id,
          email: user.email,
          role: 'USER',
          deleted: false,
        }),
        documentId: terms.id,
        document: { kind: 'terms', version: terms.version, title: 'The terms' },
        orderId: null,
        ip: '127.0.0.1',
        userAgent: 'Consent browser',
        event: 'consent.accept',
      }),
      expect.objectContaining({ documentId: contract.id, orderId: null, event: 'consent.accept' }),
      expect.objectContaining({ documentId: terms.id, orderId, event: 'consent.order' }),
      expect.objectContaining({ documentId: contract.id, orderId, event: 'consent.order' }),
    ]);
  });

  it('keeps the consents of one order, of one version and of one kind', async () => {
    const { user, terms, orderId } = await customerWithOrder();

    const ofOrder = await pageOf(`orderId=${orderId}`);
    const ofVersion = await pageOf(`userId=${user.id}&documentId=${terms.id}`);
    const ofContracts = await pageOf(`userId=${user.id}&kind=contract`);

    expect(ofOrder.total).toBe(2);
    expect(ofVersion.total).toBe(2);
    expect(
      ofContracts.items.every((item) => (item.document as { kind: string }).kind === 'contract'),
    ).toBe(true);
    expect(ofContracts.total).toBe(2);
  });

  it('keeps the consents of the events asked for, and sorts them', async () => {
    const { user } = await customerWithOrder();

    const orders = await pageOf(
      `userId=${user.id}&events=consent.order&sortBy=documentId&sortOrder=asc`,
    );
    const onlyColumns = await pageOf(
      `userId=${user.id}&columns=event,orderId&sortBy=orderId&sortOrder=desc`,
    );

    expect(orders.items.map((item) => item.event)).toEqual(['consent.order', 'consent.order']);
    const ids = orders.items.map((item) => item.documentId as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (const item of onlyColumns.items)
      expect(Object.keys(item).sort()).toEqual(['event', 'orderId']);
    // the consents of an order first, the ones without an order last
    expect(onlyColumns.items.map((item) => item.orderId === null)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('gives the consents as a csv file', async () => {
    const { user } = await customerWithOrder();

    const res = await read(`userId=${user.id}&format=csv&sortBy=id&sortOrder=asc`);

    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'id,createdAt,userId,userEmail,documentId,documentKind,documentVersion,orderId,ip,userAgent,event',
    );
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain(`,${user.email},`);
    expect(lines[1]).toContain(',consent.accept');
  });

  it('refuses an event the log has not, and a customer', async () => {
    const event = await read('events=nothing.here');
    const customer = await read('', buyer);

    expect(event.statusCode).toBe(400);
    expect(event.json()).toMatchObject({ errorCode: 'LOG_EVENTS_INVALID' });
    expect(customer.statusCode).toBe(403);
  });
});
