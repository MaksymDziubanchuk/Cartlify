import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody } from '../../../helpers/multipart.js';
import { distinct, galleryIdsOf, variantRowsOf } from '../../../helpers/variants.js';

// who may change the variants of a product and its gallery: admin and root; a guest and a user get
// 403, a request without the csrf token gets 403 too; an id in the path is checked before anything

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let product: TestProduct;
let imageId: number;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser();
  product = await createProduct();
  [imageId] = (await galleryIdsOf(product.id)) as [number];
});

afterAll(async () => {
  try {
    await removeProducts([product]);
    await closeSessions([admin.id, root.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

type Ids = { p: string | number; v: string | number; i: string | number };

type Call = {
  name: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  url: (ids: Ids) => string;
  payload?: () => Record<string, unknown>;
  form?: boolean;
};

const CALLS: Call[] = [
  {
    name: 'add variants',
    method: 'POST',
    url: ({ p }) => `/api/products/${p}/variants`,
    payload: () => ({
      variants: [{ price: 5, withoutShippingData: true, images: [{ imageId, position: 1 }] }],
    }),
  },
  {
    name: 'change a variant',
    method: 'PATCH',
    url: ({ p, v }) => `/api/products/${p}/variants/${v}`,
    payload: () => ({ weightGrams: 123 }),
  },
  {
    name: 'delete a variant',
    method: 'DELETE',
    url: ({ p, v }) => `/api/products/${p}/variants/${v}`,
  },
  {
    name: 'restore a variant',
    method: 'POST',
    url: ({ p, v }) => `/api/products/${p}/variants/${v}/restore`,
  },
  {
    name: 'add pictures to the gallery',
    method: 'POST',
    url: ({ p }) => `/api/products/${p}/images`,
    form: true,
  },
  {
    name: 'take a picture out of the gallery',
    method: 'DELETE',
    url: ({ p, i }) => `/api/products/${p}/images/${i}`,
  },
  {
    name: 'change the product',
    method: 'PATCH',
    url: ({ p }) => `/api/products/${p}`,
    payload: () => ({ name: 'Not renamed' }),
  },
  {
    name: 'delete the product',
    method: 'DELETE',
    url: ({ p }) => `/api/products/${p}`,
  },
  {
    name: 'restore the product',
    method: 'POST',
    url: ({ p }) => `/api/products/${p}/restore`,
  },
  {
    name: 'move the product',
    method: 'PATCH',
    url: ({ p }) => `/api/products/${p}/category`,
    payload: () => ({ categoryId: product.categoryId }),
  },
];

const send = (call: Call, ids: Ids, headers: Record<string, string>) => {
  if (call.form) {
    const { payload, headers: formHeaders } = multipartBody([
      imageField('images', pngImage(20, 20)),
    ]);

    return app.inject({
      method: call.method,
      url: call.url(ids),
      headers: { ...headers, ...formHeaders },
      payload,
    });
  }

  return app.inject({
    method: call.method,
    url: call.url(ids),
    headers,
    ...(call.payload ? { payload: call.payload() } : {}),
  });
};

const real = () => ({ p: product.id, v: product.variantId, i: imageId });

describe('the routes of the variants and of the gallery', () => {
  it.each(CALLS.map((call) => [call.name, call] as const))(
    'refuse a guest and a user (%s)',
    async (_name, call) => {
      for (const cookie of [undefined, accessCookie(buyer)]) {
        const res = await send(call, real(), withCsrf(csrf, cookie));

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      }
    },
  );

  it.each(CALLS.map((call) => [call.name, call] as const))(
    'refuse a request without the csrf token (%s)',
    async (_name, call) => {
      const res = await send(call, real(), { cookie: accessCookie(admin) });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
    },
  );

  it('change nothing for a guest or a user', async () => {
    const before = await variantRowsOf(product.id);

    for (const call of CALLS) {
      await send(call, real(), withCsrf(csrf, accessCookie(buyer)));
      await send(call, real(), withCsrf(csrf));
    }

    expect(await variantRowsOf(product.id)).toEqual(before);
    expect(await galleryIdsOf(product.id)).toEqual([imageId]);
  });

  it('let root add a variant, change it, take it out of sale and put it back', async () => {
    const headers = withCsrf(csrf, accessCookie(root));

    const added = await app.inject({
      method: 'POST',
      url: `/api/products/${product.id}/variants`,
      headers,
      payload: {
        variants: [
          {
            price: 5,
            withoutShippingData: true,
            images: [{ imageId, position: 1 }],
            // the product has a variant with no values already: this one tells itself apart
            attributes: await distinct('root'),
          },
        ],
      },
    });
    const variantId = added.json().variants[0].id as number;
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/variants/${variantId}`,
      headers,
      payload: { weightGrams: 50, withoutShippingData: true },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/products/${product.id}/variants/${variantId}`,
      headers,
    });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/products/${product.id}/variants/${variantId}/restore`,
      headers,
    });

    expect([added.statusCode, changed.statusCode, removed.statusCode, restored.statusCode]).toEqual(
      [201, 200, 200, 200],
    );
  });

  describe('an id in the path', () => {
    // not plain digits fails the schema of the route; a number the int column cannot hold passes it
    // and is stopped by the guard of the id
    it.each([
      ['a word', 'abc', 'VALIDATION_ERROR'],
      ['zero', '0', 'VALIDATION_ERROR'],
      ['negative', '-4', 'VALIDATION_ERROR'],
      ['over the largest id', '2147483648', 'INVALID_ID_PARAM'],
    ])(
      'refuses %s, for the product, the variant and the picture',
      async (_case, bad, errorCode) => {
        const headers = withCsrf(csrf, accessCookie(admin));

        for (const call of CALLS) {
          const ids: Ids = real();
          const bads: Partial<Ids>[] = [{ p: bad }];
          if (call.url({ p: 1, v: 'V', i: 'I' }).includes('V')) bads.push({ v: bad });
          if (call.url({ p: 1, v: 'V', i: 'I' }).includes('I')) bads.push({ i: bad });

          for (const over of bads) {
            const res = await send(call, { ...ids, ...over }, headers);

            expect([call.name, res.statusCode, res.json().errorCode]).toEqual([
              call.name,
              400,
              errorCode,
            ]);
          }
        }
      },
    );
  });
});
