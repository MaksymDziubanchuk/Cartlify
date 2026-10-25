import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import {
  createCategory,
  createProduct,
  deleteProductFromCatalog,
  uniqueTag,
} from '../../../helpers/factories.js';

// the search of the catalog forgives a typo and another order of the words, finds a product by the
// name of its category, and puts the best match first; the suggestions give a few names as one
// types. Other files make products at the same time: a test looks only at its own

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

const search = async (text: string, extra = '') => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/products?search=${encodeURIComponent(text)}&limit=100${extra}`,
  });
  expect(res.statusCode).toBe(200);
  return (res.json().items as Array<{ id: number }>).map((item) => item.id);
};

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
      const page = res.json() as { items: Array<{ id: number }>; nextCursor?: string | null };
      expect(res.statusCode).toBe(200);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? null;
    } while (cursor);

    expect(seen.filter((id) => ids.includes(id)).sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('leaves out a product taken out of the catalog', async () => {
    const w = word();
    const product = await createProduct({ price: 10, name: `Old ${w} vase` });
    await deleteProductFromCatalog(product.id);

    expect(await search(`${w} vase`)).not.toContain(product.id);
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

  it('refuses a text of one sign', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products/suggestions?q=a' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
