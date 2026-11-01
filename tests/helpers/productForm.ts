import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { imageField, pngImage } from './cloudinary.js';
import { withCsrf, type Csrf } from './csrf.js';
import type { TestUser } from './factories.js';
import { multipartBody, type FormPart } from './multipart.js';
import { manufacturerFormFields } from './productSafety.js';

// the form of POST /api/products with its variants: the fields of the product, the picture files of
// the gallery and `variants`, the text of a JSON list. A variant names its pictures by the number of
// a file (from 0)

export type FormVariant = Record<string, unknown>;

// a variant that is right: a price, the weight and the sizes a new variant needs, one picture (the
// first file) at the first place. A test changes what it checks
export const formVariant = (over: FormVariant = {}): FormVariant => ({
  price: 10,
  weightGrams: 350,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
  images: [{ file: 0, position: 1 }],
  ...over,
});

// the weight and the sizes a new variant needs, as the fields of a variant (a spread)
export const SHIPPING_FIELDS = { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 };

export type ProductFormOpts = {
  categoryId: number;
  name?: string;
  // the variants: a list (written as JSON), or the text itself, or none at all (null leaves the
  // field out)
  variants?: unknown[] | string | null;
  // how many picture files, each a png of a size of its own
  files?: number;
  // the fields of the form besides these, and the parts that replace the manufacturer
  extra?: FormPart[];
  manufacturer?: FormPart[];
};

export function productFormParts(opts: ProductFormOpts): FormPart[] {
  const files = opts.files ?? 1;
  // without variants of its own the form has one that shows every file
  const variants =
    opts.variants === undefined
      ? [
          formVariant({
            images: Array.from({ length: files }, (_, i) => ({ file: i, position: i + 1 })),
          }),
        ]
      : opts.variants;

  return [
    { name: 'name', value: opts.name ?? `Form product ${Date.now()}-${Math.random()}` },
    { name: 'categoryId', value: String(opts.categoryId) },
    ...(opts.manufacturer ?? manufacturerFormFields()),
    ...(variants === null
      ? []
      : [
          {
            name: 'variants',
            value: typeof variants === 'string' ? variants : JSON.stringify(variants),
          },
        ]),
    ...(opts.extra ?? []),
    // each file has a size of its own, so the files of a test are told apart
    ...Array.from({ length: files }, (_, index) =>
      imageField('images', pngImage(30 + index, 20), { filename: `picture-${index}.png` }),
    ),
  ];
}

export const sendForm = (
  app: FastifyInstance,
  csrf: Csrf,
  method: 'POST' | 'PATCH',
  url: string,
  parts: FormPart[],
  actor?: TestUser,
) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method,
    url,
    headers: { ...(actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf)), ...headers },
    payload,
  });
};

// the request of the form of a new product
export const createProductForm = (
  app: FastifyInstance,
  csrf: Csrf,
  actor: TestUser,
  opts: ProductFormOpts,
) => sendForm(app, csrf, 'POST', '/api/products', productFormParts(opts), actor);
