import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createReview,
  createUser,
  receiveBatch,
  uniqueTag,
  writeOffStock,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody } from '../../../helpers/multipart.js';
import { deliveryBody, placeOrder } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { safetyFormFields, shippingFormFields } from '../../../helpers/productSafety.js';

// the admin log and the log of prices name what made each line: the route that wrote it, or the
// condition it was written under (src/config/journalEvents.ts). Two lines of the same action from
// two routes have two events. Each test makes its own rows and reads the lines of them

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  actor: TestUser = admin,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

// the lines of an entity as action and event, in the order they were written
const linesOf = (
  entityType: 'product' | 'category' | 'order' | 'review' | 'user',
  entityId: number,
) =>
  asAdmin(async (tx) =>
    (
      await tx.adminAuditLog.findMany({
        where: { entityType, entityId },
        orderBy: { id: 'asc' },
        select: { action: true, event: true },
      })
    ).map((line) => `${line.action} ${line.event}`),
  );

const pricesOf = (productId: number) =>
  asAdmin(async (tx) =>
    (
      await tx.productPriceChangeLog.findMany({
        where: { productId },
        orderBy: { id: 'asc' },
        select: { event: true },
      })
    ).map((line) => line.event),
  );

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('the events of the lines of a product', () => {
  it('names the create, the change, the change of many, the move, the delete and the restore', async () => {
    const category = await createCategory();
    const { payload, headers } = multipartBody([
      { name: 'name', value: `Event product ${uniqueTag()}` },
      { name: 'price', value: '10' },
      { name: 'categoryId', value: String(category.id) },
      ...safetyFormFields(),
      ...shippingFormFields(),
      imageField('images', pngImage(30, 20)),
    ]);
    const created = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const productId = created.json().id as number;
    const other = await createCategory();

    await send('PATCH', `/api/products/${productId}`, { name: `Renamed ${uniqueTag()}` });
    await send('PATCH', '/api/products/batch', {
      items: [{ productId, name: `Batch ${uniqueTag()}` }],
    });
    await send('PATCH', `/api/products/${productId}/category`, { categoryId: other.id });
    await send('DELETE', `/api/products/${productId}`);
    await send('POST', `/api/products/${productId}/restore`);

    expect(await linesOf('product', productId)).toEqual([
      'PRODUCT_CREATE product.create',
      'PRODUCT_UPDATE product.update',
      'PRODUCT_UPDATE product.update_batch',
      'PRODUCT_UPDATE product.category_change',
      'PRODUCT_DELETE product.delete',
      'PRODUCT_UPDATE product.restore',
    ]);
  });

  it('names the price of one product and of many, in the log of prices too', async () => {
    const product = await createProduct({ price: 10 });

    await send('PATCH', `/api/products/${product.id}`, { price: 11 });
    await send('PATCH', '/api/products/batch', { items: [{ productId: product.id, price: 12 }] });

    expect(
      await linesOf('product', product.id).then((l) => l.filter((x) => x.includes('UPDATE'))),
    ).toEqual(['PRODUCT_UPDATE product.update', 'PRODUCT_UPDATE product.update_batch']);
    expect(await pricesOf(product.id)).toEqual(['price.set', 'price.set_batch']);
  });

  it('names a sale put on and taken off by its own route', async () => {
    const product = await createProduct({ price: 100, stock: 0 });

    await send('PATCH', `/api/products/${product.id}/sale`, {
      sale: { percent: 10, endsAt: inDays(2) },
    });
    await send('PATCH', `/api/products/${product.id}/sale`, { sale: null });

    expect(await linesOf('product', product.id)).toEqual([
      'PRODUCT_SALE product.sale_set',
      'PRODUCT_SALE product.sale_remove',
    ]);
    expect(await pricesOf(product.id)).toEqual(['price.sale_start', 'price.sale_end']);
  });

  it('names a sale put on by the route of many sales', async () => {
    const product = await createProduct({ price: 100, stock: 0 });

    const res = await send('POST', '/api/products/sales', {
      items: [{ productId: product.id, sale: { percent: 10, endsAt: inDays(2) } }],
    });

    expect(res.statusCode).toBe(200);
    expect(await linesOf('product', product.id)).toEqual(['PRODUCT_SALE product.sale_set_bulk']);
    expect(await pricesOf(product.id)).toEqual(['price.sale_start']);
  });

  it('names a sale that goes or comes together with a price, apart from the sale routes', async () => {
    const product = await createProduct({ price: 100, stock: 0 });
    await send('PATCH', `/api/products/${product.id}/sale`, {
      sale: { percent: 10, endsAt: inDays(2) },
    });

    // the sale goes with the new price, a new one comes with it
    const res = await send('PATCH', `/api/products/${product.id}`, {
      price: 120,
      sale: { percent: 5, endsAt: inDays(3) },
    });
    expect(res.statusCode).toBe(200);

    expect(await linesOf('product', product.id)).toEqual([
      'PRODUCT_SALE product.sale_set',
      'PRODUCT_SALE product.sale_remove_with_price',
      'PRODUCT_UPDATE product.update',
      'PRODUCT_SALE product.sale_set_with_price',
    ]);
    expect(await pricesOf(product.id)).toEqual([
      'price.sale_start',
      'price.sale_end',
      'price.set',
      'price.sale_start',
    ]);
  });

  it('names a sale taken off with the prices of many products', async () => {
    const product = await createProduct({ price: 100, stock: 0 });
    await send('PATCH', `/api/products/${product.id}/sale`, {
      sale: { percent: 10, endsAt: inDays(2) },
    });

    const res = await send('PATCH', '/api/products/batch', {
      items: [{ productId: product.id, price: 130, sale: null }],
    });
    expect(res.statusCode).toBe(200);

    expect(await linesOf('product', product.id)).toEqual([
      'PRODUCT_SALE product.sale_set',
      'PRODUCT_SALE product.sale_remove_with_price',
      'PRODUCT_UPDATE product.update_batch',
    ]);
    expect(await pricesOf(product.id)).toEqual([
      'price.sale_start',
      'price.sale_end',
      'price.set_batch',
    ]);
  });

  it('names the bulk change of prices, its line for the whole change and its line for each product', async () => {
    const product = await createProduct({ price: 100, stock: 0 });
    await send('PATCH', `/api/products/${product.id}/sale`, {
      sale: { percent: 10, endsAt: inDays(2) },
    });

    const res = await send('PATCH', '/api/products', {
      mode: 'percent',
      value: 10,
      scope: { productIds: [product.id] },
      sale: 'remove',
    });
    expect(res.statusCode).toBe(200);

    expect(await linesOf('product', product.id)).toEqual([
      'PRODUCT_SALE product.sale_set',
      'PRODUCT_SALE product.sale_remove_with_price',
    ]);
    expect(await pricesOf(product.id)).toEqual([
      'price.sale_start',
      'price.sale_end',
      'price.bulk',
    ]);
    // the line of the whole change belongs to no product
    const whole = await asAdmin((tx) =>
      tx.adminAuditLog.findFirst({
        where: { entityType: 'product', entityId: 0, action: 'PRODUCT_PRICE_BULK_UPDATE' },
        orderBy: { id: 'desc' },
        select: { event: true },
      }),
    );
    expect(whole).toEqual({ event: 'product.price_bulk' });
  });

  it('names the lines the database writes: a delivery, a write-off, a sale a price ended', async () => {
    const product = await createProduct({ price: 100, stock: 0 });
    await receiveBatch(product.id, { quantity: 5, unitCost: 3 });
    await writeOffStock(product.id, 1, { reason: 'damaged' });
    await send('PATCH', `/api/products/${product.id}/sale`, {
      sale: { percent: 10, endsAt: inDays(2) },
    });
    // a price down to the sale price, not through the api: the database ends the sale itself
    await testTx(async (tx) => {
      await setUserContext(tx, { userId: admin.id, role: 'ADMIN' });
      await tx.$executeRaw`update cartlify.products set price = 90 where id = ${product.id}`;
    });

    expect(await linesOf('product', product.id)).toEqual([
      'STOCK_DELIVERY stock.delivery',
      'STOCK_WRITE_OFF stock.write_off',
      'PRODUCT_SALE product.sale_set',
      'PRODUCT_SALE product.sale_end_by_price',
    ]);
  });
});

describe('the events of the lines of a review and of a category', () => {
  it('names the removal of a review', async () => {
    const author = await newUser();
    const product = await createProduct();
    const review = await createReview(author.id, product.id, { rating: 1, comment: 'Bad words' });

    const res = await send('DELETE', `/api/products/${product.id}/reviews/${review.id}`);

    expect(res.statusCode).toBe(200);
    expect(await linesOf('review', review.id)).toEqual(['REVIEW_DELETE review.delete']);
  });

  it('names the create, the change and the delete of a category, and the move of its children', async () => {
    const tag = uniqueTag();
    const created = await send('POST', '/api/categories', {
      name: `Event ${tag}`,
      slug: `event-${tag}`,
    });
    const categoryId = created.json().id as number;
    const child = await send('POST', '/api/categories', {
      name: `Child ${tag}`,
      slug: `child-${tag}`,
    });
    const childId = child.json().id as number;
    await send('PATCH', `/api/categories/${childId}`, { parentId: categoryId });

    await send('PATCH', `/api/categories/${categoryId}`, { description: 'Words' });
    const removed = await send('DELETE', `/api/categories/${categoryId}`);

    expect(removed.statusCode).toBe(200);
    expect(await linesOf('category', categoryId)).toEqual([
      'OTHER category.create',
      'CATEGORY_UPDATE category.update',
      'OTHER category.delete',
    ]);
    // the child goes to the parent of the removed category
    expect(await linesOf('category', childId)).toEqual([
      'OTHER category.create',
      'CATEGORY_UPDATE category.update',
      'CATEGORY_UPDATE category.reparent_on_delete',
    ]);
  });
});

describe('the events of the lines of an order', () => {
  const { address: _address, ...person } = deliveryBody;

  const paid = async (delivery: Record<string, unknown> = deliveryBody) =>
    placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10, stock: 5 }),
      'paid',
      1,
      delivery,
    );

  const step = (orderId: number, status: string, extra: object = {}) =>
    send('PATCH', `/api/orders/${orderId}/status`, { status, ...extra });

  it('names the steps of shipping and the steps back, one at a time', async () => {
    const orderId = await paid();

    expect((await step(orderId, 'shipped', { shipment: { carrier: 'DHL' } })).statusCode).toBe(200);
    expect((await step(orderId, 'delivered')).statusCode).toBe(200);
    expect((await step(orderId, 'shipped')).statusCode).toBe(200);
    expect((await step(orderId, 'paid', { keepShippingCost: false })).statusCode).toBe(200);

    expect(await linesOf('order', orderId)).toEqual([
      'ORDER_STATUS_CHANGE order.ship',
      'ORDER_STATUS_CHANGE order.deliver',
      'ORDER_STATUS_CHANGE order.deliver_back',
      'ORDER_STATUS_CHANGE order.ship_back',
    ]);
  });

  // a pickup goes no carrier's way: it is made ready and collected, each with an event of its own
  it('names the steps of a pickup and the steps back apart from the ones of a send', async () => {
    const orderId = await paid({ ...person, method: 'pickup' });

    expect((await step(orderId, 'shipped')).statusCode).toBe(200);
    expect((await step(orderId, 'delivered')).statusCode).toBe(200);
    expect((await step(orderId, 'shipped')).statusCode).toBe(200);
    expect((await step(orderId, 'paid')).statusCode).toBe(200);

    expect(await linesOf('order', orderId)).toEqual([
      'ORDER_STATUS_CHANGE order.pickup_ready',
      'ORDER_STATUS_CHANGE order.pickup_collected',
      'ORDER_STATUS_CHANGE order.pickup_collected_back',
      'ORDER_STATUS_CHANGE order.pickup_ready_back',
    ]);
  });

  it('names the steps of the route of many orders apart from the ones of the route of one', async () => {
    const first = await paid();
    const second = await paid({ ...person, method: 'pickup' });

    const shipped = await send('POST', '/api/orders/status', {
      status: 'shipped',
      orders: [{ orderId: first }, { orderId: second }],
    });
    const delivered = await send('POST', '/api/orders/status', {
      status: 'delivered',
      orders: [{ orderId: first }],
    });
    const back = await send('POST', '/api/orders/status', {
      status: 'paid',
      orders: [{ orderId: second }],
    });

    expect(shipped.statusCode).toBe(200);
    expect(delivered.statusCode).toBe(200);
    expect(back.statusCode).toBe(200);
    expect(await linesOf('order', first)).toEqual([
      'ORDER_STATUS_CHANGE order.ship_bulk',
      'ORDER_STATUS_CHANGE order.deliver_bulk',
    ]);
    expect(await linesOf('order', second)).toEqual([
      'ORDER_STATUS_CHANGE order.pickup_ready_bulk',
      'ORDER_STATUS_CHANGE order.pickup_ready_back_bulk',
    ]);
  });

  // the details of a send are mailed to the buyer, its cost is not: two events, and a change of
  // both is a line of each
  it('names the change of the details of a send, of its cost and of the delivery data', async () => {
    const orderId = await paid();
    await step(orderId, 'shipped', { shipment: { carrier: 'DHL' } });
    const [shipment] = await asAdmin((tx) => tx.orderShipment.findMany({ where: { orderId } }));
    const second = await paid();
    const url = `/api/orders/${orderId}/shipments/${shipment!.id}`;

    await send('PATCH', url, { cost: 6.5 });
    await send('PATCH', url, { trackingNumber: 'JD0146' });
    await send('PATCH', url, { trackingNumber: 'JD0147', cost: 7 });
    await send('PATCH', `/api/orders/${second}/delivery`, { recipientFirstName: 'Olha' });

    expect(await linesOf('order', orderId)).toEqual([
      'ORDER_STATUS_CHANGE order.ship',
      'ORDER_SHIPMENT_CHANGE order.shipment_cost_change',
      'ORDER_SHIPMENT_CHANGE order.shipment_tracking_change',
      'ORDER_SHIPMENT_CHANGE order.shipment_tracking_change',
      'ORDER_SHIPMENT_CHANGE order.shipment_cost_change',
    ]);
    expect(await linesOf('order', second)).toEqual(['ORDER_DELIVERY_CHANGE order.delivery_change']);
  });

  it('names the cancel of a paid order', async () => {
    const { orderId } = await placePaidOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10, stock: 5 }),
    );

    const res = await send('POST', `/api/orders/${orderId}/cancel`);

    expect(res.statusCode).toBe(200);
    expect(await linesOf('order', orderId)).toEqual(['ORDER_STATUS_CHANGE order.cancel']);
  });

  it.each([
    [true, 'order.cancel_shipped_paid'],
    [false, 'order.cancel_shipped_unpaid'],
  ])(
    'names the cancel of an order on its way by whether the carrier was paid (%s)',
    async (shippingPaid, event) => {
      const { orderId } = await placePaidOrder(
        app,
        csrf,
        await newUser(),
        await createProduct({ price: 10, stock: 5 }),
      );
      await step(orderId, 'shipped', { shipment: { carrier: 'DHL', cost: 5 } });

      const res = await send('POST', `/api/orders/${orderId}/cancel`, { shippingPaid });

      expect(res.statusCode).toBe(200);
      expect((await linesOf('order', orderId)).at(-1)).toBe(`ORDER_STATUS_CHANGE ${event}`);
    },
  );
});

describe('the events of the lines of an account', () => {
  it('names the grant and the revoke of the role of an admin and the delete of an account', async () => {
    const user = await newUser();

    await send('POST', '/api/root/admins', { userId: user.id }, root);
    await send('DELETE', `/api/root/admins/${user.id}`, undefined, root);
    const removed = await send('DELETE', `/api/users/${user.id}`, undefined, root);

    expect(removed.statusCode).toBeLessThan(300);
    expect(await linesOf('user', user.id)).toEqual([
      'USER_ROLE_CHANGE user.role_grant',
      'USER_ROLE_CHANGE user.role_revoke',
      'OTHER user.delete',
    ]);
  });

  it('names the removal of an avatar by a moderator', async () => {
    const tag = uniqueTag();
    const user = await newUser({
      avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/test/users/${tag}/avatar.png`,
      publicId: `test/users/${tag}/avatar`,
    });

    const res = await send('DELETE', `/api/users/${user.id}/avatar`);

    expect(res.statusCode).toBe(200);
    expect(await linesOf('user', user.id)).toEqual(['OTHER user.avatar_remove']);
  });
});
