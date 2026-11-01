import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  createParty,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the directory of the manufacturers and the persons responsible in the EU: an admin or a root
// keeps it, a party in use cannot be deleted, a change of its country must not break a product,
// and the admin log keeps every change
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

afterAll(stopApp);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const send = (who: TestUser, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'GET' ? { cookie: accessCookie(who) } : withCsrf(csrf, accessCookie(who)),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const fieldsOf = (tag: string, over: object = {}) => ({
  name: `Maker ${tag}`,
  address: `${tag} Test Street 1, 28001 Madrid`,
  email: `maker-${tag}@shop.example.com`,
  country: 'ES',
  ...over,
});

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const auditLinesOf = (partyId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'party', entityId: partyId, event },
      select: { actorId: true, action: true, meta: true },
    }),
  );

// a product of a test that names the party as its manufacturer and, if given, its person in the EU
const productOf = async (manufacturerId: number, euResponsibleId?: number) => {
  const product = await createProduct({ manufacturerId, stock: 0 });
  if (euResponsibleId) {
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { euResponsibleId } }),
    );
  }
  return product;
};

describe('POST /api/admin/parties', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s create a party, trimmed, with the country in capitals', async (_who, who) => {
    const tag = uniqueTag();

    const res = await send(who(), 'POST', '/api/admin/parties', {
      name: `  Maker ${tag} `,
      address: ` ${tag} Test Street 1 `,
      email: ` maker-${tag}@shop.example.com `,
      country: 'es',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: `Maker ${tag}`,
      address: `${tag} Test Street 1`,
      email: `maker-${tag}@shop.example.com`,
      country: 'ES',
    });
    const row = await asAdmin((tx) => tx.party.findUnique({ where: { id: res.json().id } }));
    expect(row).toMatchObject({ name: `Maker ${tag}`, country: 'ES' });
  });

  it('writes a line of the admin log with the values', async () => {
    const tag = uniqueTag();
    const body = fieldsOf(tag);

    const res = await asAdminUser('POST', '/api/admin/parties', body);

    expect(await auditLinesOf(res.json().id, 'party.create')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: null, new: body.name },
          { field: 'address', old: null, new: body.address },
          { field: 'email', old: null, new: body.email },
          { field: 'country', old: null, new: 'ES' },
        ],
      },
    ]);
  });

  it('refuses a user with 403 and creates nothing', async () => {
    const tag = uniqueTag();

    const res = await send(user, 'POST', '/api/admin/parties', fieldsOf(tag));

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(await asAdmin((tx) => tx.party.count({ where: { name: `Maker ${tag}` } }))).toBe(0);
  });

  it('refuses a guest, who has no login, with 403 and creates nothing', async () => {
    const tag = uniqueTag();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/parties',
      headers: withCsrf(csrf, ''),
      payload: fieldsOf(tag),
    });

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(await asAdmin((tx) => tx.party.count({ where: { name: `Maker ${tag}` } }))).toBe(0);
  });

  it('names the values that are missing with 400', async () => {
    const res = await asAdminUser('POST', '/api/admin/parties', {
      ...fieldsOf(uniqueTag()),
      name: '   ',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PARTY_FIELDS_REQUIRED',
      details: { fields: ['name'] },
    });
  });

  it.each([
    ['an email without a domain', { email: 'maker@shop' }, 'email'],
    ['a country name', { country: 'Spain' }, 'country'],
    ['a name of 201 signs', { name: 'x'.repeat(201) }, 'name'],
    ['an address of 501 signs', { address: 'x'.repeat(501) }, 'address'],
  ])('names the value that is wrong with 400: %s', async (_case, change, field) => {
    const res = await asAdminUser('POST', '/api/admin/parties', fieldsOf(uniqueTag(), change));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ details: { fields: [field] } });
  });

  it('refuses a body without a value with the validation error', async () => {
    const res = await asAdminUser('POST', '/api/admin/parties', { name: 'Only a name' });

    expect(errorOf(res)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses a party that is already there, letter case ignored, and names it', async () => {
    const tag = uniqueTag();
    const first = await asAdminUser('POST', '/api/admin/parties', fieldsOf(tag));

    const again = await asAdminUser(
      'POST',
      '/api/admin/parties',
      fieldsOf(tag, {
        name: `MAKER ${tag}`,
        address: `${tag} TEST STREET 1, 28001 MADRID`,
        email: 'other@shop.example.com',
      }),
    );

    expect(errorOf(again)).toEqual({ status: 409, code: 'PARTY_ALREADY_EXISTS' });
    expect(again.json().details).toEqual({ partyId: first.json().id });
  });

  it('lets the same name and address stand in another country', async () => {
    const tag = uniqueTag();
    await asAdminUser('POST', '/api/admin/parties', fieldsOf(tag));

    const other = await asAdminUser('POST', '/api/admin/parties', fieldsOf(tag, { country: 'FR' }));

    expect(other.statusCode).toBe(201);
  });
});

describe('GET /api/admin/parties/:partyId', () => {
  it('gives the party with the number of products that name it', async () => {
    const maker = await createParty();
    const person = await createParty({ country: 'DE' });
    await productOf(maker.id, person.id);
    await productOf(maker.id);

    const makerRes = await asAdminUser('GET', `/api/admin/parties/${maker.id}`);
    const personRes = await asAdminUser('GET', `/api/admin/parties/${person.id}`);

    expect(makerRes.statusCode).toBe(200);
    expect(makerRes.json()).toMatchObject({
      id: maker.id,
      name: maker.name,
      country: 'ES',
      usage: { manufacturerOf: 2, euResponsibleOf: 0 },
    });
    expect(personRes.json().usage).toEqual({ manufacturerOf: 0, euResponsibleOf: 1 });
  });

  it('answers 404 for a party that is not there and 403 for a user', async () => {
    const party = await createParty();

    const missing = await asAdminUser('GET', '/api/admin/parties/2000000000');
    const forbidden = await send(user, 'GET', `/api/admin/parties/${party.id}`);

    expect(errorOf(missing)).toEqual({ status: 404, code: 'PARTY_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });

  it('refuses an id that is not a whole number', async () => {
    const res = await asAdminUser('GET', '/api/admin/parties/12abc');

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/admin/parties', () => {
  // the parties of a test have a name nobody else's has, so a search finds them and no others
  const makeFew = async (tag: string) => {
    const a = await createParty({ name: `Zeta ${tag}`, country: 'ES' });
    const b = await createParty({ name: `alpha ${tag}`, country: 'FR' });
    const c = await createParty({
      name: `Mid ${tag}`,
      country: 'ES',
      email: `mid-${tag}@x.example.com`,
    });
    return { a, b, c };
  };

  it('lists the parties by name, letter case ignored, with the counts of their products', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);
    await productOf(a.id);

    const res = await asAdminUser('GET', `/api/admin/parties?q=${tag}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([b.id, c.id, a.id]);
    expect(res.json().items[2].usage).toEqual({ manufacturerOf: 1, euResponsibleOf: 0 });
  });

  it('turns the order round', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);

    const res = await asAdminUser('GET', `/api/admin/parties?q=${tag}&sortOrder=desc`);

    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([a.id, c.id, b.id]);
  });

  it('searches the name, the address and the email, and filters by country', async () => {
    const tag = uniqueTag();
    const { a, c } = await makeFew(tag);

    const byEmail = await asAdminUser('GET', `/api/admin/parties?q=mid-${tag}`);
    const byCountry = await asAdminUser('GET', `/api/admin/parties?q=${tag}&country=ES`);

    expect(byEmail.json().items.map((item: { id: number }) => item.id)).toEqual([c.id]);
    expect(byCountry.json().items.map((item: { id: number }) => item.id)).toEqual([c.id, a.id]);
  });

  it('takes a percent sign and an underscore of a search as signs', async () => {
    const tag = uniqueTag();
    await createParty({ name: `Per%cent ${tag}` });
    await createParty({ name: `Perxcent ${tag}` });

    const res = await asAdminUser('GET', `/api/admin/parties?q=${encodeURIComponent(`r%c`)}`);

    expect(res.json().items.every((item: { name: string }) => item.name.includes('r%c'))).toBe(
      true,
    );
    expect(res.json().items.some((item: { name: string }) => item.name === `Per%cent ${tag}`)).toBe(
      true,
    );
  });

  it('walks the pages in order, each party once', async () => {
    const tag = uniqueTag();
    const { a, b, c } = await makeFew(tag);
    const seen: number[] = [];

    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await asAdminUser(
        'GET',
        `/api/admin/parties?q=${tag}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((item: { id: number }) => item.id));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual([b.id, c.id, a.id]);
  });

  it('refuses a cursor of another order or a made-up one with 400', async () => {
    const tag = uniqueTag();
    await makeFew(tag);
    const first = await asAdminUser('GET', `/api/admin/parties?q=${tag}&limit=1`);

    const turned = await asAdminUser(
      'GET',
      `/api/admin/parties?q=${tag}&limit=1&sortOrder=desc&cursor=${first.json().nextCursor}`,
    );
    const made = await asAdminUser('GET', '/api/admin/parties?cursor=abc');

    expect(errorOf(turned)).toEqual({ status: 400, code: 'CURSOR_INVALID' });
    expect(errorOf(made)).toEqual({ status: 400, code: 'CURSOR_INVALID' });
  });

  it('refuses a search of more than 200 signs and a country that is not two letters', async () => {
    const long = await asAdminUser('GET', `/api/admin/parties?q=${'x'.repeat(201)}`);
    const country = await asAdminUser('GET', '/api/admin/parties?country=Spain');

    expect(errorOf(long)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(country)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses a user with 403', async () => {
    const res = await send(user, 'GET', '/api/admin/parties');

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/admin/parties/:partyId', () => {
  it('changes the values named, writes the log with only those, and the change shows in every product', async () => {
    const party = await createParty();
    const product = await productOf(party.id);

    const res = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, {
      address: ' 9 New Street, Madrid ',
      email: 'new@shop.example.com',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: party.id,
      name: party.name,
      address: '9 New Street, Madrid',
      email: 'new@shop.example.com',
    });
    expect(await auditLinesOf(party.id, 'party.update')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'address', old: party.address, new: '9 New Street, Madrid' },
          { field: 'email', old: party.email, new: 'new@shop.example.com' },
        ],
      },
    ]);
    const maker = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { manufacturer: { select: { address: true } } },
      }),
    );
    expect(maker.manufacturer.address).toBe('9 New Street, Madrid');
  });

  it('writes no line when nothing changes', async () => {
    const party = await createParty();

    const res = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, {
      name: party.name,
      country: party.country.toLowerCase(),
    });

    expect(res.statusCode).toBe(200);
    expect(await auditLinesOf(party.id, 'party.update')).toEqual([]);
  });

  it('refuses a body with no value to change', async () => {
    const party = await createParty();

    const res = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, {});

    expect(errorOf(res)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
  });

  it('refuses a value that is empty or wrong, and changes nothing', async () => {
    const party = await createParty();

    const empty = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, { name: '   ' });
    const wrong = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, {
      email: 'wrong',
      country: 'Spain',
    });

    expect(empty.json()).toMatchObject({
      errorCode: 'PARTY_FIELDS_INVALID',
      details: { fields: ['name'] },
    });
    expect(wrong.json()).toMatchObject({ details: { fields: ['email', 'country'] } });
    expect(
      await asAdmin((tx) => tx.party.findUniqueOrThrow({ where: { id: party.id } })),
    ).toMatchObject({ name: party.name, email: party.email });
  });

  it('refuses a change that makes it the same as another party with 409 and names it', async () => {
    const tag = uniqueTag();
    const first = await createParty({ name: `Twin ${tag}`, address: 'Same Street 1' });
    const second = await createParty({ name: `Other ${tag}`, address: 'Same Street 1' });

    const res = await asAdminUser('PATCH', `/api/admin/parties/${second.id}`, {
      name: `TWIN ${tag}`,
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'PARTY_ALREADY_EXISTS' });
    expect(res.json().details).toEqual({ partyId: first.id });
  });

  it('answers 404 for a party that is not there and 403 for a user', async () => {
    const party = await createParty();

    const missing = await asAdminUser('PATCH', '/api/admin/parties/2000000000', { name: 'X' });
    const forbidden = await send(user, 'PATCH', `/api/admin/parties/${party.id}`, { name: 'X' });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'PARTY_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });

  describe('a country outside the EU', () => {
    it('is refused for a manufacturer that has a product with no person in the EU', async () => {
      const maker = await createParty({ country: 'ES' });
      const bare = await productOf(maker.id);
      const covered = await productOf(maker.id, (await createParty({ country: 'DE' })).id);

      const res = await asAdminUser('PATCH', `/api/admin/parties/${maker.id}`, { country: 'CN' });

      expect(errorOf(res)).toEqual({ status: 409, code: 'PARTY_COUNTRY_CHANGE_REFUSED' });
      expect(res.json().details).toEqual({
        manufacturerOf: [bare.id],
        euResponsibleOf: [],
        total: 1,
      });
      expect(covered.id).not.toBe(bare.id);
      expect(
        (await asAdmin((tx) => tx.party.findUniqueOrThrow({ where: { id: maker.id } }))).country,
      ).toBe('ES');
    });

    it('is let through for a manufacturer whose products all name a person in the EU', async () => {
      const maker = await createParty({ country: 'ES' });
      await productOf(maker.id, (await createParty({ country: 'DE' })).id);

      const res = await asAdminUser('PATCH', `/api/admin/parties/${maker.id}`, { country: 'CN' });

      expect(res.statusCode).toBe(200);
      expect(res.json().country).toBe('CN');
    });

    it('is refused for a person in the EU that a product names', async () => {
      const maker = await createParty({ country: 'CN' });
      const person = await createParty({ country: 'DE' });
      const product = await productOf(maker.id, person.id);

      const res = await asAdminUser('PATCH', `/api/admin/parties/${person.id}`, { country: 'US' });

      expect(errorOf(res)).toEqual({ status: 409, code: 'PARTY_COUNTRY_CHANGE_REFUSED' });
      expect(res.json().details).toEqual({
        manufacturerOf: [],
        euResponsibleOf: [product.id],
        total: 1,
      });
    });

    // the check of the country reads the products of the party: a product that is being written
    // with a person in the EU must be seen by it, or the change would pass over a product it
    // should have counted. A product holds the party under a shared lock while it is written
    it('waits for a product that is being written and counts it as it was written', async () => {
      const maker = await createParty({ country: 'ES' });
      const person = await createParty({ country: 'DE' });
      const bare = await productOf(maker.id);

      let change: Promise<{ statusCode: number }> | undefined;
      let settled = false;

      await asAdmin(async (tx) => {
        // the product names the party: the shared lock is held to the end of this transaction
        await tx.$queryRaw`SELECT id FROM cartlify.parties WHERE id = ${maker.id} FOR SHARE`;

        change = asAdminUser('PATCH', `/api/admin/parties/${maker.id}`, { country: 'CN' });
        void change.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const waited = !settled;

        // the product gets its person in the EU before the change looks at it
        await tx.product.update({ where: { id: bare.id }, data: { euResponsibleId: person.id } });
        expect(waited).toBe(true);
      });

      const res = await change!;
      expect(res.statusCode).toBe(200);
    });

    it('is let through for a party no product names', async () => {
      const party = await createParty({ country: 'DE' });

      const res = await asAdminUser('PATCH', `/api/admin/parties/${party.id}`, { country: 'CN' });

      expect(res.statusCode).toBe(200);
    });
  });
});

describe('DELETE /api/admin/parties/:partyId', () => {
  it('deletes a party no product names and writes the log with its values', async () => {
    const party = await createParty();

    const res = await asAdminUser('DELETE', `/api/admin/parties/${party.id}`);

    expect(res.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.party.count({ where: { id: party.id } }))).toBe(0);
    expect(await auditLinesOf(party.id, 'party.delete')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: party.name, new: null },
          { field: 'address', old: party.address, new: null },
          { field: 'email', old: party.email, new: null },
          { field: 'country', old: party.country, new: null },
        ],
      },
    ]);
  });

  it('refuses a party a product names as its manufacturer or its person in the EU, and names the products', async () => {
    const maker = await createParty({ country: 'CN' });
    const person = await createParty({ country: 'DE' });
    const product = await productOf(maker.id, person.id);

    const makerRes = await asAdminUser('DELETE', `/api/admin/parties/${maker.id}`);
    const personRes = await asAdminUser('DELETE', `/api/admin/parties/${person.id}`);

    expect(errorOf(makerRes)).toEqual({ status: 409, code: 'PARTY_IN_USE' });
    expect(makerRes.json().details).toEqual({
      manufacturerOf: [product.id],
      euResponsibleOf: [],
      total: 1,
    });
    expect(personRes.json().details).toEqual({
      manufacturerOf: [],
      euResponsibleOf: [product.id],
      total: 1,
    });
    expect(
      await asAdmin((tx) => tx.party.count({ where: { id: { in: [maker.id, person.id] } } })),
    ).toBe(2);
  });

  it('names at most 20 of the products', async () => {
    const maker = await createParty();
    for (let i = 0; i < 21; i += 1) await productOf(maker.id);

    const res = await asAdminUser('DELETE', `/api/admin/parties/${maker.id}`);

    expect(res.json().details.manufacturerOf).toHaveLength(20);
    expect(res.json().details.total).toBe(21);
  });

  it('answers 404 for a party that is not there and 403 for a user', async () => {
    const party = await createParty();

    const missing = await asAdminUser('DELETE', '/api/admin/parties/2000000000');
    const forbidden = await send(user, 'DELETE', `/api/admin/parties/${party.id}`);

    expect(errorOf(missing)).toEqual({ status: 404, code: 'PARTY_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});
