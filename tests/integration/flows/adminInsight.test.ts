import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { placeOrder } from '../../helpers/orders.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// What an admin learns of the shop, each step with what the admin sees: the alert of low stock
// leads to the variants (a threshold of their own, a case put aside, a delivery that ends the case),
// the report of the accounting counts a delivery and a sale, and the journals keep the change of a
// product and the login. The counts of the whole shop and the rules of each kind are the tests of
// api/admin (alerts*, report*, journals, auditLog).
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Report Buyer' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

type Alert = {
  kind: string;
  subscribed: boolean;
  dismissed: number;
  threshold: { value: number } | number | null;
  list: { path: string; query: Record<string, string> } | null;
};

const alertOf = async (kind: string) =>
  ((await j.get(admin, '/api/admin/alerts')).json().alerts as Alert[]).find(
    (alert) => alert.kind === kind,
  )!;

// the variants of a category the list of an alert leads to
const variantsInList = async (kind: string, categoryId: number) => {
  const { list } = await alertOf(kind);
  const query = new URLSearchParams({ ...list!.query, categoryIds: String(categoryId) });
  const res = await j.get(admin, `${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { variant: { id: number } }[]).map(({ variant }) => variant.id);
};

describe('what an admin learns of the shop', () => {
  it('follows the alert of low stock to a variant, sets a threshold, puts the case aside, and a delivery ends it', async () => {
    const category = await createCategory();
    const product = await createProduct({ categoryId: category.id, stock: 2 });

    expect(await variantsInList('low_stock', category.id)).toEqual([product.variantId]);

    // the admin wants to hear of three units and less, and puts the case aside for now
    const threshold = await j.put(admin, '/api/admin/alerts/subscriptions/low_stock/threshold', {
      value: 3,
    });
    expect(threshold.json().threshold).toMatchObject({ value: 3, custom: true });
    expect((await alertOf('low_stock')).list!.query).toMatchObject({ maxStock: '3' });
    const aside = await j.put(
      admin,
      `/api/admin/alerts/dismissals/low_stock/${product.variantId}`,
      {},
    );
    expect(aside.json()).toMatchObject({ dismissed: true });
    expect((await j.get(admin, '/api/admin/alerts/dismissals')).json().items).toEqual([
      expect.objectContaining({ kind: 'low_stock', id: String(product.variantId) }),
    ]);
    expect((await alertOf('low_stock')).dismissed).toBe(1);

    // a delivery of ten: the variant leaves the list
    const delivery = await j.post(admin, '/api/products/stock/deliveries', {
      source: 'supplier',
      supplier: 'Refill',
      items: [{ variantId: product.variantId, quantity: 10, unitCost: 3 }],
    });
    expect(delivery.statusCode).toBe(201);
    expect(await variantsInList('low_stock', category.id)).toEqual([]);

    // the case back, the threshold of the server, the kind off and on again
    expect(
      (await j.del(admin, `/api/admin/alerts/dismissals/low_stock/${product.variantId}`)).json(),
    ).toMatchObject({
      dismissed: false,
    });
    expect(
      (await j.del(admin, '/api/admin/alerts/subscriptions/low_stock/threshold')).json().threshold,
    ).toMatchObject({
      value: 5,
      custom: false,
    });
    expect(
      (await j.del(admin, '/api/admin/alerts/subscriptions/low_stock')).json().subscribed,
    ).toBe(false);
    const subscriptions = (await j.get(admin, '/api/admin/alerts/subscriptions')).json()
      .items as Alert[];
    expect(subscriptions.find(({ kind }) => kind === 'low_stock')).toMatchObject({
      subscribed: false,
    });
    expect(
      (await j.put(admin, '/api/admin/alerts/subscriptions/low_stock', {})).json().subscribed,
    ).toBe(true);
  });

  it('counts a delivery and a sale in the report, and the journals keep the change of a product and the login', async () => {
    const tag = uniqueTag();
    const category = await createCategory();
    const product = await createProduct({
      categoryId: category.id,
      name: `Vase ${tag}`,
      price: 25,
      stock: 0,
    });
    const from = new Date(Date.now() - 60_000).toISOString();

    expect(
      (
        await j.post(admin, '/api/products/stock/deliveries', {
          source: 'supplier',
          supplier: `Glass ${tag}`,
          items: [{ variantId: product.variantId, quantity: 4, unitCost: 9 }],
        })
      ).statusCode,
    ).toBe(201);
    await placeOrder(app, csrf, buyer, product, 'paid', 2);
    const period = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;

    // the report of the product, by product and by day
    const report = await j.get(
      admin,
      `/api/admin/reports/accounting?${period}&productIds=${product.id}`,
    );
    expect(report.statusCode).toBe(200);
    expect(report.json().sales).toMatchObject({ units: 2, revenue: 50, cost: 18, margin: 32 });
    expect(report.json().purchases).toMatchObject({ units: 4, value: 36 });
    const byProduct = await j.get(
      admin,
      `/api/admin/reports/accounting/products?${period}&categoryId=${category.id}`,
    );
    expect(byProduct.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: product.id }),
        sales: expect.objectContaining({ units: 2 }),
      }),
    ]);
    const byCategory = await j.get(
      admin,
      `/api/admin/reports/accounting/categories?${period}&categoryId=${category.id}`,
    );
    expect(byCategory.json().items).toEqual([
      expect.objectContaining({ id: category.id, sales: expect.objectContaining({ units: 2 }) }),
    ]);
    const byVariant = await j.get(
      admin,
      `/api/admin/reports/accounting/variants?${period}&productIds=${product.id}`,
    );
    expect(byVariant.json().items).toEqual([
      expect.objectContaining({
        variant: expect.objectContaining({ id: product.variantId }),
        sales: expect.objectContaining({ units: 2 }),
      }),
    ]);
    const byDay = await j.get(
      admin,
      `/api/admin/reports/accounting/timeline?${period}&productIds=${product.id}&step=day`,
    );
    expect(byDay.statusCode).toBe(200);
    const days = byDay.json().items as { sales: { units: number } }[];
    expect(days.reduce((sum, day) => sum + day.sales.units, 0)).toBe(2);

    // the journals for the analysis: the stock of the product taken together by event, with the
    // sum of the changes; the money of its order taken together by purpose, with the sums
    const stock = await j.get(
      admin,
      `/api/admin/stock-log/groups?productId=${product.id}&groupBy=event&sortBy=event&sortOrder=asc`,
    );
    expect(stock.statusCode).toBe(200);
    expect(stock.json().items).toEqual([
      expect.objectContaining({ event: 'stock.delivery', count: 1, quantityChange: 4 }),
      expect.objectContaining({ event: 'stock.sale', count: 1, quantityChange: -2 }),
    ]);
    const stockPage = await j.get(admin, `/api/admin/stock-log?productId=${product.id}`);
    expect(stockPage.json().sums).toEqual({ quantityChange: 2 });
    const money = await j.get(
      admin,
      `/api/admin/money-log/groups?userId=${buyer.id}&groupBy=purpose`,
    );
    expect(money.statusCode).toBe(200);
    expect(money.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ purpose: 'order' })]),
    );

    // the journals: the new name of the product with who gave it, and the login of the admin
    expect(
      (await j.patch(admin, `/api/products/${product.id}`, { name: `Tall vase ${tag}` }))
        .statusCode,
    ).toBe(200);
    const audit = await j.get(
      admin,
      `/api/admin/audit-log?entityType=product&entityId=${product.id}`,
    );
    expect(audit.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: admin.id, entityId: product.id }),
      ]),
    );
    expect(
      (await logIn(app, csrf, { email: admin.email, password: admin.password })).statusCode,
    ).toBe(200);
    const events = (await j.get(admin, '/api/admin/log-events')).json();
    expect(events.loginLog).toContain('login.password');
    const logins = await j.get(
      admin,
      `/api/admin/login-log?email=${encodeURIComponent(admin.email)}&events=login.password`,
    );
    expect(logins.json().items).toEqual([
      expect.objectContaining({ userId: admin.id, event: 'login.password' }),
    ]);
  });
});
