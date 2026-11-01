import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { keepApart } from '../../../helpers/characteristics.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  markVariantDeleted,
  stripVariantImages,
  uniqueBarcode,
} from '../../../helpers/variants.js';

// the search of the catalog forgives a typo and another order of the words, finds a product by the
// name of its category, and puts the best match first; the suggestions give a few names as one
// types. Other files make products at the same time: a test looks only at its own

let app: FastifyInstance;
let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

type Row = { product: { id: number }; variant: { id: number }; stock: number };

// the rows of a search, as a buyer gets them or, with an actor, as that actor does
const searchRows = async (text: string, extra = '', actor?: TestUser): Promise<Row[]> => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/products?search=${encodeURIComponent(text)}&limit=100${extra}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as Row[];
};

const search = async (text: string, extra = '') =>
  (await searchRows(text, extra)).map((item) => item.product.id);

// a word of its own for each test, of random letters: the search forgives a typo, so two words
// that differ in a sign or two (a counter) would find each other
const word = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');

describe('GET /api/products?search', () => {
  it('finds a product through a typo in its name', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Ceramic ${w} mug` });

    expect(await search(`Ceramik ${w} mug`)).toContain(product.id);
  });

  it('finds a product with the words in another order', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Steel ${w} kettle` });

    expect(await search(`kettle ${w} steel`)).toContain(product.id);
  });

  it('finds the products of a category by its name', async () => {
    const w = word();
    const category = await createCategory({ name: `Garden ${w} tools` });
    const product = await createProduct({
      price: 10,
      categoryId: category.id,
      name: `Rake ${uniqueTag()}`,
    });

    expect(await search(`garden ${w}`)).toContain(product.id);
  });

  // % and _ are wildcards of a pattern: as a search they matched every name
  it.each(['%', '_', '%_%'])('takes %s as it is and finds no name without it', async (text) => {
    const w = word();
    const plain = await createProduct({ price: 10, name: `${w} plain` });
    const marked = await createProduct({ price: 10, name: `${w} 100${text}` });

    const found = await search(text);

    expect(found).not.toContain(plain.id);
    expect(found).toContain(marked.id);
  });

  it('puts the name that matches best first', async () => {
    const w = word();
    const loose = await createProduct({ price: 10, name: `Big ${w} lamp for the desk and table` });
    const exact = await createProduct({ price: 10, name: `${w} lamp` });

    const found = (await search(`${w} lamp`)).filter((id) => id === loose.id || id === exact.id);

    expect(found).toEqual([exact.id, loose.id]);
  });

  it('refuses the sort by relevance without a search', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products?sort=relevance' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SORT_RELEVANCE_REQUIRES_SEARCH' });
  });

  // the cursor keeps the match of the last product: the pages together give each product once
  it('goes page by page through a search sorted by relevance', async () => {
    const w = word();
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1)
      ids.push((await createProduct({ price: 10, name: `Jar ${w} ${'x'.repeat(i)}` })).id);

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string =
        `/api/products?search=${encodeURIComponent(`jar ${w}`)}&limit=2` +
        (cursor ? `&cursor=${cursor}` : '');
      const res = await app.inject({ method: 'GET', url });
      const page = res.json() as {
        items: Array<{ product: { id: number } }>;
        nextCursor?: string | null;
      };
      expect(res.statusCode).toBe(200);
      seen.push(...page.items.map((item) => item.product.id));
      cursor = page.nextCursor ?? null;
    } while (cursor);

    expect(seen.filter((id) => ids.includes(id)).sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // the rows are variants: a variant of a product has the match of the product, the code of the
  // variant puts it first, the id of the variant breaks the ties
  it('goes page by page through a search of variants sorted by relevance', async () => {
    const w = word();
    const variantIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const product = await createProduct({ price: 10, name: `Pot ${w} ${'y'.repeat(i)}` });
      variantIds.push(product.variantId);
      variantIds.push((await createVariant(product.id, { price: 11 })).id);
      await keepApart(variantIds.slice(-2));
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string =
        `/api/products?search=${encodeURIComponent(`pot ${w}`)}&minPrice=0&limit=2` +
        (cursor ? `&cursor=${cursor}` : '');
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      seen.push(...(res.json().items as Row[]).map((item) => item.variant.id));
      cursor = res.json().nextCursor ?? null;
    } while (cursor);

    expect(seen.filter((id) => variantIds.includes(id)).sort((a, b) => a - b)).toEqual(
      [...variantIds].sort((a, b) => a - b),
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('leaves out a product taken out of the catalog', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Old ${w} vase` });
    await deleteProductFromCatalog(product.id);

    expect(await search(`${w} vase`)).not.toContain(product.id);
  });
});

// the article number and the barcode are the variant's: a product row shows the variant that has the
// code, a list of variants holds only that variant
describe('GET /api/products?search by the code of a variant', () => {
  // letters, not a counter: the search forgives a typo and the codes made from counters would find each other
  const sku = () => `SKU-${word()}`;

  it('finds a product by the article number of a variant, whatever the case, and shows that variant', async () => {
    const code = sku();
    const product = await createProduct({ price: 10, name: `Plain ${word()} box`, stock: 5 });
    const second = await createVariant(product.id, { price: 12, sku: code, stock: 0 });

    const rows = await searchRows(code.toLowerCase());

    // the first variant has free units and would be the main one, the code names the other
    expect(rows).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: product.id }),
        variant: expect.objectContaining({ id: second.id }),
      }),
    ]);
  });

  it('shows the main variant of a product found by its name', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Kettle ${w}`, stock: 0 });
    const free = await createVariant(product.id, { price: 11, stock: 4 });

    const rows = await searchRows(`kettle ${w}`);

    // the first by its place with free units
    expect(rows).toHaveLength(1);
    expect(rows[0]!.variant.id).toBe(free.id);
    expect(rows[0]!.stock).toBe(4);
  });

  it('lists only the variant that has the code when the rows are variants', async () => {
    const code = sku();
    const product = await createProduct({ price: 10, name: `Odd ${word()} stool` });
    const other = await createVariant(product.id, { price: 20, sku: code });

    const rows = await searchRows(code, '&sort=price&order=asc');

    expect(rows.map((row) => row.variant.id)).toEqual([other.id]);
  });

  it('lists every variant of a product found by its name when the rows are variants', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Rug ${w}` });
    const second = await createVariant(product.id, { price: 20 });

    // the variants of a product with no main characteristic are one group
    const grouped = await searchRows(`rug ${w}`, '&sort=price&order=asc');
    expect(grouped.map((row) => row.variant.id)).toEqual([product.variantId]);

    // with values of a main characteristic that differ, each is a row
    await keepApart([product.variantId, second.id]);
    const rows = await searchRows(`rug ${w}`, '&sort=price&order=asc');

    expect(rows.map((row) => row.variant.id)).toEqual([product.variantId, second.id]);
  });

  it('does not find a variant that a buyer does not see by its article number', async () => {
    const hidden = sku();
    const out = sku();
    const product = await createProduct({ price: 10, name: `Cabinet ${word()}` });
    const withoutPicture = await createVariant(product.id, { price: 10, sku: hidden });
    const removed = await createVariant(product.id, { price: 10, sku: out });
    await stripVariantImages(withoutPicture.id);
    await markVariantDeleted(removed.id);

    expect(await searchRows(hidden)).toEqual([]);
    expect(await searchRows(out)).toEqual([]);
    // an admin sees the one that is alive
    expect((await searchRows(hidden, '', admin)).map((row) => row.variant.id)).toEqual([
      withoutPicture.id,
    ]);
    expect(await searchRows(out, '', admin)).toEqual([]);
  });

  it('finds a variant by its barcode for an admin and not for a buyer', async () => {
    const barcode = uniqueBarcode();
    const product = await createProduct({ price: 10, name: `Scanner ${word()}`, barcode });

    expect(await searchRows(barcode)).toEqual([]);
    const rows = await searchRows(barcode, '', admin);

    expect(rows).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: product.id }),
        variant: expect.objectContaining({ id: product.variantId, barcode }),
      }),
    ]);
  });

  it('finds nothing of a product taken out of the catalog', async () => {
    const code = sku();
    const product = await createProduct({ price: 10, name: `Gone ${word()}`, sku: code });
    await deleteProductFromCatalog(product.id);

    expect(await searchRows(code)).toEqual([]);
    expect(await searchRows(code, '', admin)).toEqual([]);
  });
});

describe('GET /api/products/suggestions', () => {
  it('gives up to 8 names of the catalog for what is typed', async () => {
    const w = word();
    const ids: number[] = [];
    for (let i = 0; i < 9; i += 1)
      ids.push((await createProduct({ price: 10, name: `Tea ${w} cup ${i}` })).id);
    await deleteProductFromCatalog(ids[0]!);

    const res = await app.inject({
      method: 'GET',
      url: `/api/products/suggestions?q=${encodeURIComponent(`tea ${w}`)}`,
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: number; name: string }>;
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => ids.includes(item.id) && item.name.includes(w))).toBe(true);
    expect(items.map((item) => item.id)).not.toContain(ids[0]);
  });

  // a product with no variant a buyer sees is in no list, so it is in no suggestion either
  it('suggests to a buyer only the products he sees, and to an admin every one that is not taken out', async () => {
    const w = word();
    const seen = await createProduct({ price: 10, name: `Pitcher ${w} seen` });
    const withoutPicture = await createProduct({ price: 10, name: `Pitcher ${w} bare` });
    const withoutVariant = await createProduct({ price: 10, name: `Pitcher ${w} removed` });
    await stripVariantImages(withoutPicture.variantId);
    await markVariantDeleted(withoutVariant.variantId);

    const ask = async (actor?: TestUser) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/products/suggestions?q=${encodeURIComponent(`pitcher ${w}`)}`,
        headers: actor ? { cookie: accessCookie(actor) } : {},
      });
      expect(res.statusCode).toBe(200);
      return (res.json().items as Array<{ id: number }>)
        .map((item) => item.id)
        .sort((a, b) => a - b);
    };

    expect(await ask()).toEqual([seen.id]);
    expect(await ask(admin)).toEqual(
      [seen.id, withoutPicture.id, withoutVariant.id].sort((a, b) => a - b),
    );
  });

  it('refuses a text of one sign', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products/suggestions?q=a' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
