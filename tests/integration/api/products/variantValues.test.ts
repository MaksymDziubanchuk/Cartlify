import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_ATTRIBUTE_MULTI_VALUES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { removeUploads } from '../../../helpers/cloudinary.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeGroup,
  createAttributeOption,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  createVariantValue,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { createProductForm, formVariant } from '../../../helpers/productForm.js';
import {
  auditLinesOf,
  galleryIdsOf,
  markVariantDeleted,
  variantRowsOf,
} from '../../../helpers/variants.js';

// the values of the characteristics a variant has, written by the routes that make and change
// variants: POST /api/products/:productId/variants, PATCH .../variants/:variantId, PATCH
// .../variants, PATCH /api/products/variants/batch and the restore of a variant. What a value may be
// (the type of its characteristic, its bounds, the values of its list), the characteristics a
// category requires, and the rule that no two variants of a product repeat each other

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, root.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

type Method = 'POST' | 'PATCH' | 'DELETE' | 'GET';

const send = (method: Method, url: string, payload?: unknown, actor: TestUser = admin) =>
  app.inject({
    method,
    url,
    headers:
      method === 'GET' ? { cookie: accessCookie(actor) } : withCsrf(csrf, accessCookie(actor)),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

type Body = Record<string, unknown>;

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

type Value = { attributeId: number; value: unknown };

// a variant that is right for the route that adds variants: the price, the weight, the sizes and the
// first picture of the gallery of the product
const variantBody = (imageId: number, attributes?: Value[], over: Body = {}) => ({
  price: 15,
  weightGrams: 300,
  lengthMm: 100,
  widthMm: 80,
  heightMm: 40,
  images: [{ imageId, position: 1 }],
  ...(attributes ? { attributes } : {}),
  ...over,
});

const add = (productId: number, variants: unknown[], actor: TestUser = admin) =>
  send('POST', `/api/products/${productId}/variants`, { variants }, actor);

const patchOne = (productId: number, variantId: number, body: Body, actor: TestUser = admin) =>
  send('PATCH', `/api/products/${productId}/variants/${variantId}`, body, actor);

const patchMany = (productId: number, body: Body, actor: TestUser = admin) =>
  send('PATCH', `/api/products/${productId}/variants`, body, actor);

const patchBatch = (items: Body[], actor: TestUser = admin) =>
  send('PATCH', '/api/products/variants/batch', { items }, actor);

const imageOf = async (product: TestProduct) => (await galleryIdsOf(product.id))[0]!;

// the values a variant holds, by the characteristic: a text, a number, yes/no, the id of a value of a
// list, the ids of the values of a set
async function valuesOf(variantId: number): Promise<Record<number, unknown>> {
  const rows = await asAdmin((tx) =>
    tx.variantAttributeValue.findMany({
      where: { variantId },
      orderBy: [{ attributeId: 'asc' }, { optionId: 'asc' }],
      select: {
        attributeId: true,
        textValue: true,
        numberValue: true,
        boolValue: true,
        optionId: true,
        attribute: { select: { type: true } },
      },
    }),
  );

  const found: Record<number, unknown> = {};
  for (const row of rows) {
    if (row.attribute.type === 'options') {
      found[row.attributeId] = [
        ...((found[row.attributeId] as number[] | undefined) ?? []),
        row.optionId,
      ];
    } else {
      found[row.attributeId] =
        row.textValue ??
        (row.numberValue === null ? (row.boolValue ?? row.optionId) : Number(row.numberValue));
    }
  }
  return found;
}

const askFor = (categoryId: number, attributeId: number, required = true) =>
  asAdmin((tx) => tx.categoryAttribute.create({ data: { categoryId, attributeId, required } }));

describe('the values of a new variant', () => {
  it('writes a value of each type, answers with them in the order of the card, and logs them', async () => {
    const first = await createAttributeGroup({ name: `Main group ${uniqueTag()}` });
    const second = await createAttributeGroup({ name: `Extra group ${uniqueTag()}` });
    const colour = await createAttribute({
      type: 'option',
      isMain: true,
      groupId: first.id,
      name: `Colour ${uniqueTag()}`,
    });
    const black = await createAttributeOption(colour.id, { name: 'black', colorCode: '#000000' });
    const memory = await createAttribute({
      type: 'number',
      unit: 'GB',
      groupId: first.id,
      name: `Memory ${uniqueTag()}`,
    });
    const waterproof = await createAttribute({
      type: 'boolean',
      groupId: second.id,
      name: `Waterproof ${uniqueTag()}`,
    });
    const features = await createAttribute({
      type: 'options',
      groupId: second.id,
      name: `Features ${uniqueTag()}`,
    });
    const nfc = await createAttributeOption(features.id, { name: 'NFC' });
    const gps = await createAttributeOption(features.id, { name: 'GPS' });
    const finish = await createAttribute({
      type: 'text',
      groupId: second.id,
      name: `Finish ${uniqueTag()}`,
    });

    const product = await newProduct({ name: 'Value lamp' });
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: finish.id, value: '  Matte ' },
        { attributeId: features.id, value: [gps.id, nfc.id] },
        { attributeId: waterproof.id, value: true },
        { attributeId: memory.id, value: 256 },
        { attributeId: colour.id, value: black.id },
      ]),
    ]);

    expect(res.statusCode).toBe(201);
    const made = res.json().variants[0];
    // the groups by their place, in a group the characteristics by theirs
    expect(made.attributes).toEqual([
      {
        group: { id: first.id, name: first.name, position: first.position },
        items: [
          {
            attribute: {
              id: colour.id,
              name: colour.name,
              unit: null,
              type: 'option',
              isMain: true,
            },
            value: 'black',
            raw: black.id,
            colorCode: '#000000',
          },
          {
            attribute: {
              id: memory.id,
              name: memory.name,
              unit: 'GB',
              type: 'number',
              isMain: false,
            },
            value: '256 GB',
            raw: 256,
          },
        ],
      },
      {
        group: { id: second.id, name: second.name, position: second.position },
        items: [
          {
            attribute: {
              id: waterproof.id,
              name: waterproof.name,
              unit: null,
              type: 'boolean',
              isMain: false,
            },
            value: 'yes',
            raw: true,
          },
          {
            attribute: {
              id: features.id,
              name: features.name,
              unit: null,
              type: 'options',
              isMain: false,
            },
            value: 'NFC, GPS',
            raw: [nfc.id, gps.id],
          },
          {
            attribute: {
              id: finish.id,
              name: finish.name,
              unit: null,
              type: 'text',
              isMain: false,
            },
            value: 'Matte',
            raw: 'Matte',
          },
        ],
      },
    ]);
    // the first variant of the product has none of them, so all five tell the two apart: the main
    // one first, then by the groups and the places
    expect(made.name).toBe(`Value lamp — black, 256 GB, ${waterproof.name}: yes, NFC, GPS, Matte`);
    expect(made.values).toEqual([
      { attributeId: colour.id, name: colour.name, value: 'black' },
      { attributeId: memory.id, name: memory.name, value: '256 GB' },
      { attributeId: waterproof.id, name: waterproof.name, value: 'yes' },
      { attributeId: features.id, name: features.name, value: 'NFC, GPS' },
      { attributeId: finish.id, name: finish.name, value: 'Matte' },
    ]);

    expect(await valuesOf(made.id)).toEqual({
      [colour.id]: black.id,
      [memory.id]: 256,
      [waterproof.id]: true,
      [features.id]: [nfc.id, gps.id].sort((a, b) => a - b),
      [finish.id]: 'Matte',
    });
    const [line] = await auditLinesOf('variant', made.id, ['variant.create']);
    expect(line!.meta).toEqual(
      expect.arrayContaining([
        { field: `attribute.${finish.id}`, old: null, new: 'Matte' },
        { field: `attribute.${memory.id}`, old: null, new: 256 },
        {
          field: `attribute.${features.id}`,
          old: null,
          new: [nfc.id, gps.id].sort((a, b) => a - b),
        },
      ]),
    );
  });

  it('takes a null and an empty set as no value, and a variant with no value of a characteristic is unlike one that has it', async () => {
    const note = await createAttribute({ type: 'text' });
    const set = await createAttribute({ type: 'options' });
    const product = await newProduct();
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: note.id, value: null },
        { attributeId: set.id, value: [] },
        { attributeId: (await createAttribute({ type: 'text' })).id, value: 'only this' },
      ]),
    ]);

    expect(res.statusCode).toBe(201);
    expect(Object.keys(await valuesOf(res.json().variants[0].id))).toHaveLength(1);
  });

  it('names the characteristic and the variant of a value of the wrong kind or out of bounds, and writes nothing', async () => {
    const text = await createAttribute({ type: 'text' });
    const number = await createAttribute({
      type: 'number',
      decimals: 1,
      minValue: 1,
      maxValue: 100,
    });
    const flag = await createAttribute({ type: 'boolean' });
    const choice = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const foreign = await createAttributeOption(other.id);
    const product = await newProduct();
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [{ attributeId: text.id, value: 'fine' }]),
      variantBody(image, [{ attributeId: text.id, value: 12 }]),
      variantBody(image, [{ attributeId: number.id, value: 12.55 }]),
      variantBody(image, [{ attributeId: number.id, value: 0.5 }]),
      variantBody(image, [{ attributeId: number.id, value: 100.5 }]),
      variantBody(image, [{ attributeId: flag.id, value: 'yes' }]),
      variantBody(image, [{ attributeId: choice.id, value: foreign.id }]),
    ]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(res.json().details.variants).toEqual([
      {
        index: 1,
        errorCode: 'ATTRIBUTE_VALUE_INVALID',
        details: { attributeId: text.id, attributeName: expect.any(String), type: 'text' },
      },
      {
        index: 2,
        errorCode: 'ATTRIBUTE_VALUE_TOO_PRECISE',
        details: {
          attributeId: number.id,
          attributeName: expect.any(String),
          bound: 1,
          value: 12.55,
        },
      },
      {
        index: 3,
        errorCode: 'ATTRIBUTE_VALUE_TOO_SMALL',
        details: {
          attributeId: number.id,
          attributeName: expect.any(String),
          bound: 1,
          value: 0.5,
        },
      },
      {
        index: 4,
        errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE',
        details: {
          attributeId: number.id,
          attributeName: expect.any(String),
          bound: 100,
          value: 100.5,
        },
      },
      {
        index: 5,
        errorCode: 'ATTRIBUTE_VALUE_INVALID',
        details: { attributeId: flag.id, attributeName: expect.any(String), type: 'boolean' },
      },
      {
        index: 6,
        errorCode: 'ATTRIBUTE_OPTION_NOT_FOUND',
        details: {
          attributeId: choice.id,
          attributeName: expect.any(String),
          optionIds: [foreign.id],
        },
      },
    ]);
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('refuses a value of a set twice and too many values of a set', async () => {
    const set = await createAttribute({ type: 'options' });
    const one = await createAttributeOption(set.id);
    const product = await newProduct();
    const image = await imageOf(product);
    const many = Array.from({ length: MAX_ATTRIBUTE_MULTI_VALUES + 1 }, (_, i) => 1_000_000 + i);

    const res = await add(product.id, [
      variantBody(image, [{ attributeId: set.id, value: [one.id, one.id] }]),
      variantBody(image, [{ attributeId: set.id, value: many }]),
    ]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(res.json().details.variants).toEqual([
      {
        index: 0,
        errorCode: 'ATTRIBUTE_VALUES_REPEATED',
        details: { attributeId: set.id, attributeName: expect.any(String), optionIds: [one.id] },
      },
      {
        index: 1,
        errorCode: 'ATTRIBUTE_VALUES_TOO_MANY',
        details: {
          attributeId: set.id,
          attributeName: expect.any(String),
          max: MAX_ATTRIBUTE_MULTI_VALUES,
          have: many.length,
        },
      },
    ]);
  });

  it('refuses a characteristic named twice for a variant and a list that is wrong in its shape', async () => {
    const text = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const image = await imageOf(product);

    const twice = await add(product.id, [
      variantBody(image, [
        { attributeId: text.id, value: 'a' },
        { attributeId: text.id, value: 'b' },
      ]),
    ]);
    const noValue = await send('POST', `/api/products/${product.id}/variants`, {
      variants: [variantBody(image, [{ attributeId: text.id } as never])],
    });

    expect(errorOf(twice)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(twice.json().details.variants).toEqual([
      { index: 0, errorCode: 'VARIANT_ATTRIBUTES_REPEATED', details: { attributeIds: [text.id] } },
    ]);
    expect(errorOf(noValue)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('answers 404 for a characteristic that is not in the directory, naming every one', async () => {
    const product = await newProduct();
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: 2_000_000_001, value: 'a' },
        { attributeId: 2_000_000_002, value: 'b' },
      ]),
    ]);

    expect(errorOf(res)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(res.json().details).toEqual({ attributeIds: [2_000_000_001, 2_000_000_002] });
  });

  it('is for an admin and a root; a user gets 403', async () => {
    const text = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const image = await imageOf(product);

    const forbidden = await add(
      product.id,
      [variantBody(image, [{ attributeId: text.id, value: 'a' }])],
      buyer,
    );
    const byRoot = await add(
      product.id,
      [variantBody(image, [{ attributeId: text.id, value: 'a' }])],
      root,
    );

    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(byRoot.statusCode).toBe(201);
  });
});

describe('the characteristics a category requires', () => {
  it('must have a value in a new variant: the answer lists what is missing and which variants', async () => {
    const colour = await createAttribute({ type: 'text', name: `Needed ${uniqueTag()}` });
    const size = await createAttribute({ type: 'text', name: `Also needed ${uniqueTag()}` });
    const product = await newProduct();
    await askFor(product.categoryId, colour.id);
    await askFor(product.categoryId, size.id);
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: colour.id, value: 'black' },
        { attributeId: size.id, value: 'M' },
      ]),
      variantBody(image, [{ attributeId: colour.id, value: 'white' }]),
      variantBody(image),
    ]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(res.json().details).toEqual({
      attributes: [
        { id: colour.id, name: colour.name },
        { id: size.id, name: size.name },
      ].sort((a, b) => a.id - b.id),
      variants: [
        { index: 1, attributeIds: [size.id] },
        { index: 2, attributeIds: [colour.id, size.id].sort((a, b) => a - b) },
      ],
    });
    // nothing was made
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('lets a variant that has them through, and a characteristic the category does not ask for is allowed too', async () => {
    const needed = await createAttribute({ type: 'text' });
    const extra = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await askFor(product.categoryId, needed.id);
    await askFor(product.categoryId, extra.id, false);
    const image = await imageOf(product);
    const unasked = await createAttribute({ type: 'text' });

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: needed.id, value: 'a' },
        { attributeId: unasked.id, value: 'free' },
      ]),
    ]);

    expect(res.statusCode).toBe(201);
  });

  it('are the ones of the parent categories too, the child deciding', async () => {
    const inherited = await createAttribute({ type: 'text' });
    const relaxed = await createAttribute({ type: 'text' });
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    await askFor(parent.id, inherited.id);
    await askFor(parent.id, relaxed.id);
    // the child takes its own setting of a characteristic over the parent's
    await askFor(child.id, relaxed.id, false);
    const product = await newProduct({ categoryId: child.id });
    const image = await imageOf(product);

    const refused = await add(product.id, [variantBody(image)]);
    const accepted = await add(product.id, [
      variantBody(image, [{ attributeId: inherited.id, value: 'a' }]),
    ]);

    expect(errorOf(refused)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(refused.json().details.attributes).toEqual([
      { id: inherited.id, name: expect.any(String) },
    ]);
    expect(accepted.statusCode).toBe(201);
  });

  it('are asked of a variant when its values change, never of the old variants for a requirement added later', async () => {
    const colour = await createAttribute({ type: 'text' });
    const note = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });
    // the category asks for the note only now: the two variants have none
    await askFor(product.categoryId, note.id);

    const weight = await patchOne(product.id, product.variantId, { weightGrams: 400 });
    const sameValue = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: colour.id, value: 'black' }],
    });
    const changed = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: colour.id, value: 'grey' }],
    });
    const given = await patchOne(product.id, product.variantId, {
      attributes: [
        { attributeId: colour.id, value: 'grey' },
        { attributeId: note.id, value: 'ok' },
      ],
    });

    // a change that is no change of values is no business of the requirement
    expect(weight.statusCode).toBe(200);
    expect(sameValue.statusCode).toBe(200);
    expect(errorOf(changed)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(changed.json().details).toEqual({
      attributes: [{ id: note.id, name: expect.any(String) }],
      variants: [{ variantId: product.variantId, attributeIds: [note.id] }],
    });
    expect(given.statusCode).toBe(200);
  });

  it('are not asked again when the product moves to another category', async () => {
    const needed = await createAttribute({ type: 'text' });
    const target = await createCategory();
    await askFor(target.id, needed.id);
    const product = await newProduct();

    const res = await send('PATCH', `/api/products/${product.id}/category`, {
      categoryId: target.id,
    });

    expect(res.statusCode).toBe(200);
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('stop a value from being taken away', async () => {
    const needed = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, needed.id, { text: 'a' });
    await askFor(product.categoryId, needed.id);

    const res = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: needed.id, value: null }],
    });

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(await valuesOf(product.variantId)).toEqual({ [needed.id]: 'a' });
  });
});

describe('a variant that repeats another', () => {
  it('is refused when it has the values of a variant the product has, which the answer names', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [{ attributeId: colour.id, value: 'black' }]),
    ]);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details).toEqual({
      variants: [{ index: 0, sameAs: [{ variantId: product.variantId }] }],
    });
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('is refused when two variants of the request are alike, naming each of them', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const image = await imageOf(product);
    const same = [{ attributeId: colour.id, value: 'red' }];

    const res = await add(product.id, [
      variantBody(image, same),
      variantBody(image, [{ attributeId: colour.id, value: 'blue' }]),
      variantBody(image, same),
    ]);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { index: 0, sameAs: [{ index: 2 }] },
      { index: 2, sameAs: [{ index: 0 }] },
    ]);
  });

  it('counts a variant with no values as the same as another with none', async () => {
    const product = await newProduct();
    const image = await imageOf(product);

    const res = await add(product.id, [variantBody(image)]);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { index: 0, sameAs: [{ variantId: product.variantId }] },
    ]);
  });

  it('is the same only when all the values are the same: one that differs in any makes another variant', async () => {
    const colour = await createAttribute({ type: 'text' });
    const memory = await createAttribute({ type: 'number' });
    const product = await newProduct();
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(product.variantId, memory.id, { number: 128 });
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [
        { attributeId: colour.id, value: 'black' },
        { attributeId: memory.id, value: 256 },
      ]),
      variantBody(image, [
        { attributeId: colour.id, value: 'white' },
        { attributeId: memory.id, value: 128 },
      ]),
      // a characteristic the others lack
      variantBody(image, [
        { attributeId: colour.id, value: 'black' },
        { attributeId: memory.id, value: 128 },
        { attributeId: (await createAttribute({ type: 'boolean' })).id, value: true },
      ]),
    ]);

    expect(res.statusCode).toBe(201);
    expect(res.json().variants).toHaveLength(3);
  });

  it('compares the values of a set whatever the order they are given in', async () => {
    const set = await createAttribute({ type: 'options' });
    const a = await createAttributeOption(set.id);
    const b = await createAttributeOption(set.id);
    const product = await newProduct();
    await createVariantValue(product.variantId, set.id, { optionId: a.id });
    await createVariantValue(product.variantId, set.id, { optionId: b.id });
    const image = await imageOf(product);

    const same = await add(product.id, [
      variantBody(image, [{ attributeId: set.id, value: [b.id, a.id] }]),
    ]);
    const different = await add(product.id, [
      variantBody(image, [{ attributeId: set.id, value: [a.id] }]),
    ]);

    expect(errorOf(same)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(different.statusCode).toBe(201);
  });

  it('does not count a variant that is taken out of sale', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await markVariantDeleted(product.variantId);
    const image = await imageOf(product);

    const res = await add(product.id, [
      variantBody(image, [{ attributeId: colour.id, value: 'black' }]),
    ]);

    expect(res.statusCode).toBe(201);
  });

  it('is refused when a change makes a variant like another, naming it', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const res = await patchOne(product.id, second.id, {
      attributes: [{ attributeId: colour.id, value: 'black' }],
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details).toEqual({
      variantId: product.variantId,
      variants: [{ variantId: second.id, sameAs: [{ variantId: product.variantId }] }],
    });
    expect(await valuesOf(second.id)).toEqual({ [colour.id]: 'white' });
  });

  it('is refused when a value taken away leaves two variants without values', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const res = await patchOne(product.id, second.id, {
      attributes: [{ attributeId: colour.id, value: null }],
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variantId).toBe(product.variantId);
  });

  it('is refused when a variant is put back with the values of a live one', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'black' });
    await markVariantDeleted(second.id);

    const res = await send('POST', `/api/products/${product.id}/variants/${second.id}/restore`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variantId).toBe(product.variantId);
    const rows = await variantRowsOf(product.id);
    expect(rows.find((row) => row.id === second.id)!.deletedAt).not.toBeNull();
  });

  it('puts a variant back that differs from the live ones', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });
    await markVariantDeleted(second.id);

    const res = await send('POST', `/api/products/${product.id}/variants/${second.id}/restore`);

    expect(res.statusCode).toBe(200);
  });

  it('gives one 201 and one 409 to two requests that make the same variant at once', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    const image = await imageOf(product);
    const body = () => [variantBody(image, [{ attributeId: colour.id, value: 'red' }])];

    const [one, two] = await Promise.all([add(product.id, body()), add(product.id, body())]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    const refused = one.statusCode === 409 ? one : two;
    expect(refused.json().errorCode).toBe('VARIANT_DUPLICATE');
    expect(await variantRowsOf(product.id)).toHaveLength(2);
  });

  it('gives one 200 and one 409 to two changes that would make two variants alike', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'a' });
    await createVariantValue(second.id, colour.id, { text: 'b' });
    const set = (value: string) => [{ attributeId: colour.id, value }];

    // each gives its own variant a value that neither has: the second to come finds the first one
    const [one, two] = await Promise.all([
      patchOne(product.id, product.variantId, { attributes: set('c') }),
      patchOne(product.id, second.id, { attributes: set('c') }),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    const values = [await valuesOf(product.variantId), await valuesOf(second.id)];
    expect(values[0]![colour.id]).not.toBe(values[1]![colour.id]);
  });
});

describe('PATCH .../variants/:variantId and the values', () => {
  it('changes the values named, keeps the others, and takes a value away with null', async () => {
    const colour = await createAttribute({ type: 'text' });
    const memory = await createAttribute({ type: 'number', unit: 'GB' });
    const set = await createAttribute({ type: 'options' });
    const a = await createAttributeOption(set.id);
    const b = await createAttributeOption(set.id);
    const product = await newProduct();
    const other = await createVariant(product.id);
    await createVariantValue(other.id, colour.id, { text: 'zzz' });
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(product.variantId, memory.id, { number: 128 });
    await createVariantValue(product.variantId, set.id, { optionId: a.id });

    const res = await patchOne(product.id, product.variantId, {
      attributes: [
        { attributeId: memory.id, value: 256 },
        { attributeId: set.id, value: [b.id] },
        { attributeId: colour.id, value: null },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(await valuesOf(product.variantId)).toEqual({ [memory.id]: 256, [set.id]: [b.id] });
    const [line] = await auditLinesOf('variant', product.variantId, ['variant.update']);
    expect(line!.meta).toEqual(
      expect.arrayContaining([
        { field: `attribute.${memory.id}`, old: 128, new: 256 },
        { field: `attribute.${set.id}`, old: [a.id], new: [b.id] },
        { field: `attribute.${colour.id}`, old: 'black', new: null },
      ]),
    );
    expect(
      res.json().variant.attributes.flatMap((group: { items: unknown[] }) => group.items),
    ).toHaveLength(2);
  });

  it('changes nothing and writes no line for the same values', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, colour.id, { text: 'black' });

    const res = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: colour.id, value: ' black ' }],
    });

    expect(res.statusCode).toBe(200);
    expect(await auditLinesOf('variant', product.variantId, ['variant.update'])).toEqual([]);
  });

  it('takes a request that names values only, and refuses an empty list as nothing to change', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();

    const empty = await patchOne(product.id, product.variantId, { attributes: [] });
    const given = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: colour.id, value: 'black' }],
    });

    expect(errorOf(empty)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
    expect(given.statusCode).toBe(200);
  });

  it('writes the values together with the other fields, all or nothing', async () => {
    const colour = await createAttribute({ type: 'number', decimals: 0, minValue: 1, maxValue: 5 });
    const product = await newProduct();

    const refused = await patchOne(product.id, product.variantId, {
      price: 99,
      attributes: [{ attributeId: colour.id, value: 9 }],
    });

    expect(errorOf(refused)).toEqual({ status: 400, code: 'ATTRIBUTE_VALUE_TOO_LARGE' });
    expect(refused.json().details).toEqual({
      variantId: product.variantId,
      attributeId: colour.id,
      attributeName: expect.any(String),
      bound: 5,
      value: 9,
    });
    expect(Number((await variantRowsOf(product.id))[0]!.price)).toBe(10);
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const product = await newProduct();

    const missing = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: 2_000_000_000, value: 'a' }],
    });
    const forbidden = await patchOne(
      product.id,
      product.variantId,
      { attributes: [{ attributeId: 2_000_000_000, value: 'a' }] },
      buyer,
    );

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH .../variants and the values for many variants', () => {
  it('sets the same value in the variants named, each checked on its own', async () => {
    const memory = await createAttribute({ type: 'number', decimals: 0 });
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const res = await patchMany(product.id, {
      variantIds: [product.variantId, second.id],
      attributes: [{ attributeId: memory.id, value: 128 }],
    });

    expect(res.statusCode).toBe(200);
    expect(await valuesOf(product.variantId)).toEqual({ [colour.id]: 'black', [memory.id]: 128 });
    expect(await valuesOf(second.id)).toEqual({ [colour.id]: 'white', [memory.id]: 128 });
    const [line] = await auditLinesOf('variant', second.id, ['variant.update_batch']);
    expect(line!.meta).toEqual([{ field: `attribute.${memory.id}`, old: null, new: 128 }]);
  });

  it('lists every variant with the same error at once, and writes nothing', async () => {
    const memory = await createAttribute({ type: 'number', decimals: 0, maxValue: 10 });
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const res = await patchMany(product.id, {
      attributes: [{ attributeId: memory.id, value: 11 }],
    });

    expect(errorOf(res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(res.json().details.variants).toEqual([
      expect.objectContaining({
        variantId: product.variantId,
        errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE',
      }),
      expect.objectContaining({ variantId: second.id, errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE' }),
    ]);
    expect(await valuesOf(product.variantId)).toEqual({ [colour.id]: 'black' });
  });

  it('is refused when the same value would leave the variants alike, naming them', async () => {
    const colour = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const res = await patchMany(product.id, {
      attributes: [{ attributeId: colour.id, value: 'grey' }],
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { variantId: product.variantId, sameAs: [{ variantId: second.id }] },
      { variantId: second.id, sameAs: [{ variantId: product.variantId }] },
    ]);
    expect(await valuesOf(product.variantId)).toEqual({ [colour.id]: 'black' });
  });

  it('asks the required characteristics of every variant it changed', async () => {
    const needed = await createAttribute({ type: 'text' });
    const other = await createAttribute({ type: 'text' });
    const product = await newProduct();
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, needed.id, { text: 'a' });
    await createVariantValue(second.id, needed.id, { text: 'b' });
    await askFor(product.categoryId, needed.id);

    const res = await patchMany(product.id, {
      attributes: [
        { attributeId: needed.id, value: null },
        { attributeId: other.id, value: 'x' },
      ],
    });

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(res.json().details.variants).toEqual([
      { variantId: product.variantId, attributeIds: [needed.id] },
      { variantId: second.id, attributeIds: [needed.id] },
    ]);
  });
});

describe('PATCH /api/products/variants/batch and the values', () => {
  it('gives each variant the values of its own, of any products, all or nothing', async () => {
    const colour = await createAttribute({ type: 'text' });
    const one = await newProduct();
    const two = await newProduct();
    const oneSecond = await createVariant(one.id);

    const res = await patchBatch([
      { variantId: one.variantId, attributes: [{ attributeId: colour.id, value: 'a' }] },
      { variantId: oneSecond.id, attributes: [{ attributeId: colour.id, value: 'b' }] },
      { variantId: two.variantId, attributes: [{ attributeId: colour.id, value: 'a' }] },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { variant: { id: number } }) => item.variant.id)).toEqual([
      one.variantId,
      oneSecond.id,
      two.variantId,
    ]);
    expect(await valuesOf(one.variantId)).toEqual({ [colour.id]: 'a' });
    expect(await valuesOf(oneSecond.id)).toEqual({ [colour.id]: 'b' });
    expect(await valuesOf(two.variantId)).toEqual({ [colour.id]: 'a' });
    const [line] = await auditLinesOf('variant', one.variantId, ['variant.update_batch']);
    expect(line!.meta).toEqual([{ field: `attribute.${colour.id}`, old: null, new: 'a' }]);
  });

  it('is refused for a variant that would repeat another of its product, and nothing is written', async () => {
    const colour = await createAttribute({ type: 'text' });
    const one = await newProduct();
    const two = await newProduct();
    const oneSecond = await createVariant(one.id);
    await createVariantValue(one.variantId, colour.id, { text: 'a' });

    const res = await patchBatch([
      { variantId: two.variantId, attributes: [{ attributeId: colour.id, value: 'fine' }] },
      { variantId: oneSecond.id, attributes: [{ attributeId: colour.id, value: 'a' }] },
    ]);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { variantId: oneSecond.id, sameAs: [{ variantId: one.variantId }] },
    ]);
    expect(await valuesOf(two.variantId)).toEqual({});
  });

  it('names every variant whose value is wrong', async () => {
    const memory = await createAttribute({ type: 'number', decimals: 0, minValue: 1 });
    const one = await newProduct();
    const two = await newProduct();

    const res = await patchBatch([
      { variantId: one.variantId, attributes: [{ attributeId: memory.id, value: 0 }] },
      { variantId: two.variantId, attributes: [{ attributeId: memory.id, value: 'many' }] },
    ]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(res.json().details.variants).toEqual([
      expect.objectContaining({ variantId: one.variantId, errorCode: 'ATTRIBUTE_VALUE_TOO_SMALL' }),
      expect.objectContaining({ variantId: two.variantId, errorCode: 'ATTRIBUTE_VALUE_INVALID' }),
    ]);
  });
});

describe('POST /api/products and the values of its variants', () => {
  const formCategories: number[] = [];

  afterAll(async () => {
    await removeUploads();
    await asAdmin(async (tx) => {
      await tx.product.deleteMany({ where: { categoryId: { in: formCategories } } });
      await tx.category.deleteMany({ where: { id: { in: formCategories } } });
    });
  });

  const form = async (variants: unknown[], over: { categoryId?: number; files?: number } = {}) => {
    const categoryId = over.categoryId ?? (await createCategory()).id;
    formCategories.push(categoryId);

    return {
      categoryId,
      res: await createProductForm(app, csrf, admin, {
        categoryId,
        name: `Form values ${uniqueTag()}`,
        variants,
        ...(over.files ? { files: over.files } : {}),
      }),
    };
  };

  const countIn = (categoryId: number) =>
    asAdmin((tx) => tx.product.count({ where: { categoryId } }));

  it('writes the values of each variant and names the variants by what tells them apart', async () => {
    const colour = await createAttribute({ type: 'option', isMain: true });
    const black = await createAttributeOption(colour.id, { name: 'black' });
    const white = await createAttributeOption(colour.id, { name: 'white' });
    const note = await createAttribute({ type: 'text' });

    const { res } = await form(
      [
        formVariant({
          attributes: [
            { attributeId: colour.id, value: black.id },
            { attributeId: note.id, value: 'same' },
          ],
        }),
        formVariant({
          attributes: [
            { attributeId: colour.id, value: white.id },
            { attributeId: note.id, value: 'same' },
          ],
        }),
      ],
      { files: 1 },
    );

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.variants.map((variant: { name: string }) => variant.name)).toEqual([
      `${body.product.name} \u2014 black`,
      `${body.product.name} \u2014 white`,
    ]);
    expect(body.variants[0].values).toEqual([
      { attributeId: colour.id, name: colour.name, value: 'black' },
    ]);
    // the opened variant comes in full, with every characteristic it has (the shared note too)
    expect(
      body.variant.attributes.flatMap((group: { items: unknown[] }) => group.items),
    ).toHaveLength(2);
    expect(await valuesOf(body.variant.id)).toEqual({ [colour.id]: black.id, [note.id]: 'same' });
    const [line] = await auditLinesOf('variant', body.variant.id, ['variant.create']);
    expect(line!.meta).toEqual(
      expect.arrayContaining([{ field: `attribute.${note.id}`, old: null, new: 'same' }]),
    );
  });

  it('refuses two variants with the same values, naming both, and makes nothing', async () => {
    const note = await createAttribute({ type: 'text' });
    const same = [{ attributeId: note.id, value: 'same' }];

    const { res, categoryId } = await form([
      formVariant({ attributes: same }),
      formVariant({ attributes: same }),
    ]);

    expect(errorOf(res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(res.json().details.variants).toEqual([
      { index: 0, sameAs: [{ index: 1 }] },
      { index: 1, sameAs: [{ index: 0 }] },
    ]);
    expect(await countIn(categoryId)).toBe(0);
  });

  it('refuses two variants with no values, and takes one variant with none', async () => {
    const two = await form([formVariant({}), formVariant({})]);
    const one = await form([formVariant({})]);

    expect(errorOf(two.res)).toEqual({ status: 409, code: 'VARIANT_DUPLICATE' });
    expect(one.res.statusCode).toBe(201);
  });

  it('asks the required characteristics of the category of every variant', async () => {
    const needed = await createAttribute({ type: 'text' });
    const category = await createCategory();
    await askFor(category.id, needed.id);

    const { res, categoryId } = await form(
      [formVariant({ attributes: [{ attributeId: needed.id, value: 'a' }] }), formVariant({})],
      { categoryId: category.id },
    );

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(res.json().details).toEqual({
      attributes: [{ id: needed.id, name: needed.name }],
      variants: [{ index: 1, attributeIds: [needed.id] }],
    });
    expect(await countIn(categoryId)).toBe(0);
  });

  it('names a variant whose values are wrong, one with a list of the wrong shape, and a characteristic that is not there', async () => {
    const number = await createAttribute({ type: 'number', decimals: 0, maxValue: 5 });

    const wrong = await form([
      formVariant({ attributes: [{ attributeId: number.id, value: 6 }] }),
      formVariant({ attributes: [{ attributeId: number.id, value: 3 }] }),
    ]);
    const shape = await form([formVariant({ attributes: 'not a list' })]);
    const missing = await form([
      formVariant({ attributes: [{ attributeId: 2_000_000_000, value: 'a' }] }),
    ]);

    expect(errorOf(wrong.res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(wrong.res.json().details.variants).toEqual([
      {
        index: 0,
        errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE',
        details: { attributeId: number.id, attributeName: number.name, bound: 5, value: 6 },
      },
    ]);
    expect(errorOf(shape.res)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(shape.res.json().details.variants).toEqual([
      { index: 0, errorCode: 'VARIANT_ATTRIBUTES_INVALID', details: { max: 200 } },
    ]);
    expect(errorOf(missing.res)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(missing.res.json().details).toEqual({ attributeIds: [2_000_000_000] });
    for (const { categoryId } of [wrong, shape, missing]) expect(await countIn(categoryId)).toBe(0);
  });
});

describe('the refusals of the routes of many variants', () => {
  it('answer 404 for a characteristic that is not there, for every route that takes values', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);
    const missing = [{ attributeId: 2_000_000_000, value: 'a' }];

    const many = await patchMany(product.id, { attributes: missing });
    const batch = await patchBatch([{ variantId: second.id, attributes: missing }]);

    for (const res of [many, batch]) {
      expect(errorOf(res)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
      expect(res.json().details).toEqual({ attributeIds: [2_000_000_000] });
    }
  });

  it('refuse a characteristic named twice for a variant, and a value of a list of another characteristic', async () => {
    const text = await createAttribute({ type: 'text' });
    const choice = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const foreign = await createAttributeOption(other.id);
    const product = await newProduct();

    const twice = await patchMany(product.id, {
      attributes: [
        { attributeId: text.id, value: 'a' },
        { attributeId: text.id, value: 'b' },
      ],
    });
    const wrongList = await patchOne(product.id, product.variantId, {
      attributes: [{ attributeId: choice.id, value: foreign.id }],
    });
    const inBatch = await patchBatch([
      {
        variantId: product.variantId,
        attributes: [
          { attributeId: text.id, value: 'a' },
          { attributeId: text.id, value: 'b' },
        ],
      },
    ]);

    expect(errorOf(twice)).toEqual({ status: 400, code: 'VARIANT_ATTRIBUTES_REPEATED' });
    expect(twice.json().details).toEqual({ attributeIds: [text.id] });
    expect(errorOf(wrongList)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    expect(wrongList.json().details).toEqual({
      variantId: product.variantId,
      attributeId: choice.id,
      attributeName: choice.name,
      optionIds: [foreign.id],
    });
    expect(errorOf(inBatch)).toEqual({ status: 400, code: 'VARIANTS_INVALID' });
    expect(inBatch.json().details.variants).toEqual([
      expect.objectContaining({
        variantId: product.variantId,
        errorCode: 'VARIANT_ATTRIBUTES_REPEATED',
      }),
    ]);
  });

  it('ask the required characteristics of every variant a batch changed', async () => {
    const needed = await createAttribute({ type: 'text' });
    const other = await createAttribute({ type: 'text' });
    const one = await newProduct();
    const two = await newProduct();
    await createVariantValue(one.variantId, needed.id, { text: 'a' });
    await askFor(one.categoryId, needed.id);

    const res = await patchBatch([
      { variantId: one.variantId, attributes: [{ attributeId: needed.id, value: null }] },
      { variantId: two.variantId, attributes: [{ attributeId: other.id, value: 'x' }] },
    ]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_REQUIRED' });
    expect(res.json().details.variants).toEqual([
      { variantId: one.variantId, attributeIds: [needed.id] },
    ]);
    expect(await valuesOf(two.variantId)).toEqual({});
  });

  it('take a value of a set to another in one request, and a text with spaces trimmed', async () => {
    const set = await createAttribute({ type: 'options' });
    const a = await createAttributeOption(set.id);
    const b = await createAttributeOption(set.id);
    const note = await createAttribute({ type: 'text' });
    const product = await newProduct();
    await createVariantValue(product.variantId, set.id, { optionId: a.id });

    const res = await patchOne(product.id, product.variantId, {
      attributes: [
        { attributeId: set.id, value: [b.id, a.id] },
        { attributeId: note.id, value: '  spaced  ' },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(await valuesOf(product.variantId)).toEqual({
      [set.id]: [a.id, b.id].sort((x, y) => x - y),
      [note.id]: 'spaced',
    });
    const [line] = await auditLinesOf('variant', product.variantId, ['variant.update']);
    expect(line!.meta).toEqual(
      expect.arrayContaining([
        { field: `attribute.${set.id}`, old: [a.id], new: [a.id, b.id].sort((x, y) => x - y) },
      ]),
    );
  });
});
