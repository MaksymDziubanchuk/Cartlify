import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { pdfField } from '../../helpers/documents.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariantValue,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { multipartBody } from '../../helpers/multipart.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The directories of the admin, each step with what its actor sees: the characteristics (a value
// spelt wrong put right, a value merged into another and taken away, the order of the values and of
// the characteristics of a group, a new name, what is not used any more taken away), each change
// seen by a guest in the filter of the category; the documents of the products (uploaded, given to
// a product, renamed, taken off and deleted), seen by the guest on the card. The rules of each step
// are the tests of api/attributes and api/documents.
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

type Filter = { id: number; name: string; values: { name: string }[] };

describe('the directories of the admin', () => {
  it('keeps the characteristics, and a guest sees each change in the filter', async () => {
    const tag = uniqueTag();
    const group = await j.post(admin, '/api/admin/attribute-groups', { name: `Look ${tag}` });
    const groupId = group.json().id as number;
    const colour = await j.post(admin, '/api/admin/attributes', {
      name: `Colour ${tag}`,
      type: 'option',
      groupId,
      inFilters: true,
    });
    const colourId = colour.json().id as number;
    const optionOf = async (name: string) =>
      (await j.post(admin, `/api/admin/attributes/${colourId}/options`, { name })).json()
        .id as number;
    const red = await optionOf('red');
    const blu = await optionOf('blu');
    const navy = await optionOf('navy');

    // a category of three products, a colour each; the category asks for the colour
    const category = await createCategory();
    for (const optionId of [red, blu, navy]) {
      const product = await createProduct({ categoryId: category.id });
      await createVariantValue(product.variantId, colourId, { optionId });
    }
    expect(
      (
        await j.put(admin, `/api/categories/${category.id}/attributes`, {
          items: [{ attributeId: colourId, required: false }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.get(admin, `/api/categories/${category.id}/attributes`)).json().items).toEqual([
      expect.objectContaining({
        attribute: expect.objectContaining({ id: colourId }),
        required: false,
      }),
    ]);
    const filter = async () => {
      const res = await j.get(null, `/api/products/filters?categoryId=${category.id}`);
      expect(res.statusCode).toBe(200);
      const item = (res.json().items as Filter[]).find(({ id }) => id === colourId)!;
      return { name: item.name, values: item.values.map(({ name }) => name) };
    };
    expect(await filter()).toEqual({ name: `Colour ${tag}`, values: ['red', 'blu', 'navy'] });

    // blu is put right; navy goes into blue and is taken away; blue comes first
    expect(
      (await j.patch(admin, `/api/admin/attributes/${colourId}/options/${blu}`, { name: 'blue' }))
        .statusCode,
    ).toBe(200);
    const merged = await j.post(
      admin,
      `/api/admin/attributes/${colourId}/options/${navy}/replace`,
      {
        withOptionId: blu,
      },
    );
    expect(merged.json()).toEqual({ updatedCount: 1 });
    expect(
      (await j.del(admin, `/api/admin/attributes/${colourId}/options/${navy}`)).statusCode,
    ).toBe(200);
    expect(
      (await j.put(admin, `/api/admin/attributes/${colourId}/options/order`, { ids: [blu, red] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await j.patch(admin, `/api/admin/attributes/${colourId}`, { name: `Main colour ${tag}` }))
        .statusCode,
    ).toBe(200);
    expect(await filter()).toEqual({ name: `Main colour ${tag}`, values: ['blue', 'red'] });
    const card = await j.get(admin, `/api/admin/attributes/${colourId}`);
    expect((card.json().options as { name: string }[]).map(({ name }) => name)).toEqual([
      'blue',
      'red',
    ]);

    // the group: a new name, a second characteristic put before the colour, then taken away
    expect(
      (
        await j.patch(admin, `/api/admin/attribute-groups/${groupId}`, { name: `Looks ${tag}` })
      ).json(),
    ).toMatchObject({
      name: `Looks ${tag}`,
    });
    const finish = await j.post(admin, '/api/admin/attributes', {
      name: `Finish ${tag}`,
      type: 'text',
      groupId,
    });
    const finishId = finish.json().id as number;
    const ordered = await j.put(admin, `/api/admin/attribute-groups/${groupId}/attributes/order`, {
      ids: [finishId, colourId],
    });
    expect((ordered.json().items as { id: number }[]).map(({ id }) => id)).toEqual([
      finishId,
      colourId,
    ]);
    expect((await j.del(admin, `/api/admin/attributes/${finishId}`)).statusCode).toBe(200);

    // a group made by mistake, with nothing in it, is taken away
    const spare = await j.post(admin, '/api/admin/attribute-groups', { name: `Spare ${tag}` });
    expect((await j.del(admin, `/api/admin/attribute-groups/${spare.json().id}`)).statusCode).toBe(
      200,
    );
    const groups = (await j.get(admin, '/api/admin/attribute-groups')).json().items as {
      name: string;
    }[];
    expect(groups.map(({ name }) => name).filter((name) => name.includes(tag))).toEqual([
      `Looks ${tag}`,
    ]);
  });

  it('keeps the documents of the products, and a guest sees them on the card', async () => {
    const tag = uniqueTag();
    const product = await createProduct({ name: `Heater ${tag}` });

    const form = multipartBody([
      pdfField(),
      { name: 'title', value: `Manual ${tag}` },
      { name: 'kind', value: 'instruction' },
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/admin/documents',
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...form.headers },
      payload: form.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const documentId = uploaded.json().id as number;

    // the document goes on the product; the guest reads its title, then the new one
    expect(
      (await j.patch(admin, `/api/products/${product.id}`, { documentIds: [documentId] }))
        .statusCode,
    ).toBe(200);
    const titlesOnCard = async () =>
      (
        (await j.get(null, `/api/products/${product.id}`)).json().product.documents as {
          title: string;
        }[]
      ).map(({ title }) => title);
    expect(await titlesOnCard()).toEqual([`Manual ${tag}`]);
    expect(
      (await j.patch(admin, `/api/admin/documents/${documentId}`, { title: `User manual ${tag}` }))
        .statusCode,
    ).toBe(200);
    expect(await titlesOnCard()).toEqual([`User manual ${tag}`]);
    const listed = await j.get(admin, `/api/admin/documents?q=${encodeURIComponent(tag)}`);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ id: documentId, title: `User manual ${tag}` }),
    ]);
    expect((await j.get(admin, `/api/admin/documents/${documentId}`)).statusCode).toBe(200);

    // taken off the product, then out of the directory
    expect(
      (await j.patch(admin, `/api/products/${product.id}`, { documentIds: [] })).statusCode,
    ).toBe(200);
    expect(await titlesOnCard()).toEqual([]);
    expect((await j.del(admin, `/api/admin/documents/${documentId}`)).statusCode).toBe(200);
    expect(
      (await j.get(admin, `/api/admin/documents?q=${encodeURIComponent(tag)}`)).json().items,
    ).toEqual([]);
  });
});
