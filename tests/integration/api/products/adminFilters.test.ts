import { randomBytes } from 'node:crypto';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_ID } from '@schemas/idPathParam.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { createChoice } from '../../../helpers/characteristics.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createCategory,
  createDocument,
  createParty,
  createProduct,
  createUser,
  createVariant,
  createVariantValue,
  deleteProductFromCatalog,
  putOnSale,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  markVariantDeleted,
  stripVariantImages,
  uniqueBarcode,
} from '../../../helpers/variants.js';

// The filters of the list of an admin that find the gaps of the catalog: the products and variants a
// buyer does not see (hiddenFromBuyers), the variants that lack a value a category requires
// (missingRequired), their weight, sizes, barcode or pictures (withoutWeight, withoutDimensions,
// withoutBarcode, withoutImages), the products with a removed variant (hasDeletedVariants), and the
// products of a manufacturer, of a person responsible in the EU or of a document. Like the other
// flags of an admin they list what their condition says, whatever else the product has (a sale, an
// override), a buyer may not use them (403 FILTER_FORBIDDEN), and they come with the search, the
// sorts, the cursor and the characteristics filter. A test looks at the products of its own category

let app: FastifyInstance;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const list = (query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

type Row = { product: { id: number }; variant: { id: number }; stock: number };

const rowsOf = (res: LightMyRequestResponse) => res.json().items as Row[];
const productIdsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.product.id);
const variantIdsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.variant.id);
const byId = (ids: number[]) => [...ids].sort((a, b) => a - b);

// the variants of a list, whatever order: the lists of these tests are small and the order is not
// what they check
const variantsOf = (res: LightMyRequestResponse) => byId(variantIdsOf(res));
const productsOf = (res: LightMyRequestResponse) => byId(productIdsOf(res));

const SIZES = { length: 100, width: 50, height: 20 };

// a word of random letters: the search forgives a typo, so a word made from a counter would find
// the names and the categories that have the same digits
const word = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');

describe('GET /api/products with hiddenFromBuyers', () => {
  // a variant a buyer sees is alive and shows a picture; a product is seen when it is alive and has one
  async function shelf() {
    const { id: categoryId } = await createCategory();
    const seen = await createProduct({ categoryId });
    const noPicture = await createProduct({ categoryId });
    await stripVariantImages(noPicture.variantId);
    const allRemoved = await createProduct({ categoryId });
    await markVariantDeleted(allRemoved.variantId);
    // one variant is hidden and the other is seen: the product is seen
    const mixed = await createProduct({ categoryId });
    const mixedSeen = await createVariant(mixed.id);
    await stripVariantImages(mixed.variantId);
    const removed = await createProduct({ categoryId });
    await deleteProductFromCatalog(removed.id);

    return { categoryId, seen, noPicture, allRemoved, mixed, mixedSeen, removed };
  }

  it('true lists the products none of whose variants a buyer sees', async () => {
    const { categoryId, noPicture, allRemoved } = await shelf();

    const res = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'true' });

    expect(res.statusCode).toBe(200);
    expect(productsOf(res)).toEqual(byId([noPicture.id, allRemoved.id]));
    expect(res.json().total).toBe(2);
  });

  it('false lists the products a buyer sees', async () => {
    const { categoryId, seen, mixed } = await shelf();

    const res = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'false' });

    expect(res.statusCode).toBe(200);
    expect(productsOf(res)).toEqual(byId([seen.id, mixed.id]));
  });

  it('lists exactly what a buyer is not shown of the products that are in the catalog', async () => {
    const { categoryId } = await shelf();
    const query = { categoryIds: String(categoryId) };

    const hidden = await list({ ...query, hiddenFromBuyers: 'true' });
    const seen = await list({ ...query, hiddenFromBuyers: 'false' });
    const asBuyer = await list(query, buyer);

    expect(productsOf(seen)).toEqual(productsOf(asBuyer));
    expect(productsOf(hidden).filter((id) => productsOf(asBuyer).includes(id))).toEqual([]);
    // every product of the catalog is in one of the two lists
    expect(hidden.json().total + seen.json().total).toBe(4);
  });

  // a removed product is hidden too, and the list of removed products is the flag deleted
  it('holds every removed product with deleted=true, and none with false', async () => {
    const { categoryId, removed } = await shelf();
    const query = { categoryIds: String(categoryId), deleted: 'true' };

    const hidden = await list({ ...query, hiddenFromBuyers: 'true' });
    const seen = await list({ ...query, hiddenFromBuyers: 'false' });

    expect(productsOf(hidden)).toEqual([removed.id]);
    expect(rowsOf(seen)).toEqual([]);
  });

  it('is a flag: a product on sale that is hidden is listed, and the plain list leaves it out', async () => {
    const { id: categoryId } = await createCategory();
    const hidden = await createProduct({ categoryId, price: 10 });
    await putOnSale(hidden.id, 5);
    await stripVariantImages(hidden.variantId);

    const flagged = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'true' });
    const plain = await list({ categoryIds: String(categoryId) });

    expect(productsOf(flagged)).toEqual([hidden.id]);
    expect(productsOf(plain)).toEqual([]);
  });

  it('keeps the rows products: a product none of whose variants is alive is listed with its first variant', async () => {
    const { categoryId, allRemoved } = await shelf();

    const res = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'true' });

    const row = rowsOf(res).find((item) => item.product.id === allRemoved.id);
    expect(row?.variant.id).toBe(allRemoved.variantId);
  });

  it('gives a row for each live variant with group=false, and counts the variants', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId });
    const second = await createVariant(product.id);
    await stripVariantImages(product.variantId);
    await stripVariantImages(second.id);

    const products = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'true' });
    const variants = await list({
      categoryIds: String(categoryId),
      hiddenFromBuyers: 'true',
      group: 'false',
    });

    expect(productsOf(products)).toEqual([product.id]);
    expect(products.json().total).toBe(1);
    expect(variantsOf(variants)).toEqual(byId([product.variantId, second.id]));
    expect(variants.json().total).toBe(2);
  });

  it('comes with the search, a sort and the pages, counting every product it finds', async () => {
    const { id: categoryId } = await createCategory();
    const w = word();
    const hidden: TestProduct[] = [];
    for (let i = 0; i < 3; i++) {
      const product = await createProduct({ categoryId, name: `${w} lamp ${i}`, price: 10 + i });
      await stripVariantImages(product.variantId);
      hidden.push(product);
    }
    const other = await createProduct({ categoryId, name: `${w} lamp seen`, price: 1 });

    const first = await list({
      categoryIds: String(categoryId),
      hiddenFromBuyers: 'true',
      search: w,
      sort: 'createdAt',
      order: 'asc',
      limit: '2',
    });
    const second = await list({
      categoryIds: String(categoryId),
      hiddenFromBuyers: 'true',
      search: w,
      sort: 'createdAt',
      order: 'asc',
      limit: '2',
      cursor: first.json().nextCursor,
    });

    expect(first.json().total).toBe(3);
    expect(productIdsOf(first)).toEqual([hidden[0]!.id, hidden[1]!.id]);
    expect(productIdsOf(second)).toEqual([hidden[2]!.id]);
    expect(second.json().nextCursor).toBeUndefined();
    expect([...productIdsOf(first), ...productIdsOf(second)]).not.toContain(other.id);
  });

  it('comes with a sort of a variant: the rows are groups of the live variants then', async () => {
    const { id: categoryId } = await createCategory();
    const cheap = await createProduct({ categoryId, price: 5 });
    const dear = await createProduct({ categoryId, price: 50 });
    await stripVariantImages(cheap.variantId);
    await stripVariantImages(dear.variantId);

    const res = await list({
      categoryIds: String(categoryId),
      hiddenFromBuyers: 'true',
      sort: 'price',
      order: 'desc',
    });

    expect(variantIdsOf(res)).toEqual([dear.variantId, cheap.variantId]);
  });

  it('refuses a buyer when true, and takes false as what a buyer sees', async () => {
    const { id: categoryId } = await createCategory();
    const seen = await createProduct({ categoryId });

    const refused = await list({ hiddenFromBuyers: 'true' }, buyer);
    const taken = await list({ categoryIds: String(categoryId), hiddenFromBuyers: 'false' }, buyer);

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'hiddenFromBuyers' },
    });
    expect(taken.statusCode).toBe(200);
    expect(productIdsOf(taken)).toEqual([seen.id]);
  });

  it.each(['yes', '2', ''])('refuses hiddenFromBuyers=%j', async (value) => {
    const res = await list({ hiddenFromBuyers: value });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/products with missingRequired', () => {
  // a characteristic the category requires (required) or only offers
  async function requirement(categoryId: number, required = true) {
    const attribute = await createAttribute({ type: 'text' });
    await asAdmin((tx) =>
      tx.categoryAttribute.create({
        data: { categoryId, attributeId: attribute.id, required },
      }),
    );
    return attribute;
  }

  it('lists the variants that lack a value of a characteristic their category requires', async () => {
    const { id: categoryId } = await createCategory();
    const colour = await requirement(categoryId);
    const product = await createProduct({ categoryId });
    const has = product.variantId;
    const lacks = await createVariant(product.id);
    await createVariantValue(has, colour.id, { text: 'red' });
    const other = await createProduct({ categoryId });

    const res = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
    });

    expect(res.statusCode).toBe(200);
    expect(variantsOf(res)).toEqual(byId([lacks.id, other.variantId]));
    expect(res.json().total).toBe(2);
  });

  it('lists nothing of a characteristic the category only offers', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId, false);
    await createProduct({ categoryId });

    const res = await list({ categoryIds: String(categoryId), missingRequired: 'true' });

    expect(rowsOf(res)).toEqual([]);
  });

  it('lists a variant once however many characteristics it lacks', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    await requirement(categoryId);
    const product = await createProduct({ categoryId });

    const res = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
    });

    expect(variantIdsOf(res)).toEqual([product.variantId]);
    expect(res.json().total).toBe(1);
  });

  it('does not count a variant that is taken out of sale, nor a removed product', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const product = await createProduct({ categoryId });
    const gone = await createVariant(product.id);
    await markVariantDeleted(gone.id);
    const removed = await createProduct({ categoryId });
    await deleteProductFromCatalog(removed.id);

    const res = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
    });
    const asRemoved = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
      deleted: 'true',
    });

    expect(variantIdsOf(res)).toEqual([product.variantId]);
    expect(rowsOf(asRemoved)).toEqual([]);
  });

  // the variants of a product with the same main values are one row; the rows are variants
  it('gives groups of the variants that lack it, and every variant with group=false', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const product = await createProduct({ categoryId });
    const second = await createVariant(product.id);

    const grouped = await list({ categoryIds: String(categoryId), missingRequired: 'true' });
    const apart = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
    });

    expect(grouped.json().total).toBe(1);
    expect(rowsOf(grouped)[0]!.stock).toBe(10);
    expect(variantsOf(apart)).toEqual(byId([product.variantId, second.id]));
  });

  // the set of a category is the one the route of the set reports: its own and its parents', the
  // nearest category winning for a characteristic
  it('asks what the route of the set of the category says it requires, the parents included', async () => {
    const root = await createCategory();
    const child = await createCategory({ parentId: root.id });
    const grandchild = await createCategory({ parentId: child.id });
    const sibling = await createCategory({ parentId: root.id });

    const colour = await createAttribute({ type: 'text' });
    const size = await createAttribute({ type: 'text' });
    const set = async (categoryId: number, attributeId: number, required: boolean) => {
      await asAdmin((tx) =>
        tx.categoryAttribute.create({ data: { categoryId, attributeId, required } }),
      );
    };
    await set(root.id, colour.id, true);
    await set(root.id, size.id, true);
    await set(child.id, size.id, false);
    await set(grandchild.id, size.id, true);

    const tree = [root, child, grandchild, sibling];
    const products = new Map<number, TestProduct>();
    for (const category of tree) {
      products.set(category.id, await createProduct({ categoryId: category.id }));
    }

    // a variant with the colour only lacks what the category asks of it besides the colour
    for (const category of tree) {
      await createVariantValue(products.get(category.id)!.variantId, colour.id, { text: 'red' });
    }

    const requiresSize = new Set<number>();
    for (const category of tree) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/categories/${category.id}/attributes`,
        headers: { cookie: accessCookie(admin) },
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { attribute: { id: number }; required: boolean }[];
      if (items.some((item) => item.attribute.id === size.id && item.required)) {
        requiresSize.add(category.id);
      }
    }

    const found = await list({
      categoryIds: tree.map((category) => category.id).join(','),
      missingRequired: 'true',
      group: 'false',
    });

    expect(requiresSize).toEqual(new Set([root.id, sibling.id, grandchild.id]));
    expect(variantsOf(found)).toEqual(
      byId([...requiresSize].map((categoryId) => products.get(categoryId)!.variantId)),
    );
  });

  it('comes with the filter by characteristics and the search', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const size = await createChoice(['S', 'M']);
    // a word of its own for each product: the search forgives a typo and a shared word is a match
    const [smallWord, mediumWord, plainWord] = [word(), word(), word()];
    const small = await createProduct({ categoryId, name: `${smallWord} lamp` });
    const medium = await createProduct({ categoryId, name: `${mediumWord} lamp` });
    const plain = await createProduct({ categoryId, name: `${plainWord} lamp` });
    await createVariantValue(small.variantId, size.attribute.id, { optionId: size.option.S! });
    await createVariantValue(medium.variantId, size.attribute.id, { optionId: size.option.M! });

    const bySize = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
      f: `${size.attribute.id}:${size.option.S}`,
    });
    const bySearch = await list({
      categoryIds: String(categoryId),
      missingRequired: 'true',
      group: 'false',
      search: plainWord,
    });

    expect(variantIdsOf(bySize)).toEqual([small.variantId]);
    expect(variantIdsOf(bySearch)).toEqual([plain.variantId]);
    expect(variantIdsOf(bySearch)).not.toContain(medium.variantId);
  });

  it('is of the variants a main characteristic tells apart: a group of each', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const colour = await createChoice(['red', 'blue'], { isMain: true });
    const product = await createProduct({ categoryId });
    const second = await createVariant(product.id);
    await createVariantValue(product.variantId, colour.attribute.id, {
      optionId: colour.option.red!,
    });
    await createVariantValue(second.id, colour.attribute.id, { optionId: colour.option.blue! });

    const res = await list({ categoryIds: String(categoryId), missingRequired: 'true' });

    expect(res.json().total).toBe(2);
    expect(variantsOf(res)).toEqual(byId([product.variantId, second.id]));
  });

  it('refuses a buyer when true, and takes false as no filter', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const product = await createProduct({ categoryId });

    const refused = await list({ missingRequired: 'true' }, buyer);
    const taken = await list({ categoryIds: String(categoryId), missingRequired: 'false' }, buyer);

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'missingRequired' },
    });
    expect(taken.statusCode).toBe(200);
    expect(productIdsOf(taken)).toEqual([product.id]);
  });

  it('takes false as no filter for an admin too', async () => {
    const { id: categoryId } = await createCategory();
    await requirement(categoryId);
    const product = await createProduct({ categoryId });

    const res = await list({ categoryIds: String(categoryId), missingRequired: 'false' });

    expect(productIdsOf(res)).toEqual([product.id]);
  });
});

describe('GET /api/products with the filters of the weight, the sizes, the barcode and the pictures', () => {
  // four variants of the products of a category: with the weight and the sizes, the weight only,
  // the sizes only, neither; the first two have a barcode and a picture, the last two have neither
  async function gaps() {
    const { id: categoryId } = await createCategory();
    const full = await createProduct({
      categoryId,
      weightGrams: 300,
      sizesMm: SIZES,
      barcode: uniqueBarcode(),
    });
    const weightOnly = await createProduct({
      categoryId,
      weightGrams: 300,
      barcode: uniqueBarcode(),
    });
    const sizesOnly = await createProduct({ categoryId, sizesMm: SIZES });
    const neither = await createProduct({ categoryId });
    await stripVariantImages(sizesOnly.variantId);
    await stripVariantImages(neither.variantId);

    return { categoryId, full, weightOnly, sizesOnly, neither };
  }

  const query = (categoryId: number, extra: Record<string, string>) => ({
    categoryIds: String(categoryId),
    group: 'false',
    ...extra,
  });

  it('withoutWeight lists the variants with no weight', async () => {
    const { categoryId, sizesOnly, neither } = await gaps();

    const res = await list(query(categoryId, { withoutWeight: 'true' }));

    expect(res.statusCode).toBe(200);
    expect(variantsOf(res)).toEqual(byId([sizesOnly.variantId, neither.variantId]));
    expect(res.json().total).toBe(2);
  });

  it('withoutDimensions lists the variants that lack any of the three sizes', async () => {
    const { categoryId, weightOnly, neither } = await gaps();

    const res = await list(query(categoryId, { withoutDimensions: 'true' }));

    expect(variantsOf(res)).toEqual(byId([weightOnly.variantId, neither.variantId]));
  });

  it('withoutBarcode lists the variants with no barcode', async () => {
    const { categoryId, sizesOnly, neither } = await gaps();

    const res = await list(query(categoryId, { withoutBarcode: 'true' }));

    expect(variantsOf(res)).toEqual(byId([sizesOnly.variantId, neither.variantId]));
  });

  it('withoutImages lists the variants with no picture bound', async () => {
    const { categoryId, sizesOnly, neither } = await gaps();

    const res = await list(query(categoryId, { withoutImages: 'true' }));

    expect(variantsOf(res)).toEqual(byId([sizesOnly.variantId, neither.variantId]));
    for (const row of rowsOf(res)) {
      expect((row.variant as unknown as { visible: boolean }).visible).toBe(false);
    }
  });

  // the sizes come all three or none, so a variant lacks the shipping data when it lacks the weight or the sizes
  it('agrees with withoutShippingData: the variants that lack the weight, or the sizes', async () => {
    const { categoryId } = await gaps();

    const weight = await list(query(categoryId, { withoutWeight: 'true' }));
    const sizes = await list(query(categoryId, { withoutDimensions: 'true' }));
    const shipping = await list(query(categoryId, { withoutShippingData: 'true' }));

    expect(variantsOf(shipping)).toEqual(
      byId([...new Set([...variantIdsOf(weight), ...variantIdsOf(sizes)])]),
    );
  });

  it('holds all the conditions sent', async () => {
    const { categoryId, sizesOnly, neither } = await gaps();

    const three = await list(
      query(categoryId, { withoutWeight: 'true', withoutBarcode: 'true', withoutImages: 'true' }),
    );
    const two = await list(query(categoryId, { withoutWeight: 'true', withoutDimensions: 'true' }));

    expect(variantsOf(three)).toEqual(byId([sizesOnly.variantId, neither.variantId]));
    expect(variantsOf(two)).toEqual([neither.variantId]);
  });

  it('are flags: a variant on sale that lacks a barcode is listed, and the plain list leaves it out', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId, price: 10 });
    await putOnSale(product.id, 5);

    const flagged = await list(query(categoryId, { withoutBarcode: 'true' }));
    const plain = await list(query(categoryId, {}));

    expect(variantIdsOf(flagged)).toEqual([product.variantId]);
    expect(rowsOf(plain)).toEqual([]);
  });

  it('leaves out the variants that are taken out of sale', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId });
    const gone = await createVariant(product.id);
    await markVariantDeleted(gone.id);

    const res = await list(query(categoryId, { withoutBarcode: 'true' }));

    expect(variantIdsOf(res)).toEqual([product.variantId]);
  });

  it('gives groups, counted as groups, unless group is false', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId });
    await createVariant(product.id);

    const grouped = await list({ categoryIds: String(categoryId), withoutWeight: 'true' });
    const apart = await list(query(categoryId, { withoutWeight: 'true' }));

    expect(grouped.json().total).toBe(1);
    expect(rowsOf(grouped)[0]!.stock).toBe(10);
    expect(apart.json().total).toBe(2);
  });

  it('comes with a sort and the pages', async () => {
    const { id: categoryId } = await createCategory();
    const ids: number[] = [];
    for (const price of [30, 10, 20]) {
      ids.push((await createProduct({ categoryId, price })).variantId);
    }
    const base = query(categoryId, {
      withoutBarcode: 'true',
      sort: 'price',
      order: 'asc',
      limit: '2',
    });

    const first = await list(base);
    const second = await list({ ...base, cursor: first.json().nextCursor });

    expect(first.json().total).toBe(3);
    expect(variantIdsOf(first)).toEqual([ids[1], ids[2]]);
    expect(variantIdsOf(second)).toEqual([ids[0]]);
  });

  it.each(['withoutWeight', 'withoutDimensions', 'withoutBarcode', 'withoutImages'])(
    'refuses a buyer %s when true, and takes false',
    async (filter) => {
      const refused = await list({ [filter]: 'true' }, buyer);
      const taken = await list({ [filter]: 'false' }, buyer);

      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ errorCode: 'FILTER_FORBIDDEN', details: { filter } });
      expect(taken.statusCode).toBe(200);
    },
  );

  it.each(['withoutWeight', 'withoutDimensions', 'withoutBarcode', 'withoutImages'])(
    'refuses %s=maybe',
    async (filter) => {
      const res = await list({ [filter]: 'maybe' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );
});

describe('GET /api/products with hasDeletedVariants', () => {
  it('lists the products that have a variant taken out of sale', async () => {
    const { id: categoryId } = await createCategory();
    const withGone = await createProduct({ categoryId });
    const gone = await createVariant(withGone.id);
    await markVariantDeleted(gone.id);
    const clean = await createProduct({ categoryId });
    await createVariant(clean.id);

    const res = await list({ categoryIds: String(categoryId), hasDeletedVariants: 'true' });

    expect(res.statusCode).toBe(200);
    expect(productIdsOf(res)).toEqual([withGone.id]);
    expect(res.json().total).toBe(1);
    // a row is the product with its main variant: a live one
    expect(variantIdsOf(res)).toEqual([withGone.variantId]);
  });

  it('is a flag, and the products removed from the catalog come with deleted=true', async () => {
    const { id: categoryId } = await createCategory();
    const onSale = await createProduct({ categoryId, price: 10 });
    await putOnSale(onSale.id, 5);
    const gone = await createVariant(onSale.id);
    await markVariantDeleted(gone.id);
    const removed = await createProduct({ categoryId });
    await deleteProductFromCatalog(removed.id);

    const alive = await list({ categoryIds: String(categoryId), hasDeletedVariants: 'true' });
    const asRemoved = await list({
      categoryIds: String(categoryId),
      hasDeletedVariants: 'true',
      deleted: 'true',
    });

    expect(productIdsOf(alive)).toEqual([onSale.id]);
    // the variants of a product that is removed are removed with it
    expect(productIdsOf(asRemoved)).toEqual([removed.id]);
  });

  it('takes false as no filter, and refuses a buyer when true', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId });

    const taken = await list({ categoryIds: String(categoryId), hasDeletedVariants: 'false' });
    const refused = await list({ hasDeletedVariants: 'true' }, buyer);

    expect(productIdsOf(taken)).toEqual([product.id]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'hasDeletedVariants' },
    });
  });
});

describe('GET /api/products with manufacturerId, euResponsibleId and documentId', () => {
  const setEuResponsible = (productId: number, euResponsibleId: number) =>
    asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { euResponsibleId } }));

  it('manufacturerId lists the products of the manufacturer', async () => {
    const { id: categoryId } = await createCategory();
    const maker = await createParty();
    const other = await createParty();
    const a = await createProduct({ categoryId, manufacturerId: maker.id });
    const b = await createProduct({ categoryId, manufacturerId: maker.id });
    await createProduct({ categoryId, manufacturerId: other.id });

    const res = await list({ manufacturerId: String(maker.id) });

    expect(res.statusCode).toBe(200);
    expect(productsOf(res)).toEqual(byId([a.id, b.id]));
    expect(res.json().total).toBe(2);
  });

  it('euResponsibleId lists the products that name the person responsible in the EU', async () => {
    const { id: categoryId } = await createCategory();
    const person = await createParty();
    const named = await createProduct({ categoryId });
    await setEuResponsible(named.id, person.id);
    await createProduct({ categoryId });

    const res = await list({ euResponsibleId: String(person.id) });

    expect(productsOf(res)).toEqual([named.id]);
  });

  it('documentId lists the products that hold the document', async () => {
    const { id: categoryId } = await createCategory();
    const holds = await createProduct({ categoryId });
    const document = await createDocument({ productId: holds.id });
    const holdsOther = await createProduct({ categoryId });
    await createDocument({ productId: holdsOther.id });
    await createProduct({ categoryId });

    const res = await list({ documentId: String(document.id) });

    expect(productsOf(res)).toEqual([holds.id]);
  });

  it('are flags: a product on sale is listed, and the deleted ones need deleted=true', async () => {
    const { id: categoryId } = await createCategory();
    const maker = await createParty();
    const onSale = await createProduct({ categoryId, manufacturerId: maker.id, price: 10 });
    await putOnSale(onSale.id, 5);
    const removed = await createProduct({ categoryId, manufacturerId: maker.id });
    await deleteProductFromCatalog(removed.id);

    const alive = await list({ manufacturerId: String(maker.id) });
    const asRemoved = await list({ manufacturerId: String(maker.id), deleted: 'true' });

    expect(productsOf(alive)).toEqual([onSale.id]);
    expect(productsOf(asRemoved)).toEqual([removed.id]);
  });

  it('come with the search, the category, a sort of a variant and the pages', async () => {
    const { id: categoryId } = await createCategory();
    const maker = await createParty();
    const w = word();
    const ids: number[] = [];
    for (const price of [30, 10, 20]) {
      ids.push(
        (
          await createProduct({
            categoryId,
            manufacturerId: maker.id,
            name: `${w} ${price}`,
            price,
          })
        ).variantId,
      );
    }
    await createProduct({ categoryId, manufacturerId: maker.id, name: 'Unrelated thing' });
    const base = {
      manufacturerId: String(maker.id),
      categoryIds: String(categoryId),
      search: w,
      sort: 'price',
      order: 'asc',
      limit: '2',
    };

    const first = await list(base);
    const second = await list({ ...base, cursor: first.json().nextCursor });

    expect(first.json().total).toBe(3);
    expect(variantIdsOf(first)).toEqual([ids[1], ids[2]]);
    expect(variantIdsOf(second)).toEqual([ids[0]]);
  });

  it('come with each other: the products of the manufacturer that hold the document', async () => {
    const { id: categoryId } = await createCategory();
    const maker = await createParty();
    const both = await createProduct({ categoryId, manufacturerId: maker.id });
    const document = await createDocument({ productId: both.id });
    const onlyMaker = await createProduct({ categoryId, manufacturerId: maker.id });
    const onlyDocument = await createProduct({ categoryId });
    await asAdmin((tx) =>
      tx.productDocument.create({
        data: { productId: onlyDocument.id, documentId: document.id, position: 1 },
      }),
    );

    const res = await list({ manufacturerId: String(maker.id), documentId: String(document.id) });

    expect(productsOf(res)).toEqual([both.id]);
    expect(productsOf(res)).not.toContain(onlyMaker.id);
  });

  it.each([
    ['manufacturerId', 'MANUFACTURER_NOT_FOUND'],
    ['euResponsibleId', 'EU_RESPONSIBLE_NOT_FOUND'],
    ['documentId', 'DOCUMENT_NOT_FOUND'],
  ])('answers 404 %s when there is no such record', async (filter, errorCode) => {
    const res = await list({ [filter]: String(MAX_ID) });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode, details: { [filter]: MAX_ID } });
  });

  it.each(['manufacturerId', 'euResponsibleId', 'documentId'])(
    'refuses %s=0, a negative id, a fraction, text and an id past the largest',
    async (filter) => {
      for (const value of ['0', '-1', '1.5', 'abc', String(MAX_ID + 1)]) {
        const res = await list({ [filter]: value });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      }
    },
  );

  it.each(['manufacturerId', 'euResponsibleId', 'documentId'])(
    'refuses a buyer %s, even for an id that is not there',
    async (filter) => {
      const res = await list({ [filter]: String(MAX_ID) }, buyer);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'FILTER_FORBIDDEN', details: { filter } });
    },
  );
});
