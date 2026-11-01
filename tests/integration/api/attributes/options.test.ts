import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeOption,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the values of a characteristic that is a choice: a name, a colour for a swatch, a place of their
// own. An admin or a root keeps them, a characteristic of another type has none, and there are few
// of them (ATTRIBUTE_OPTIONS_MAX, 5 in the tests)
const OPTIONS_MAX = 5;

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
    await closeSessions([admin.id, root.id, user.id]);
  } finally {
    await stopApp();
  }
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const send = (who: TestUser, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'GET' ? { cookie: accessCookie(who) } : withCsrf(csrf, accessCookie(who)),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const optionsUrl = (attributeId: number, tail = '') =>
  `/api/admin/attributes/${attributeId}/options${tail}`;

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const auditLinesOf = (optionId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'attribute', entityId: optionId, event },
      select: { actorId: true, action: true, meta: true },
    }),
  );

describe('POST /api/admin/attributes/:attributeId/options', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s add a value at the end of the others', async (_who, who) => {
    const attribute = await createAttribute({ type: 'option' });
    const first = await createAttributeOption(attribute.id);
    const name = `Graphite ${uniqueTag()}`;

    const res = await send(who(), 'POST', optionsUrl(attribute.id), {
      name: ` ${name} `,
      colorCode: '#3A3A3A',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      attributeId: attribute.id,
      name,
      colorCode: '#3a3a3a',
      position: first.position + 1,
    });
  });

  it('takes a value of a set of values with no colour', async () => {
    const attribute = await createAttribute({ type: 'options' });

    const res = await asAdminUser('POST', optionsUrl(attribute.id), { name: 'Wi-Fi' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Wi-Fi', colorCode: null, position: 1 });
  });

  it('writes a line of the admin log', async () => {
    const attribute = await createAttribute({ type: 'option' });

    const res = await asAdminUser('POST', optionsUrl(attribute.id), {
      name: `Logged ${uniqueTag()}`,
    });

    expect(await auditLinesOf(res.json().id, 'attribute_option.create')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'attributeId', old: null, new: attribute.id },
          { field: 'name', old: null, new: res.json().name },
          { field: 'colorCode', old: null, new: null },
        ],
      },
    ]);
  });

  it.each([
    ['a blank name', { name: '  ' }, ['name']],
    ['a name over 100 signs', { name: 'x'.repeat(101) }, ['name']],
    ['a colour with no hash', { name: 'A', colorCode: '00ff00' }, ['colorCode']],
    ['a short colour', { name: 'A', colorCode: '#0f0' }, ['colorCode']],
    ['a colour that is no hex', { name: 'A', colorCode: '#00gg00' }, ['colorCode']],
  ])('refuses %s with 400 and names the field', async (_case, body, fields) => {
    const attribute = await createAttribute({ type: 'option' });

    const res = await asAdminUser('POST', optionsUrl(attribute.id), body);

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTION_FIELDS_INVALID' });
    expect(res.json().details).toEqual({ fields });
  });

  it('refuses a body with no name', async () => {
    const attribute = await createAttribute({ type: 'option' });

    const res = await asAdminUser('POST', optionsUrl(attribute.id), {});

    expect(errorOf(res)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it.each([['text'], ['number'], ['boolean']] as const)(
    'refuses a value for a characteristic of type %s',
    async (type) => {
      const attribute = await createAttribute({ type });

      const res = await asAdminUser('POST', optionsUrl(attribute.id), { name: 'A' });

      expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTIONS_NOT_ALLOWED' });
      expect(res.json().details).toEqual({ type });
    },
  );

  it('refuses a name another value of the characteristic has, letter case ignored', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const first = await createAttributeOption(attribute.id);

    const res = await asAdminUser('POST', optionsUrl(attribute.id), {
      name: first.name.toUpperCase(),
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_OPTION_NAME_TAKEN' });
    expect(res.json().details).toEqual({ optionId: first.id });
  });

  it('lets two characteristics hold a value of one name', async () => {
    const first = await createAttribute({ type: 'option' });
    const second = await createAttribute({ type: 'option' });
    const name = `Shared ${uniqueTag()}`;

    const one = await asAdminUser('POST', optionsUrl(first.id), { name });
    const two = await asAdminUser('POST', optionsUrl(second.id), { name });

    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
  });

  it('refuses a value over the limit and names it', async () => {
    const attribute = await createAttribute({ type: 'option' });
    for (let at = 0; at < OPTIONS_MAX; at += 1) await createAttributeOption(attribute.id);

    const res = await asAdminUser('POST', optionsUrl(attribute.id), { name: 'One too many' });

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTIONS_TOO_MANY' });
    expect(res.json().details).toEqual({ max: OPTIONS_MAX });
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const attribute = await createAttribute({ type: 'option' });

    const missing = await asAdminUser('POST', optionsUrl(2_000_000_000), { name: 'A' });
    const forbidden = await send(user, 'POST', optionsUrl(attribute.id), { name: 'A' });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('GET /api/admin/attributes/:attributeId/options', () => {
  it('lists the values in their order', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const black = await createAttributeOption(attribute.id, {
      name: 'black',
      colorCode: '#000000',
    });
    const white = await createAttributeOption(attribute.id, { name: 'white' });

    const res = await asAdminUser('GET', optionsUrl(attribute.id));

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toMatchObject([
      { id: black.id, name: 'black', position: 1, colorCode: '#000000' },
      { id: white.id, name: 'white', position: 2, colorCode: null },
    ]);
  });

  it('gives an empty list for a choice that has no values', async () => {
    const attribute = await createAttribute({ type: 'options' });

    const res = await asAdminUser('GET', optionsUrl(attribute.id));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const attribute = await createAttribute({ type: 'option' });

    const missing = await asAdminUser('GET', optionsUrl(2_000_000_000));
    const forbidden = await send(user, 'GET', optionsUrl(attribute.id));

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/admin/attributes/:attributeId/options/:optionId', () => {
  const patch = (attributeId: number, optionId: number, body: object) =>
    asAdminUser('PATCH', optionsUrl(attributeId, `/${optionId}`), body);

  it('changes the name and the colour and writes only what changed to the log', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id, { colorCode: '#111111' });

    const res = await patch(attribute.id, option.id, { name: ' Renamed ', colorCode: '#FF0000' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: option.id,
      name: 'Renamed',
      colorCode: '#ff0000',
      position: option.position,
    });
    expect(await auditLinesOf(option.id, 'attribute_option.update')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: option.name, new: 'Renamed' },
          { field: 'colorCode', old: '#111111', new: '#ff0000' },
        ],
      },
    ]);
  });

  it('takes the colour away with null and leaves it when it is not named', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id, { colorCode: '#111111' });

    const kept = await patch(attribute.id, option.id, { name: `Kept ${uniqueTag()}` });
    const cleared = await patch(attribute.id, option.id, { colorCode: null });

    expect(kept.json().colorCode).toBe('#111111');
    expect(cleared.json().colorCode).toBeNull();
  });

  it('writes no line for what it has already, and refuses a body that names nothing', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id);

    const same = await patch(attribute.id, option.id, { name: option.name });
    const none = await patch(attribute.id, option.id, {});

    expect(same.statusCode).toBe(200);
    expect(await auditLinesOf(option.id, 'attribute_option.update')).toEqual([]);
    expect(errorOf(none)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
  });

  it('refuses a name another value has, a blank one and a bad colour', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const first = await createAttributeOption(attribute.id);
    const second = await createAttributeOption(attribute.id);

    const taken = await patch(attribute.id, second.id, { name: first.name.toLowerCase() });
    const blank = await patch(attribute.id, second.id, { name: '  ' });
    const colour = await patch(attribute.id, second.id, { colorCode: 'red' });

    expect(errorOf(taken)).toEqual({ status: 409, code: 'ATTRIBUTE_OPTION_NAME_TAKEN' });
    expect(taken.json().details).toEqual({ optionId: first.id });
    expect(errorOf(blank)).toEqual({ status: 400, code: 'ATTRIBUTE_OPTION_FIELDS_INVALID' });
    expect(blank.json().details).toEqual({ fields: ['name'] });
    expect(colour.json().details).toEqual({ fields: ['colorCode'] });
  });

  it('answers 404 for a value that is not there, or is one of another characteristic', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const foreignOption = await createAttributeOption(other.id);

    const missing = await patch(attribute.id, 2_000_000_000, { name: 'X' });
    const foreign = await patch(attribute.id, foreignOption.id, { name: 'X' });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    expect(errorOf(foreign)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
  });

  it('answers 403 for a user', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id);

    const res = await send(user, 'PATCH', optionsUrl(attribute.id, `/${option.id}`), { name: 'X' });

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PUT /api/admin/attributes/:attributeId/options/order', () => {
  const order = (attributeId: number, ids: number[]) =>
    asAdminUser('PUT', optionsUrl(attributeId, '/order'), { ids });

  it('writes a new order of the values and gives them in it', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(attribute.id);
    const b = await createAttributeOption(attribute.id);
    const c = await createAttributeOption(attribute.id);

    const res = await order(attribute.id, [c.id, a.id, b.id]);

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([c.id, a.id, b.id]);
    expect(res.json().items.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
    expect(await auditLinesOf(c.id, 'attribute_option.reorder')).toEqual([
      { actorId: admin.id, action: 'OTHER', meta: [{ field: 'position', old: 3, new: 1 }] },
    ]);
  });

  it('writes no line for a value that stays in its place', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(attribute.id);
    const b = await createAttributeOption(attribute.id);
    const c = await createAttributeOption(attribute.id);

    await order(attribute.id, [a.id, c.id, b.id]);

    expect(await auditLinesOf(a.id, 'attribute_option.reorder')).toEqual([]);
    expect(await auditLinesOf(c.id, 'attribute_option.reorder')).toHaveLength(1);
  });

  it('refuses a list that leaves one out, names a value of another characteristic, or names one twice', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const a = await createAttributeOption(attribute.id);
    const b = await createAttributeOption(attribute.id);
    const foreignOption = await createAttributeOption(other.id);

    const missing = await order(attribute.id, [a.id]);
    const unknown = await order(attribute.id, [a.id, b.id, foreignOption.id]);
    const twice = await order(attribute.id, [a.id, b.id, b.id]);

    expect(errorOf(missing)).toEqual({ status: 400, code: 'ORDER_IDS_MISMATCH' });
    expect(missing.json().details).toEqual({ missing: [b.id], unknown: [], repeated: [] });
    expect(unknown.json().details).toEqual({
      missing: [],
      unknown: [foreignOption.id],
      repeated: [],
    });
    expect(twice.json().details).toEqual({ missing: [], unknown: [], repeated: [b.id] });
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const missing = await order(2_000_000_000, []);
    const forbidden = await send(user, 'PUT', optionsUrl(1, '/order'), { ids: [] });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('DELETE /api/admin/attributes/:attributeId/options/:optionId', () => {
  it('deletes a value and writes the log', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id, { colorCode: '#222222' });

    const res = await asAdminUser('DELETE', optionsUrl(attribute.id, `/${option.id}`));

    expect(res.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.attributeOption.count({ where: { id: option.id } }))).toBe(0);
    expect(await auditLinesOf(option.id, 'attribute_option.delete')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: option.name, new: null },
          { field: 'colorCode', old: '#222222', new: null },
        ],
      },
    ]);
  });

  it('answers 404 for a value that is not there, or is one of another characteristic', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const other = await createAttribute({ type: 'option' });
    const foreignOption = await createAttributeOption(other.id);

    const missing = await asAdminUser('DELETE', optionsUrl(attribute.id, '/2000000000'));
    const foreign = await asAdminUser('DELETE', optionsUrl(attribute.id, `/${foreignOption.id}`));

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    expect(errorOf(foreign)).toEqual({ status: 404, code: 'ATTRIBUTE_OPTION_NOT_FOUND' });
    expect(
      await asAdmin((tx) => tx.attributeOption.count({ where: { id: foreignOption.id } })),
    ).toBe(1);
  });

  it('answers 403 for a user', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const option = await createAttributeOption(attribute.id);

    const res = await send(user, 'DELETE', optionsUrl(attribute.id, `/${option.id}`));

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});
