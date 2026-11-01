import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  removeUploads,
  storedDocument,
  uploadMark,
  uploadsSince,
} from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { brokenPdf, pdfField, samplePdf } from '../../../helpers/documents.js';
import {
  closeSessions,
  createDocument,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';

// the directory of the documents (instructions, certificates) of the products: an admin or a root
// keeps it, a file is a PDF by its bytes and is kept on Cloudinary as a pdf, a document in use
// cannot be deleted, and the admin log keeps every change
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let user: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  user = await createUser();
});

afterAll(async () => {
  try {
    await removeUploads();
    await closeSessions([admin.id, root.id, user.id]);
  } finally {
    await stopApp();
  }
});

const upload = (who: TestUser, parts: FormPart[]) => {
  const { payload, headers } = multipartBody(parts);
  return app.inject({
    method: 'POST',
    url: '/api/admin/documents',
    headers: { ...withCsrf(csrf, accessCookie(who)), ...headers },
    payload,
  });
};

type Method = 'GET' | 'PATCH' | 'DELETE';

const send = (who: TestUser, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'GET' ? { cookie: accessCookie(who) } : withCsrf(csrf, accessCookie(who)),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const fields = (title: string, kind = 'instruction'): FormPart[] => [
  { name: 'title', value: title },
  { name: 'kind', value: kind },
];

const rowOf = (documentId: number) =>
  asAdmin((tx) => tx.document.findUniqueOrThrow({ where: { id: documentId } }));

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const auditLinesOf = (documentId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'document', entityId: documentId, event },
      select: { actorId: true, action: true, meta: true },
    }),
  );

describe('POST /api/admin/documents', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s keep a PDF with its title and kind, and the file is there', async (_who, who) => {
    const tag = uniqueTag();
    const pdf = samplePdf(300);

    const res = await upload(who(), [pdfField(pdf), ...fields(`  Manual ${tag} `, 'certificate')]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      title: `Manual ${tag}`,
      kind: 'certificate',
      sizeBytes: pdf.length,
    });
    const row = await rowOf(res.json().id);
    expect(row.publicId).toMatch(/^test\/documents\/[0-9a-f-]{36}$/);
    expect(row.url).toBe(res.json().url);
    expect(await storedDocument(row.publicId)).toMatchObject({ bytes: pdf.length });
    // the answer has no public id of the file: the url is what a buyer opens
    expect(res.json()).not.toHaveProperty('publicId');
  });

  // the whole point of keeping a pdf: the url the card gives opens the same PDF; a Cloudinary account
  // that blocks the delivery of PDF files fails here
  it('gives a url that delivers the same PDF', async () => {
    const pdf = samplePdf(50);

    const res = await upload(admin, [pdfField(pdf), ...fields(`Delivered ${uniqueTag()}`)]);
    const delivered = await fetch(res.json().url);

    expect(delivered.status).toBe(200);
    expect(delivered.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await delivered.arrayBuffer())).toEqual(pdf);
  });

  it('writes a line of the admin log with the title, the kind and the size', async () => {
    const tag = uniqueTag();

    const res = await upload(admin, [pdfField(samplePdf(7)), ...fields(`Logged ${tag}`)]);

    expect(await auditLinesOf(res.json().id, 'document.create')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'title', old: null, new: `Logged ${tag}` },
          { field: 'kind', old: null, new: 'instruction' },
          { field: 'sizeBytes', old: null, new: samplePdf(7).length },
        ],
      },
    ]);
  });

  it('takes the fields before or after the file', async () => {
    const res = await upload(admin, [...fields(`Before ${uniqueTag()}`), pdfField()]);

    expect(res.statusCode).toBe(201);
  });

  it('refuses a user and a request that is no form', async () => {
    const mark = uploadMark();

    const forbidden = await upload(user, [pdfField(), ...fields('No')]);
    const json = await app.inject({
      method: 'POST',
      url: '/api/admin/documents',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { title: 'x' },
    });

    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(errorOf(json)).toEqual({ status: 400, code: 'MULTIPART_REQUIRED' });
    expect(uploadsSince(mark)).toEqual([]);
  });

  it('refuses a file that is not a PDF by its bytes, whatever type the form names, and uploads nothing', async () => {
    const mark = uploadMark();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2]);

    const bytes = await upload(admin, [pdfField(png), ...fields('Not a pdf')]);
    const type = await upload(admin, [
      pdfField(samplePdf(), { contentType: 'image/png' }),
      ...fields('Named a picture'),
    ]);

    expect(errorOf(bytes)).toEqual({ status: 400, code: 'DOCUMENT_TYPE_NOT_ALLOWED' });
    expect(errorOf(type)).toEqual({ status: 400, code: 'DOCUMENT_TYPE_NOT_ALLOWED' });
    expect(uploadsSince(mark)).toEqual([]);
  });

  it('refuses a file that starts as a PDF but has no page, and keeps nothing', async () => {
    const mark = uploadMark();

    const res = await upload(admin, [pdfField(brokenPdf()), ...fields('Broken')]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'DOCUMENT_INVALID' });
    for (const id of uploadsSince(mark)) expect(await storedDocument(id)).toBeNull();
  });

  it('refuses an empty file, no file and two files', async () => {
    const mark = uploadMark();

    const empty = await upload(admin, [pdfField(Buffer.alloc(0)), ...fields('Empty')]);
    const none = await upload(admin, fields('None'));
    const two = await upload(admin, [pdfField(), pdfField(), ...fields('Two')]);

    expect(errorOf(empty)).toEqual({ status: 400, code: 'DOCUMENT_STREAM_ERROR' });
    expect(errorOf(none)).toEqual({ status: 400, code: 'DOCUMENT_REQUIRED' });
    expect(errorOf(two)).toEqual({ status: 400, code: 'DOCUMENT_MULTIPLE' });
    expect(uploadsSince(mark).length).toBeLessThanOrEqual(1);
    // the one file that may have gone up before the second part was seen is gone again
    for (const id of uploadsSince(mark)) expect(await storedDocument(id)).toBeNull();
  });

  it('refuses a title that is missing, blank or too long, and the file that went up is deleted', async () => {
    const mark = uploadMark();

    const missing = await upload(admin, [pdfField(), { name: 'kind', value: 'other' }]);
    const blank = await upload(admin, [pdfField(), ...fields('   ')]);
    const long = await upload(admin, [pdfField(), ...fields('x'.repeat(201))]);

    expect(errorOf(missing)).toEqual({ status: 400, code: 'DOCUMENT_TITLE_REQUIRED' });
    expect(errorOf(blank)).toEqual({ status: 400, code: 'DOCUMENT_TITLE_REQUIRED' });
    expect(errorOf(long)).toEqual({ status: 400, code: 'DOCUMENT_TITLE_TOO_LONG' });
    expect(long.json().details).toEqual({ max: 200 });
    for (const id of uploadsSince(mark)) expect(await storedDocument(id)).toBeNull();
  });

  it('refuses a kind that is missing or not one of the four, and names them', async () => {
    const missing = await upload(admin, [pdfField(), { name: 'title', value: 'No kind' }]);
    const wrong = await upload(admin, [pdfField(), ...fields('Wrong kind', 'brochure')]);

    expect(errorOf(missing)).toEqual({ status: 400, code: 'DOCUMENT_KIND_INVALID' });
    expect(wrong.json().details).toEqual({
      allowed: ['instruction', 'certificate', 'declaration', 'other'],
    });
  });

  // a document may be bigger than a picture: the limit of its routes is DOCUMENT_MAX_BYTES (6 MB in
  // the tests), the limit of the other forms stays UPLOAD_MAX_BYTES (5 MB)
  it('takes a file over the limit of a picture and refuses one over its own limit with 413', async () => {
    const mark = uploadMark();

    const big = await upload(admin, [pdfField(samplePdf(5_500_000)), ...fields('Big manual')]);
    const tooBig = await upload(admin, [pdfField(samplePdf(6_100_000)), ...fields('Too big')]);

    expect(big.statusCode).toBe(201);
    expect(errorOf(tooBig)).toEqual({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    // the file that was cut off began its upload and was deleted again: only the big one is kept
    const kept: string[] = [];
    for (const id of uploadsSince(mark)) if (await storedDocument(id)) kept.push(id);
    expect(kept).toEqual([(await rowOf(big.json().id)).publicId]);
  });
});

describe('GET /api/admin/documents', () => {
  const makeFew = async (tag: string) => {
    const a = await createDocument({ title: `Zeta ${tag}`, kind: 'certificate' });
    const b = await createDocument({ title: `alpha ${tag}`, kind: 'instruction' });
    const c = await createDocument({ title: `Mid ${tag}`, kind: 'certificate' });
    return { a, b, c };
  };
  const ids = (res: { json: () => { items: Array<{ id: number }> } }) =>
    res.json().items.map((item) => item.id);

  it('lists the documents by title, letter case ignored, with the products that name each', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);
    const product = await createProduct({ stock: 0 });
    await asAdmin((tx) =>
      tx.productDocument.create({ data: { productId: product.id, documentId: a.id, position: 1 } }),
    );

    const res = await asAdminUser('GET', `/api/admin/documents?q=${tag}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    expect(ids(res)).toEqual([b.id, c.id, a.id]);
    expect(res.json().items[2]).toMatchObject({
      title: `Zeta ${tag}`,
      kind: 'certificate',
      usage: { products: 1 },
    });
    expect(res.json().items[2]).not.toHaveProperty('publicId');
  });

  it('turns the order round, filters by kind and takes a percent sign as a sign', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);
    await createDocument({ title: `Per%cent ${tag}` });
    await createDocument({ title: `Perxcent ${tag}` });

    const desc = await asAdminUser(
      'GET',
      `/api/admin/documents?q=${tag}&kind=certificate&sortOrder=desc`,
    );
    const percent = await asAdminUser('GET', `/api/admin/documents?q=${encodeURIComponent('r%c')}`);

    expect(ids(desc)).toEqual([a.id, c.id]);
    expect(b.id).not.toBe(a.id);
    expect(
      percent.json().items.every((item: { title: string }) => item.title.includes('r%c')),
    ).toBe(true);
  });

  it('walks the pages in order, each document once, and refuses a cursor of another order', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);
    const seen: number[] = [];

    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await asAdminUser(
        'GET',
        `/api/admin/documents?q=${tag}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...ids(res));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }
    const first = await asAdminUser('GET', `/api/admin/documents?q=${tag}&limit=1`);
    const turned = await asAdminUser(
      'GET',
      `/api/admin/documents?q=${tag}&limit=1&sortOrder=desc&cursor=${first.json().nextCursor}`,
    );

    expect(seen).toEqual([b.id, c.id, a.id]);
    expect(errorOf(turned)).toEqual({ status: 400, code: 'CURSOR_INVALID' });
  });

  it('refuses a user, a search over 200 signs and a kind that is not one', async () => {
    const forbidden = await send(user, 'GET', '/api/admin/documents');
    const long = await asAdminUser('GET', `/api/admin/documents?q=${'x'.repeat(201)}`);
    const kind = await asAdminUser('GET', '/api/admin/documents?kind=brochure');

    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(errorOf(long)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(kind)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/admin/documents/:documentId', () => {
  it('gives the document with the number of products that name it', async () => {
    const product = await createProduct({ stock: 0 });
    const document = await createDocument({ productId: product.id });

    const res = await asAdminUser('GET', `/api/admin/documents/${document.id}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: document.id,
      title: document.title,
      url: document.url,
      sizeBytes: 2048,
      usage: { products: 1 },
    });
  });

  it('answers 404 for a document that is not there, 403 for a user and 400 for a bad id', async () => {
    const document = await createDocument();

    const missing = await asAdminUser('GET', '/api/admin/documents/2000000000');
    const forbidden = await send(user, 'GET', `/api/admin/documents/${document.id}`);
    const bad = await asAdminUser('GET', '/api/admin/documents/12abc');

    expect(errorOf(missing)).toEqual({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('PATCH /api/admin/documents/:documentId', () => {
  it('changes the title and the kind and writes only what changed to the admin log', async () => {
    const document = await createDocument({ title: 'Old title', kind: 'instruction' });

    const res = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {
      title: ' New title ',
      kind: 'certificate',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: document.id, title: 'New title', kind: 'certificate' });
    expect(await auditLinesOf(document.id, 'document.update')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'title', old: 'Old title', new: 'New title' },
          { field: 'kind', old: 'instruction', new: 'certificate' },
        ],
      },
    ]);
  });

  it('writes no line when nothing changes and refuses a body with no value', async () => {
    const document = await createDocument();

    const same = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {
      title: document.title,
    });
    const none = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {});

    expect(same.statusCode).toBe(200);
    expect(await auditLinesOf(document.id, 'document.update')).toEqual([]);
    expect(errorOf(none)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
  });

  it('refuses a blank or long title and a kind that is not one, changing nothing', async () => {
    const document = await createDocument();

    const blank = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {
      title: '  ',
    });
    const long = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {
      title: 'x'.repeat(201),
    });
    const kind = await asAdminUser('PATCH', `/api/admin/documents/${document.id}`, {
      kind: 'brochure',
    });

    expect(errorOf(blank)).toEqual({ status: 400, code: 'DOCUMENT_TITLE_REQUIRED' });
    expect(errorOf(long)).toEqual({ status: 400, code: 'DOCUMENT_TITLE_TOO_LONG' });
    expect(errorOf(kind)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect((await rowOf(document.id)).title).toBe(document.title);
  });

  it('answers 404 for a document that is not there and 403 for a user', async () => {
    const document = await createDocument();

    const missing = await asAdminUser('PATCH', '/api/admin/documents/2000000000', { title: 'X' });
    const forbidden = await send(user, 'PATCH', `/api/admin/documents/${document.id}`, {
      title: 'X',
    });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('DELETE /api/admin/documents/:documentId', () => {
  it('deletes a document no product names, with its file, and writes the log', async () => {
    const mark = uploadMark();
    const made = await upload(admin, [pdfField(samplePdf(9)), ...fields(`Deleted ${uniqueTag()}`)]);
    const row = await rowOf(made.json().id);
    expect(await storedDocument(row.publicId)).not.toBeNull();

    const res = await asAdminUser('DELETE', `/api/admin/documents/${row.id}`);

    expect(res.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.document.count({ where: { id: row.id } }))).toBe(0);
    expect(await storedDocument(row.publicId)).toBeNull();
    expect(uploadsSince(mark)).toContain(row.publicId);
    expect(await auditLinesOf(row.id, 'document.delete')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'title', old: row.title, new: null },
          { field: 'kind', old: 'instruction', new: null },
          { field: 'sizeBytes', old: row.sizeBytes, new: null },
        ],
      },
    ]);
  });

  it('refuses a document a product names and names the products', async () => {
    const product = await createProduct({ stock: 0 });
    const document = await createDocument({ productId: product.id });

    const res = await asAdminUser('DELETE', `/api/admin/documents/${document.id}`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'DOCUMENT_IN_USE' });
    expect(res.json().details).toEqual({ productIds: [product.id], total: 1 });
    expect(await asAdmin((tx) => tx.document.count({ where: { id: document.id } }))).toBe(1);
  });

  it('names at most 20 of the products', async () => {
    const document = await createDocument();
    for (let i = 0; i < 21; i += 1) {
      const product = await createProduct({ stock: 0 });
      await asAdmin((tx) =>
        tx.productDocument.create({
          data: { productId: product.id, documentId: document.id, position: 1 },
        }),
      );
    }

    const res = await asAdminUser('DELETE', `/api/admin/documents/${document.id}`);

    expect(res.json().details.productIds).toHaveLength(20);
    expect(res.json().details.total).toBe(21);
  });

  it('answers 404 for a document that is not there and 403 for a user', async () => {
    const document = await createDocument();

    const missing = await asAdminUser('DELETE', '/api/admin/documents/2000000000');
    const forbidden = await send(user, 'DELETE', `/api/admin/documents/${document.id}`);

    expect(errorOf(missing)).toEqual({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});
