import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage, removeUploads } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createDocument,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { rejectedBy } from '../../../helpers/errors.js';
import { formVariant } from '../../../helpers/productForm.js';
import { manufacturerFormFields } from '../../../helpers/productSafety.js';
import { replaceProductDocuments } from '@routes/api/products/services/helpers/productDocuments.helper.js';

// the documents a product names: instructions and certificates of the directory of documents, in
// the order an admin gave them. The card gives them to everybody, a product is created with them or
// changed to them, and the list is written whole
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let categoryId: number;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  categoryId = (await createProduct({ price: 10 })).categoryId;
});

afterAll(async () => {
  try {
    await removeUploads();
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const create = (parts: FormPart[], name = `Document product ${uniqueTag()}`) => {
  const { payload, headers } = multipartBody([
    { name: 'name', value: name },
    { name: 'categoryId', value: String(categoryId) },
    { name: 'variants', value: JSON.stringify([formVariant()]) },
    ...manufacturerFormFields(),
    ...parts,
    imageField('images', pngImage(30, 20)),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/products',
    headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
    payload,
  });
};

const patch = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const patchForm = (productId: number, parts: FormPart[]) => {
  const { payload, headers } = multipartBody(parts);
  return app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
    payload,
  });
};

const card = async (productId: number) =>
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json();

const rowsOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productDocument.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: { documentId: true, position: true },
    }),
  );

const updateLinesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, event: 'product.update' },
      select: { meta: true },
      orderBy: { id: 'asc' },
    }),
  );

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const documentField = (ids: number[]): FormPart => ({ name: 'documentIds', value: ids.join(',') });

describe('POST /api/products and the documents', () => {
  it('names documents of the directory in their order and gives them on the card', async () => {
    const first = await createDocument({ title: 'Manual', kind: 'instruction' });
    const second = await createDocument({ title: 'CE certificate', kind: 'certificate' });

    const res = await create([documentField([second.id, first.id])]);

    expect(res.statusCode).toBe(201);
    const expected = [
      { id: second.id, title: 'CE certificate', kind: 'certificate', url: second.url },
      { id: first.id, title: 'Manual', kind: 'instruction', url: first.url },
    ];
    expect(res.json().product.documents).toEqual(expected);
    expect(await rowsOf(res.json().product.id)).toEqual([
      { documentId: second.id, position: 1 },
      { documentId: first.id, position: 2 },
    ]);
    // everybody sees them on the card
    expect((await card(res.json().product.id)).product.documents).toEqual(expected);
  });

  it('writes the documents to the admin log of the product', async () => {
    const first = await createDocument();
    const second = await createDocument();

    const res = await create([documentField([first.id, second.id])]);

    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirstOrThrow({
        where: { entityType: 'product', entityId: res.json().product.id, event: 'product.create' },
        select: { meta: true },
      }),
    );
    expect(line.meta).toEqual(
      expect.arrayContaining([{ field: 'documentIds', old: null, new: [first.id, second.id] }]),
    );
  });

  it('gives an empty list for a product that names none', async () => {
    const res = await create([]);

    expect(res.statusCode).toBe(201);
    expect(res.json().product.documents).toEqual([]);
    expect(await rowsOf(res.json().product.id)).toEqual([]);
  });

  it('takes ids with spaces around them', async () => {
    const first = await createDocument();
    const second = await createDocument();

    const res = await create([{ name: 'documentIds', value: ` ${first.id} , ${second.id} ` }]);

    expect(res.json().product.documents.map((document: { id: number }) => document.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('refuses a document that is not in the directory, names it, and creates nothing', async () => {
    const known = await createDocument();
    const name = `Unknown document ${uniqueTag()}`;

    const res = await create([documentField([known.id, 2_000_000_000])], name);

    expect(errorOf(res)).toEqual({ status: 404, code: 'DOCUMENTS_NOT_FOUND' });
    expect(res.json().details).toEqual({ documentIds: [2_000_000_000] });
    expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
  });

  it('refuses an id that is not a whole number, an id twice, and too many documents', async () => {
    const one = await createDocument();
    const max = 20;

    const word = await create([{ name: 'documentIds', value: `${one.id},x` }]);
    const twice = await create([documentField([one.id, one.id])]);
    const many = await create([
      documentField(Array.from({ length: max + 1 }, (_, i) => 1_000_000 + i)),
    ]);

    expect(errorOf(word)).toEqual({ status: 400, code: 'DOCUMENT_ID_INVALID' });
    expect(errorOf(twice)).toEqual({ status: 400, code: 'DOCUMENT_IDS_REPEATED' });
    expect(twice.json().details).toEqual({ ids: [one.id] });
    expect(errorOf(many)).toEqual({ status: 400, code: 'PRODUCT_DOCUMENTS_TOO_MANY' });
    expect(many.json().details).toEqual({ max });
  });
});

describe('PATCH /api/products/:productId and the documents', () => {
  it('writes the list whole: the order, a document added, a document taken away', async () => {
    const product = await createProduct({ stock: 0 });
    const a = await createDocument();
    const b = await createDocument();
    const c = await createDocument();

    const first = await patch(product.id, { documentIds: [a.id, b.id] });
    const second = await patch(product.id, { documentIds: [c.id, b.id] });

    expect(first.statusCode).toBe(200);
    expect(first.json().product.documents.map((d: { id: number }) => d.id)).toEqual([a.id, b.id]);
    expect(second.json().product.documents.map((d: { id: number }) => d.id)).toEqual([c.id, b.id]);
    expect(await rowsOf(product.id)).toEqual([
      { documentId: c.id, position: 1 },
      { documentId: b.id, position: 2 },
    ]);
    expect((await updateLinesOf(product.id)).map((line) => line.meta)).toEqual([
      [{ field: 'documentIds', old: [], new: [a.id, b.id] }],
      [{ field: 'documentIds', old: [a.id, b.id], new: [c.id, b.id] }],
    ]);
  });

  it('takes every document away with an empty list or null, and leaves them with no word on them', async () => {
    const a = await createDocument();
    const product = await createProduct({ stock: 0 });
    await patch(product.id, { documentIds: [a.id] });

    const untouched = await patch(product.id, { name: `Renamed ${uniqueTag()}` });
    const emptied = await patch(product.id, { documentIds: [] });
    await patch(product.id, { documentIds: [a.id] });
    const nulled = await patch(product.id, { documentIds: null });

    expect(untouched.json().product.documents).toHaveLength(1);
    expect(emptied.json().product.documents).toEqual([]);
    expect(nulled.json().product.documents).toEqual([]);
    expect(await rowsOf(product.id)).toEqual([]);
  });

  it('writes no line and no rows when the list is the one the product has', async () => {
    const a = await createDocument();
    const product = await createProduct({ stock: 0 });
    await patch(product.id, { documentIds: [a.id] });
    const before = (await updateLinesOf(product.id)).length;

    const res = await patch(product.id, { documentIds: [a.id] });

    expect(res.statusCode).toBe(200);
    expect((await updateLinesOf(product.id)).length).toBe(before);
  });

  it('takes the list from a form as text, an empty text takes every document away', async () => {
    const a = await createDocument();
    const b = await createDocument();
    const product = await createProduct({ stock: 0 });

    const set = await patchForm(product.id, [documentField([b.id, a.id])]);
    const emptied = await patchForm(product.id, [{ name: 'documentIds', value: '' }]);

    expect(set.json().product.documents.map((d: { id: number }) => d.id)).toEqual([b.id, a.id]);
    expect(emptied.json().product.documents).toEqual([]);
  });

  it('refuses a document that is not in the directory, an id twice and too many, changing nothing', async () => {
    const a = await createDocument();
    const product = await createProduct({ stock: 0 });
    await patch(product.id, { documentIds: [a.id] });

    const unknown = await patch(product.id, { documentIds: [a.id, 2_000_000_000] });
    const twice = await patch(product.id, { documentIds: [a.id, a.id] });
    const many = await patch(product.id, {
      documentIds: Array.from({ length: 21 }, (_, i) => 1_000_000 + i),
    });
    const word = await patchForm(product.id, [{ name: 'documentIds', value: 'x' }]);

    expect(errorOf(unknown)).toEqual({ status: 404, code: 'DOCUMENTS_NOT_FOUND' });
    expect(errorOf(twice)).toEqual({ status: 400, code: 'DOCUMENT_IDS_REPEATED' });
    expect(errorOf(many)).toEqual({ status: 400, code: 'PRODUCT_DOCUMENTS_TOO_MANY' });
    expect(errorOf(word)).toEqual({ status: 400, code: 'DOCUMENT_ID_INVALID' });
    expect(await rowsOf(product.id)).toEqual([{ documentId: a.id, position: 1 }]);
  });

  it('refuses an id in a json body that is not a whole number of at least 1', async () => {
    const product = await createProduct({ stock: 0 });

    const word = await patch(product.id, { documentIds: ['abc'] });
    const zero = await patch(product.id, { documentIds: [0] });

    expect(errorOf(word)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(zero)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  // another admin can delete a document between the check of the ids and the write of the rows: the
  // key of the database holds, and the answer is the one of a document that is not there
  it('is 404 when a document is gone between the check and the write', async () => {
    const product = await createProduct({ stock: 0 });

    const err = await rejectedBy(() =>
      asAdmin((tx) => replaceProductDocuments(tx, product.id, [2_000_000_000])),
    );

    expect(err).toMatchObject({ statusCode: 404, errorCode: 'DOCUMENTS_NOT_FOUND' });
    expect(await rowsOf(product.id)).toEqual([]);
  });

  it('is one of the changes of the batch route too', async () => {
    const a = await createDocument();
    const product = await createProduct({ stock: 0 });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { items: [{ productId: product.id, documentIds: [a.id] }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().products[0].product.documents.map((d: { id: number }) => d.id)).toEqual([
      a.id,
    ]);
  });
});
