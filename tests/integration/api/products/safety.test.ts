import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createParty,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { formVariant } from '../../../helpers/productForm.js';
import { manufacturerFormFields } from '../../../helpers/productSafety.js';

// the safety and origin data of a product (the EU GPSR): the manufacturer, the person responsible
// in the EU for a manufacturer outside it, and the warnings. The manufacturer and the person are
// parties of the directory a product names by id; a new product may bring a party that is not in
// the directory yet, which is added to it with the product

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
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const create = (parts: FormPart[], name = `Safety product ${uniqueTag()}`) => {
  const { payload, headers } = multipartBody([
    { name: 'name', value: name },
    { name: 'categoryId', value: String(categoryId) },
    { name: 'variants', value: JSON.stringify([formVariant()]) },
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

const rowOf = (productId: number) =>
  asAdmin((tx) =>
    tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { description: true, manufacturerId: true, euResponsibleId: true, warnings: true },
    }),
  );

const partiesNamed = (name: string) => asAdmin((tx) => tx.party.count({ where: { name } }));
const productsNamed = (name: string) => asAdmin((tx) => tx.product.count({ where: { name } }));

const textOf = (parts: FormPart[], name: string) =>
  (parts.find((part) => part.name === name) as { value: string }).value;

const idField = (name: 'manufacturerId' | 'euResponsibleId', id: number): FormPart => ({
  name,
  value: String(id),
});

const outsideEu = () =>
  manufacturerFormFields({
    name: `Shenzhen Light ${uniqueTag()}`,
    address: '8 Gaoxin Road, Shenzhen, China',
    email: 'info@light.example.com',
    country: 'CN',
  });

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

describe('POST /api/products and the parties', () => {
  it('names a party of the directory by its id and gives it on the card with the text apart', async () => {
    const maker = await createParty({ country: 'DE' });
    const res = await create([
      idField('manufacturerId', maker.id),
      { name: 'description', value: 'Warm light' },
      { name: 'warnings', value: 'Hot surface.' },
    ]);

    expect(res.statusCode).toBe(201);
    expect(res.json().product).toMatchObject({
      description: 'Warm light',
      manufacturer: { id: maker.id, name: maker.name, country: 'DE' },
      euResponsible: null,
      warnings: 'Hot surface.',
    });
    expect(await rowOf(res.json().product.id)).toEqual({
      description: 'Warm light',
      manufacturerId: maker.id,
      euResponsibleId: null,
      warnings: 'Hot surface.',
    });
    // a party of the directory is not made again (the other files of the run add their own)
    expect(await partiesNamed(maker.name)).toBe(1);
  });

  it('adds a party that is new to the directory, with a line of its own in the admin log', async () => {
    const fields = manufacturerFormFields({ country: 'pl' });
    const name = textOf(fields, 'manufacturer.name');

    const res = await create(fields);

    expect(res.statusCode).toBe(201);
    expect(res.json().product.manufacturer).toMatchObject({ name, country: 'PL' });
    const party = await asAdmin((tx) => tx.party.findFirstOrThrow({ where: { name } }));
    expect(party).toMatchObject({ id: res.json().product.manufacturer.id, country: 'PL' });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'party', entityId: party.id, event: 'party.create' },
        select: { actorId: true },
      }),
    );
    expect(lines).toEqual([{ actorId: admin.id }]);
  });

  it('writes the parties and the warnings to the admin log of the product', async () => {
    const maker = await createParty({ country: 'CN' });
    const person = await createParty({ country: 'CZ' });

    const res = await create([
      idField('manufacturerId', maker.id),
      idField('euResponsibleId', person.id),
      { name: 'warnings', value: 'Keep away from water.' },
    ]);

    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirstOrThrow({
        where: { entityType: 'product', entityId: res.json().product.id, event: 'product.create' },
        select: { meta: true },
      }),
    );
    expect(line.meta).toEqual(
      expect.arrayContaining([
        { field: 'manufacturerId', old: null, new: maker.id },
        { field: 'euResponsibleId', old: null, new: person.id },
        { field: 'warnings', old: null, new: 'Keep away from water.' },
      ]),
    );
  });

  it('refuses a product that names no manufacturer, and creates nothing', async () => {
    const name = `No maker ${uniqueTag()}`;

    const res = await create([], name);

    expect(errorOf(res)).toEqual({ status: 400, code: 'MANUFACTURER_REQUIRED' });
    expect(await productsNamed(name)).toBe(0);
  });

  it('refuses a party named by its id and by its values at once', async () => {
    const maker = await createParty({ country: 'DE' });
    const fields = manufacturerFormFields();
    const partyName = textOf(fields, 'manufacturer.name');
    const name = `Both ${uniqueTag()}`;

    const res = await create([idField('manufacturerId', maker.id), ...fields], name);

    expect(errorOf(res)).toEqual({ status: 400, code: 'PARTY_CHOICE_AMBIGUOUS' });
    expect(res.json().details).toEqual({ field: 'manufacturer' });
    expect(await productsNamed(name)).toBe(0);
    expect(await partiesNamed(partyName)).toBe(0);
  });

  it('refuses an id that is not a whole number', async () => {
    const res = await create([{ name: 'manufacturerId', value: '12abc' }]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'PARTY_ID_INVALID' });
    expect(res.json().details).toEqual({ field: 'manufacturerId' });
  });

  it('answers 404 for a manufacturer and for a person that are not in the directory', async () => {
    const maker = await createParty({ country: 'CN' });

    const noMaker = await create([idField('manufacturerId', 2_000_000_000)]);
    const noPerson = await create([
      idField('manufacturerId', maker.id),
      idField('euResponsibleId', 2_000_000_000),
    ]);

    expect(errorOf(noMaker)).toEqual({ status: 404, code: 'MANUFACTURER_NOT_FOUND' });
    expect(errorOf(noPerson)).toEqual({ status: 404, code: 'EU_RESPONSIBLE_NOT_FOUND' });
  });

  it('names every value of a new party that is missing, and what is wrong in another', async () => {
    const fields = manufacturerFormFields();
    const withoutEmail = fields.filter((part) => part.name !== 'manufacturer.email');
    const wrongEmail = fields.map((part) =>
      part.name === 'manufacturer.email' ? { ...part, value: 'not an email' } : part,
    );

    const missing = await create(withoutEmail);
    const wrong = await create(wrongEmail);

    expect(missing.json()).toMatchObject({
      errorCode: 'PARTY_FIELDS_REQUIRED',
      details: { fields: ['manufacturer.email'] },
    });
    expect(wrong.json()).toMatchObject({
      errorCode: 'PARTY_FIELDS_INVALID',
      details: { fields: ['manufacturer.email'] },
    });
  });

  it('needs a person responsible in the EU for a manufacturer outside it, and adds no party then', async () => {
    const fields = outsideEu();
    const partyName = textOf(fields, 'manufacturer.name');
    const name = `Outside ${uniqueTag()}`;

    const without = await create(fields, name);

    expect(errorOf(without)).toEqual({ status: 400, code: 'PRODUCT_EU_RESPONSIBLE_REQUIRED' });
    expect(await productsNamed(name)).toBe(0);
    // the party that was to be new went with the failed product
    expect(await partiesNamed(partyName)).toBe(0);
  });

  it('takes a person responsible in the EU, by its id or as a new party', async () => {
    const person = await createParty({ country: 'CZ' });
    const personFields = [
      { name: 'euResponsible.name', value: `EU Rep ${uniqueTag()}` },
      { name: 'euResponsible.address', value: 'Na Prikope 1, 110 00 Prague, Czechia' },
      { name: 'euResponsible.email', value: 'rep@eurep.example.com' },
      { name: 'euResponsible.country', value: 'CZ' },
    ];

    const byId = await create([...outsideEu(), idField('euResponsibleId', person.id)]);
    const byValues = await create([...outsideEu(), ...personFields]);

    expect(byId.statusCode).toBe(201);
    expect(byId.json().product.euResponsible).toMatchObject({ id: person.id, country: 'CZ' });
    expect(byValues.statusCode).toBe(201);
    expect(byValues.json().product.euResponsible).toMatchObject({
      name: personFields[0]!.value,
      country: 'CZ',
    });
  });

  it('refuses a person that is not in the EU', async () => {
    const person = await createParty({ country: 'US' });

    const res = await create([...outsideEu(), idField('euResponsibleId', person.id)]);

    expect(errorOf(res)).toEqual({ status: 400, code: 'EU_RESPONSIBLE_NOT_IN_EU' });
  });

  it('refuses a new party the directory already holds with 409 and names it', async () => {
    const maker = await createParty({ country: 'DE' });
    const name = `Same ${uniqueTag()}`;

    const res = await create(
      manufacturerFormFields({
        name: maker.name.toUpperCase(),
        address: maker.address,
        country: 'DE',
      }),
      name,
    );

    expect(errorOf(res)).toEqual({ status: 409, code: 'PARTY_ALREADY_EXISTS' });
    expect(res.json().details).toEqual({ partyId: maker.id });
    expect(await productsNamed(name)).toBe(0);
  });

  it('keeps warnings up to 2000 signs and refuses more', async () => {
    const maker = await createParty({ country: 'DE' });

    const longest = await create([
      idField('manufacturerId', maker.id),
      { name: 'warnings', value: 'x'.repeat(2000) },
    ]);
    const tooLong = await create([
      idField('manufacturerId', maker.id),
      { name: 'warnings', value: 'x'.repeat(2001) },
    ]);

    expect(longest.statusCode).toBe(201);
    expect(errorOf(tooLong)).toEqual({ status: 400, code: 'PRODUCT_WARNINGS_TOO_LONG' });
    expect(tooLong.json().details).toEqual({ max: 2000 });
  });

  it('gives the parties on the card of a buyer and not in the list of the catalog', async () => {
    const maker = await createParty({ country: 'DE' });
    const created = await create([idField('manufacturerId', maker.id)]);

    const one = await card(created.json().product.id);
    const list = await app.inject({
      method: 'GET',
      url: `/api/products?search=${encodeURIComponent(created.json().product.name)}`,
    });

    expect(one.product.manufacturer).toMatchObject({ id: maker.id, name: maker.name });
    expect(list.json().items[0].product).not.toHaveProperty('manufacturer');
    expect(list.json().items[0].product).not.toHaveProperty('warnings');
  });
});

describe('PATCH /api/products/:productId and the parties', () => {
  it('changes the manufacturer and writes the ids to the admin log', async () => {
    const product = await createProduct();
    const old = (await rowOf(product.id)).manufacturerId;
    const next = await createParty({ country: 'FR' });

    const res = await patch(product.id, { manufacturerId: next.id });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.manufacturer).toMatchObject({ id: next.id, country: 'FR' });
    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirstOrThrow({
        where: { entityType: 'product', entityId: product.id, event: 'product.update' },
        select: { meta: true },
      }),
    );
    expect(line.meta).toEqual([{ field: 'manufacturerId', old, new: next.id }]);
  });

  it('puts a person responsible in the EU on a product and takes it away', async () => {
    const product = await createProduct();
    const person = await createParty({ country: 'IE' });

    const put = await patch(product.id, { euResponsibleId: person.id });
    const taken = await patch(product.id, { euResponsibleId: null });

    expect(put.json().product.euResponsible).toMatchObject({ id: person.id });
    expect(taken.json().product.euResponsible).toBeNull();
    expect((await rowOf(product.id)).euResponsibleId).toBeNull();
  });

  it('sets the warnings and takes them away with null or an empty text', async () => {
    const product = await createProduct();

    const set = await patch(product.id, { warnings: 'Keep away from children.' });
    const nulled = await patch(product.id, { warnings: null });
    await patch(product.id, { warnings: 'Again.' });
    const emptied = await patch(product.id, { warnings: '   ' });

    expect(set.json().product.warnings).toBe('Keep away from children.');
    expect(nulled.json().product.warnings).toBeNull();
    expect(emptied.json().product.warnings).toBeNull();
  });

  it('refuses a manufacturer outside the EU while the product has no person in the EU', async () => {
    const product = await createProduct();
    const outside = await createParty({ country: 'CN' });
    const person = await createParty({ country: 'DE' });

    const alone = await patch(product.id, { manufacturerId: outside.id });
    const together = await patch(product.id, {
      manufacturerId: outside.id,
      euResponsibleId: person.id,
    });

    expect(errorOf(alone)).toEqual({ status: 400, code: 'PRODUCT_EU_RESPONSIBLE_REQUIRED' });
    expect(together.statusCode).toBe(200);
  });

  it('refuses to take the person away from a manufacturer outside the EU', async () => {
    const outside = await createParty({ country: 'CN' });
    const person = await createParty({ country: 'DE' });
    const product = await createProduct({ manufacturerId: outside.id });
    await patch(product.id, { euResponsibleId: person.id });

    const res = await patch(product.id, { euResponsibleId: null });

    expect(errorOf(res)).toEqual({ status: 400, code: 'PRODUCT_EU_RESPONSIBLE_REQUIRED' });
    expect((await rowOf(product.id)).euResponsibleId).toBe(person.id);
  });

  it('refuses a person that is not in the EU, and a party that is not in the directory', async () => {
    const product = await createProduct();
    const person = await createParty({ country: 'US' });

    const abroad = await patch(product.id, { euResponsibleId: person.id });
    const noMaker = await patch(product.id, { manufacturerId: 2_000_000_000 });
    const noPerson = await patch(product.id, { euResponsibleId: 2_000_000_000 });

    expect(errorOf(abroad)).toEqual({ status: 400, code: 'EU_RESPONSIBLE_NOT_IN_EU' });
    expect(errorOf(noMaker)).toEqual({ status: 404, code: 'MANUFACTURER_NOT_FOUND' });
    expect(errorOf(noPerson)).toEqual({ status: 404, code: 'EU_RESPONSIBLE_NOT_FOUND' });
  });

  it('refuses an id that is not a whole number of at least 1 in a json body', async () => {
    const product = await createProduct();

    // a text of digits is taken as the number, as everywhere in the json bodies: a word is no number
    const text = await patch(product.id, { manufacturerId: 'abc' });
    const zero = await patch(product.id, { manufacturerId: 0 });

    expect(errorOf(text)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(zero)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('takes the ids and the warnings from a form, an empty person takes it away', async () => {
    const product = await createProduct();
    const person = await createParty({ country: 'IE' });
    const next = await createParty({ country: 'ES' });

    const set = await patchForm(product.id, [
      idField('manufacturerId', next.id),
      idField('euResponsibleId', person.id),
      { name: 'warnings', value: 'From a form.' },
    ]);
    const taken = await patchForm(product.id, [{ name: 'euResponsibleId', value: '' }]);
    const wrong = await patchForm(product.id, [{ name: 'manufacturerId', value: 'x' }]);

    expect(set.json().product).toMatchObject({
      manufacturer: { id: next.id },
      euResponsible: { id: person.id },
      warnings: 'From a form.',
    });
    expect(taken.json().product.euResponsible).toBeNull();
    expect(errorOf(wrong)).toEqual({ status: 400, code: 'PARTY_ID_INVALID' });
  });

  it('changes the text of the description alone and leaves the parties', async () => {
    const product = await createProduct();
    const before = await rowOf(product.id);

    const res = await patch(product.id, { description: 'A plain text.' });

    expect(res.statusCode).toBe(200);
    expect(await rowOf(product.id)).toEqual({ ...before, description: 'A plain text.' });
    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirstOrThrow({
        where: { entityType: 'product', entityId: product.id, event: 'product.update' },
        select: { meta: true },
      }),
    );
    expect(line.meta).toEqual([{ field: 'description', old: null, new: 'A plain text.' }]);
  });
});
