import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import {
  createCategory,
  createProduct,
  deleteProductFromCatalog,
  uniqueTag,
} from '../../../helpers/factories.js';

// the branches of the tree in the catalog: a parent category shows the products of its children, the
// card names the way to its category from the top, the tree comes with the products of each branch

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

// Appliances > Kitchen > Kettles, a product in each of the lower two
async function tree() {
  const tag = uniqueTag();
  const top = await createCategory({ name: `Appliances ${tag}` });
  const kitchen = await createCategory({ name: `Kitchen ${tag}`, parentId: top.id });
  const kettles = await createCategory({ name: `Kettles ${tag}`, parentId: kitchen.id });
  const pan = await createProduct({ price: 10, categoryId: kitchen.id });
  const kettle = await createProduct({ price: 20, categoryId: kettles.id });
  return { top, kitchen, kettles, pan, kettle };
}

const idsOf = (res: { json: () => { items: Array<{ id: number }> } }) =>
  res
    .json()
    .items.map((item) => item.id)
    .sort((a, b) => a - b);

describe('GET /api/products by a category', () => {
  // the parent category of the plan held no product of its own and showed an empty page
  it('shows the products of the whole branch of the category', async () => {
    const { top, pan, kettle } = await tree();

    const res = await app.inject({ method: 'GET', url: `/api/products?categoryIds=${top.id}` });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([pan.id, kettle.id].sort((a, b) => a - b));
  });

  it('shows only the products of the category itself with branch=false', async () => {
    const { kitchen, pan } = await tree();

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?categoryIds=${kitchen.id}&branch=false`,
    });

    expect(idsOf(res)).toEqual([pan.id]);
  });
});

describe('GET /api/products/:productId', () => {
  it('names the way from the top of the tree to the category of the product', async () => {
    const { top, kitchen, kettles, kettle } = await tree();

    const res = await app.inject({ method: 'GET', url: `/api/products/${kettle.id}` });

    expect(res.json().category).toEqual({
      id: kettles.id,
      name: kettles.name,
      slug: expect.any(String),
      path: [
        { id: top.id, name: top.name, slug: expect.any(String) },
        { id: kitchen.id, name: kitchen.name, slug: expect.any(String) },
      ],
    });
  });

  it('gives a category at the top an empty way', async () => {
    const top = await createCategory({ name: `Alone ${uniqueTag()}` });
    const product = await createProduct({ price: 10, categoryId: top.id });

    const res = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });

    expect(res.json().category).toMatchObject({ id: top.id, path: [] });
  });
});

type Node = { id: number; name: string; productCount: number; children: Node[] };

const nodeOf = (nodes: Node[], id: number): Node | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = nodeOf(node.children, id);
    if (inner) return inner;
  }
  return undefined;
};

describe('GET /api/categories/tree', () => {
  it('gives the tree with the products of the catalog in each branch', async () => {
    const { top, kitchen, kettles } = await tree();
    const taken = await createProduct({ price: 5, categoryId: kettles.id });
    await deleteProductFromCatalog(taken.id);

    const res = await app.inject({ method: 'GET', url: '/api/categories/tree' });

    expect(res.statusCode).toBe(200);
    const nodes = res.json().items as Node[];
    expect(nodeOf(nodes, top.id)).toMatchObject({
      productCount: 2,
      children: [
        {
          id: kitchen.id,
          productCount: 2,
          children: [{ id: kettles.id, productCount: 1, children: [] }],
        },
      ],
    });
  });
});
