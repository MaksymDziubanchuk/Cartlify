import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeGroup,
  createAttributeOption,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the characteristics of the directory: what a variant is described by. An admin or a root keeps
// them, a number has settings of its own, a main one splits the rows of a list, the type changes
// only while it is safe, and a characteristic a category asks for stays
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

const create = (groupId: number, over: Record<string, unknown> = {}) =>
  asAdminUser('POST', '/api/admin/attributes', {
    name: `Attribute ${uniqueTag()}`,
    type: 'text',
    groupId,
    ...over,
  });

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const auditLinesOf = (attributeId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'attribute', entityId: attributeId, event },
      orderBy: { id: 'asc' },
      select: { actorId: true, action: true, meta: true },
    }),
  );

const rowOf = (attributeId: number) =>
  asAdmin((tx) =>
    tx.attribute.findUniqueOrThrow({
      where: { id: attributeId },
      select: {
        groupId: true,
        position: true,
        type: true,
        decimals: true,
        minValue: true,
        maxValue: true,
      },
    }),
  );

describe('POST /api/admin/attributes', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s add a characteristic at the end of its group', async (_who, who) => {
    const group = await createAttributeGroup();
    const first = await createAttribute({ groupId: group.id });
    const name = `Memory ${uniqueTag()}`;

    const res = await send(who(), 'POST', '/api/admin/attributes', {
      name: ` ${name} `,
      type: 'number',
      groupId: group.id,
      unit: ' GB ',
      decimals: 1,
      minValue: 1,
      maxValue: 1024,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name,
      type: 'number',
      unit: 'GB',
      groupId: group.id,
      group: { id: group.id, name: group.name },
      position: first.position + 1,
      isMain: false,
      inFilters: true,
      decimals: 1,
      minValue: 1,
      maxValue: 1024,
    });
  });

  it('makes each type with the settings it has', async () => {
    const group = await createAttributeGroup();

    const choice = await create(group.id, { type: 'option', isMain: true });
    const set = await create(group.id, { type: 'options', inFilters: false });
    const flag = await create(group.id, { type: 'boolean', isMain: true });
    const number = await create(group.id, { type: 'number' });
    const text = await create(group.id);

    expect(choice.json()).toMatchObject({ type: 'option', isMain: true, decimals: null });
    expect(set.json()).toMatchObject({ type: 'options', isMain: false, inFilters: false });
    expect(flag.json()).toMatchObject({ type: 'boolean', isMain: true });
    expect(number.json()).toMatchObject({ type: 'number', decimals: 0, minValue: null });
    expect(text.json()).toMatchObject({ type: 'text', unit: null, decimals: null });
  });

  it('writes a line of the admin log with what it was made with', async () => {
    const group = await createAttributeGroup();
    const name = `Logged ${uniqueTag()}`;

    const res = await create(group.id, { name, type: 'option', isMain: true });

    expect(await auditLinesOf(res.json().id, 'attribute.create')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: null, new: name },
          { field: 'type', old: null, new: 'option' },
          { field: 'unit', old: null, new: null },
          { field: 'groupId', old: null, new: group.id },
          { field: 'isMain', old: null, new: true },
          { field: 'inFilters', old: null, new: true },
        ],
      },
    ]);
  });

  it.each([
    ['a blank name', { name: '  ' }, ['name']],
    ['a name over 100 signs', { name: 'x'.repeat(101) }, ['name']],
    ['a unit over 20 signs', { unit: 'u'.repeat(21) }, ['unit']],
    ['digits after the point of a text', { decimals: 1 }, ['decimals']],
    ['a bound of a choice', { type: 'option', minValue: 1 }, ['minValue']],
    ['4 digits after the point', { type: 'number', decimals: 4 }, ['decimals']],
    [
      'bounds the wrong way round',
      { type: 'number', minValue: 5, maxValue: 1 },
      ['minValue', 'maxValue'],
    ],
  ])('refuses %s with 400 and names the field', async (_case, over, fields) => {
    const group = await createAttributeGroup();

    const res = await create(group.id, over);

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_FIELDS_INVALID' });
    expect(res.json().details).toEqual({ fields });
  });

  it('refuses a main characteristic that is a text or a set of values', async () => {
    const group = await createAttributeGroup();

    const text = await create(group.id, { type: 'text', isMain: true });
    const set = await create(group.id, { type: 'options', isMain: true });

    expect(errorOf(text)).toEqual({ status: 400, code: 'ATTRIBUTE_MAIN_NOT_ALLOWED' });
    expect(text.json().details).toEqual({ type: 'text' });
    expect(set.json().details).toEqual({ type: 'options' });
  });

  it('refuses a body with no type, a type that is not one, and an id of a group that is not a number', async () => {
    const group = await createAttributeGroup();

    const none = await asAdminUser('POST', '/api/admin/attributes', {
      name: 'X',
      groupId: group.id,
    });
    const wrong = await create(group.id, { type: 'colour' });
    const badGroup = await create(group.id, { groupId: 'abc' });

    expect(errorOf(none)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(wrong)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(badGroup)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('answers 404 for a group that is not there', async () => {
    const res = await create(2_000_000_000);

    expect(errorOf(res)).toEqual({ status: 404, code: 'ATTRIBUTE_GROUP_NOT_FOUND' });
  });

  it('refuses a name another characteristic has, in whichever group, letter case ignored', async () => {
    const first = await createAttribute();
    const other = await createAttributeGroup();

    const res = await create(other.id, { name: first.name.toUpperCase() });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_NAME_TAKEN' });
    expect(res.json().details).toEqual({ attributeId: first.id });
  });

  it('refuses a user with 403', async () => {
    const group = await createAttributeGroup();

    const res = await send(user, 'POST', '/api/admin/attributes', {
      name: 'No',
      type: 'text',
      groupId: group.id,
    });

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('GET /api/admin/attributes', () => {
  it('lists the characteristics in the order of the card with the number of values', async () => {
    const group = await createAttributeGroup();
    const second = await createAttribute({ groupId: group.id, type: 'option' });
    const first = await createAttribute({ groupId: group.id });
    await createAttributeOption(second.id);
    await createAttributeOption(second.id);

    const res = await asAdminUser('GET', `/api/admin/attributes?groupId=${group.id}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([second.id, first.id]);
    expect(res.json().items[0].optionsCount).toBe(2);
    expect(res.json().items[1].optionsCount).toBe(0);
  });

  it('puts the groups in their order and filters by a part of the name and by type', async () => {
    const tag = uniqueTag();
    const later = await createAttributeGroup();
    const earlier = await createAttributeGroup();
    const a = await createAttribute({ groupId: later.id, name: `Zed ${tag}`, type: 'text' });
    const b = await createAttribute({ groupId: earlier.id, name: `Amy ${tag}`, type: 'boolean' });
    await createAttribute({ name: `Per%cent ${tag}` });
    await createAttribute({ name: `Perxcent ${tag}` });

    const byGroup = await asAdminUser('GET', `/api/admin/attributes?q=${tag}`);
    const byType = await asAdminUser('GET', `/api/admin/attributes?q=${tag}&type=boolean`);
    const percent = await asAdminUser(
      'GET',
      `/api/admin/attributes?q=${encodeURIComponent('r%c')}`,
    );

    // the group made first comes first
    expect(
      byGroup
        .json()
        .items.map((item: { id: number }) => item.id)
        .slice(0, 2),
    ).toEqual([a.id, b.id]);
    expect(byType.json().items.map((item: { id: number }) => item.id)).toEqual([b.id]);
    expect(percent.json().items.every((item: { name: string }) => item.name.includes('r%c'))).toBe(
      true,
    );
  });

  it('refuses a user, a search over 200 signs and a type that is not one', async () => {
    const forbidden = await send(user, 'GET', '/api/admin/attributes');
    const long = await asAdminUser('GET', `/api/admin/attributes?q=${'x'.repeat(201)}`);
    const type = await asAdminUser('GET', '/api/admin/attributes?type=colour');

    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(errorOf(long)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(errorOf(type)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/admin/attributes/:attributeId', () => {
  it('gives the characteristic with its values in their order and the categories that ask for it', async () => {
    const attribute = await createAttribute({ type: 'option' });
    const black = await createAttributeOption(attribute.id, {
      name: 'black',
      colorCode: '#000000',
    });
    const white = await createAttributeOption(attribute.id, { name: 'white' });
    const product = await createProduct({ stock: 0 });
    await asAdmin((tx) =>
      tx.categoryAttribute.create({
        data: { categoryId: product.categoryId, attributeId: attribute.id },
      }),
    );

    const res = await asAdminUser('GET', `/api/admin/attributes/${attribute.id}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: attribute.id, usage: { categories: 1 } });
    expect(res.json().options).toMatchObject([
      { id: black.id, name: 'black', position: 1, colorCode: '#000000' },
      { id: white.id, name: 'white', position: 2, colorCode: null },
    ]);
  });

  it('answers 404 for a characteristic that is not there, 403 for a user and 400 for a bad id', async () => {
    const attribute = await createAttribute();

    const missing = await asAdminUser('GET', '/api/admin/attributes/2000000000');
    const forbidden = await send(user, 'GET', `/api/admin/attributes/${attribute.id}`);
    const bad = await asAdminUser('GET', '/api/admin/attributes/12abc');

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('PATCH /api/admin/attributes/:attributeId', () => {
  const patch = (attributeId: number, body: object) =>
    asAdminUser('PATCH', `/api/admin/attributes/${attributeId}`, body);

  it('changes what is named and writes only that to the admin log', async () => {
    const attribute = await createAttribute({ type: 'option', unit: 'mm' });

    const res = await patch(attribute.id, {
      name: ' Renamed ',
      unit: null,
      inFilters: false,
      isMain: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Renamed',
      unit: null,
      inFilters: false,
      isMain: true,
    });
    expect(await auditLinesOf(attribute.id, 'attribute.update')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: attribute.name, new: 'Renamed' },
          { field: 'unit', old: 'mm', new: null },
          { field: 'isMain', old: false, new: true },
          { field: 'inFilters', old: true, new: false },
        ],
      },
    ]);
  });

  it('writes no line for what it has already, and refuses a body that names nothing', async () => {
    const attribute = await createAttribute();

    const same = await patch(attribute.id, { name: attribute.name, inFilters: true });
    const none = await patch(attribute.id, {});

    expect(same.statusCode).toBe(200);
    expect(await auditLinesOf(attribute.id, 'attribute.update')).toEqual([]);
    expect(errorOf(none)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
  });

  it('moves a characteristic to the end of another group', async () => {
    const from = await createAttributeGroup();
    const to = await createAttributeGroup();
    const moved = await createAttribute({ groupId: from.id });
    const resident = await createAttribute({ groupId: to.id });

    const res = await patch(moved.id, { groupId: to.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ groupId: to.id, group: { id: to.id } });
    expect(res.json().position).toBe(resident.position + 1);
    expect(await auditLinesOf(moved.id, 'attribute.update')).toEqual([
      expect.objectContaining({
        meta: [{ field: 'groupId', old: from.id, new: to.id }],
      }),
    ]);
  });

  it('refuses a group that is not there and a name another characteristic has', async () => {
    const first = await createAttribute();
    const second = await createAttribute();

    const group = await patch(second.id, { groupId: 2_000_000_000 });
    const taken = await patch(second.id, { name: first.name.toLowerCase() });

    expect(errorOf(group)).toEqual({ status: 404, code: 'ATTRIBUTE_GROUP_NOT_FOUND' });
    expect(errorOf(taken)).toEqual({ status: 409, code: 'ATTRIBUTE_NAME_TAKEN' });
    expect(taken.json().details).toEqual({ attributeId: first.id });
  });

  it('changes a type that has no values, and the settings of a number go with it', async () => {
    const number = await createAttribute({ type: 'number', decimals: 2, minValue: 1, maxValue: 9 });
    const text = await createAttribute({ type: 'text' });

    const toText = await patch(number.id, { type: 'text' });
    const toNumber = await patch(text.id, { type: 'number' });

    expect(toText.json()).toMatchObject({
      type: 'text',
      decimals: null,
      minValue: null,
      maxValue: null,
    });
    expect(toNumber.json()).toMatchObject({ type: 'number', decimals: 0, minValue: null });
    expect(await rowOf(number.id)).toMatchObject({ type: 'text', decimals: null });
  });

  it('keeps the settings of a number across a change of its name and changes them when named', async () => {
    const number = await createAttribute({ type: 'number', decimals: 2, minValue: 1, maxValue: 9 });

    const renamed = await patch(number.id, { name: `Renamed ${uniqueTag()}` });
    const changed = await patch(number.id, { decimals: 3, maxValue: 20 });
    const cleared = await patch(number.id, { minValue: null });

    expect(renamed.json()).toMatchObject({ decimals: 2, minValue: 1, maxValue: 9 });
    expect(changed.json()).toMatchObject({ decimals: 3, minValue: 1, maxValue: 20 });
    expect(cleared.json()).toMatchObject({ decimals: 3, minValue: null, maxValue: 20 });
  });

  it('refuses settings that are wrong, and names the field', async () => {
    const number = await createAttribute({ type: 'number', minValue: 1, maxValue: 9 });
    const text = await createAttribute({ type: 'text' });

    const digits = await patch(number.id, { decimals: 4 });
    const order = await patch(number.id, { minValue: 10 });
    const notNumber = await patch(text.id, { decimals: 1 });

    expect(errorOf(digits)).toEqual({ status: 400, code: 'ATTRIBUTE_FIELDS_INVALID' });
    expect(digits.json().details).toEqual({ fields: ['decimals'] });
    expect(order.json().details).toEqual({ fields: ['minValue', 'maxValue'] });
    expect(notNumber.json().details).toEqual({ fields: ['decimals'] });
  });

  it('lets a choice become a set of values and back, and keeps its values', async () => {
    const attribute = await createAttribute({ type: 'option' });
    await createAttributeOption(attribute.id);

    const toSet = await patch(attribute.id, { type: 'options' });
    const back = await patch(attribute.id, { type: 'option' });

    expect(toSet.json().type).toBe('options');
    expect(back.json().type).toBe('option');
    const detail = await asAdminUser('GET', `/api/admin/attributes/${attribute.id}`);
    expect(detail.json().options).toHaveLength(1);
  });

  it('refuses a type that would leave values without a choice', async () => {
    const attribute = await createAttribute({ type: 'option' });
    await createAttributeOption(attribute.id);
    await createAttributeOption(attribute.id);

    const res = await patch(attribute.id, { type: 'text' });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_TYPE_LOCKED' });
    expect(res.json().details).toEqual({ reason: 'options', optionsCount: 2 });
    expect((await rowOf(attribute.id)).type).toBe('option');
  });

  it('refuses a type that a main characteristic cannot have', async () => {
    const attribute = await createAttribute({ type: 'boolean', isMain: true });

    const res = await patch(attribute.id, { type: 'text' });

    expect(errorOf(res)).toEqual({ status: 400, code: 'ATTRIBUTE_MAIN_NOT_ALLOWED' });
    expect(res.json().details).toEqual({ type: 'text' });
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const attribute = await createAttribute();

    const missing = await patch(2_000_000_000, { name: 'X' });
    const forbidden = await send(user, 'PATCH', `/api/admin/attributes/${attribute.id}`, {
      name: 'X',
    });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PUT /api/admin/attribute-groups/:groupId/attributes/order', () => {
  const order = (groupId: number, ids: number[]) =>
    asAdminUser('PUT', `/api/admin/attribute-groups/${groupId}/attributes/order`, { ids });

  it('writes a new order of the characteristics of a group and gives them in it', async () => {
    const group = await createAttributeGroup();
    const a = await createAttribute({ groupId: group.id });
    const b = await createAttribute({ groupId: group.id });
    const c = await createAttribute({ groupId: group.id });

    const res = await order(group.id, [c.id, a.id, b.id]);

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([c.id, a.id, b.id]);
    expect(res.json().items.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
    // each that moved has a line, the one that could stay would not: a was at 1, b at 2, c at 3
    expect(await auditLinesOf(c.id, 'attribute.reorder')).toHaveLength(1);
    expect(await auditLinesOf(a.id, 'attribute.reorder')).toHaveLength(1);
    expect(await auditLinesOf(b.id, 'attribute.reorder')).toHaveLength(1);
  });

  it('writes no line for a characteristic that stays in its place', async () => {
    const group = await createAttributeGroup();
    const a = await createAttribute({ groupId: group.id });
    const b = await createAttribute({ groupId: group.id });
    const c = await createAttribute({ groupId: group.id });

    await order(group.id, [a.id, c.id, b.id]);

    expect(await auditLinesOf(a.id, 'attribute.reorder')).toEqual([]);
    expect(await auditLinesOf(c.id, 'attribute.reorder')).toHaveLength(1);
  });

  it('refuses a list that leaves one out, names one of another group, or names one twice', async () => {
    const group = await createAttributeGroup();
    const a = await createAttribute({ groupId: group.id });
    const b = await createAttribute({ groupId: group.id });
    const stranger = await createAttribute();

    const missing = await order(group.id, [a.id]);
    const unknown = await order(group.id, [a.id, b.id, stranger.id]);
    const twice = await order(group.id, [a.id, b.id, b.id]);

    expect(errorOf(missing)).toEqual({ status: 400, code: 'ORDER_IDS_MISMATCH' });
    expect(missing.json().details).toEqual({ missing: [b.id], unknown: [], repeated: [] });
    expect(unknown.json().details).toEqual({ missing: [], unknown: [stranger.id], repeated: [] });
    expect(twice.json().details).toEqual({ missing: [], unknown: [], repeated: [b.id] });
  });

  it('answers 404 for a group that is not there and 403 for a user', async () => {
    const missing = await order(2_000_000_000, []);
    const forbidden = await send(user, 'PUT', '/api/admin/attribute-groups/1/attributes/order', {
      ids: [],
    });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_GROUP_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('DELETE /api/admin/attributes/:attributeId', () => {
  it('deletes a characteristic with its values and writes the log', async () => {
    const attribute = await createAttribute({ type: 'option' });
    await createAttributeOption(attribute.id);

    const res = await asAdminUser('DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(res.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.attribute.count({ where: { id: attribute.id } }))).toBe(0);
    expect(
      await asAdmin((tx) => tx.attributeOption.count({ where: { attributeId: attribute.id } })),
    ).toBe(0);
    expect(await auditLinesOf(attribute.id, 'attribute.delete')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          { field: 'name', old: attribute.name, new: null },
          { field: 'type', old: 'option', new: null },
        ],
      },
    ]);
  });

  it('refuses a characteristic a category asks for and names the categories', async () => {
    const attribute = await createAttribute();
    const product = await createProduct({ stock: 0 });
    await asAdmin((tx) =>
      tx.categoryAttribute.create({
        data: { categoryId: product.categoryId, attributeId: attribute.id },
      }),
    );

    const res = await asAdminUser('DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_IN_USE' });
    expect(res.json().details).toEqual({ categoryIds: [product.categoryId], total: 1 });
  });

  it('answers 404 for a characteristic that is not there and 403 for a user', async () => {
    const attribute = await createAttribute();

    const missing = await asAdminUser('DELETE', '/api/admin/attributes/2000000000');
    const forbidden = await send(user, 'DELETE', `/api/admin/attributes/${attribute.id}`);

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('a name that looks like a key', () => {
  it('is a name taken, not a place taken, whatever the name says', async () => {
    const group = await createAttributeGroup();
    const name = `Odd_position_key ${uniqueTag()}`;

    const first = await create(group.id, { name });
    const second = await create(group.id, { name: name.toUpperCase() });

    expect(first.statusCode).toBe(201);
    expect(errorOf(second)).toEqual({ status: 409, code: 'ATTRIBUTE_NAME_TAKEN' });
    expect(second.json().details).toEqual({ attributeId: first.json().id });
  });
});

describe('two requests at once', () => {
  it('gives two characteristics made in one group at once a place each', async () => {
    const group = await createAttributeGroup();

    const [a, b] = await Promise.all([create(group.id), create(group.id)]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(new Set([a.json().position, b.json().position]).size).toBe(2);
  });

  it('never leaves a characteristic of a text with values: a new type and a new value at once', async () => {
    const attribute = await createAttribute({ type: 'option' });

    const [patched, posted] = await Promise.all([
      asAdminUser('PATCH', `/api/admin/attributes/${attribute.id}`, { type: 'text' }),
      asAdminUser('POST', `/api/admin/attributes/${attribute.id}/options`, { name: 'Black' }),
    ]);

    // one wins and the other is told why: the type is locked by the value, or the text has no values
    expect([patched.statusCode, posted.statusCode].join(' ')).toMatch(/^(200 400|409 201)$/);
    const options = await asAdmin((tx) =>
      tx.attributeOption.count({ where: { attributeId: attribute.id } }),
    );
    expect((await rowOf(attribute.id)).type === 'text' ? options : 0).toBe(0);
  });

  it('refuses an order that names more rows than a scope can have', async () => {
    const group = await createAttributeGroup();

    const res = await asAdminUser(
      'PUT',
      `/api/admin/attribute-groups/${group.id}/attributes/order`,
      {
        ids: Array.from({ length: 5001 }, (_, at) => at + 1),
      },
    );

    expect(errorOf(res)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('the bounds of a number', () => {
  it('keeps what was sent: up to 3 digits after the point, and a repeated request changes nothing', async () => {
    const group = await createAttributeGroup();
    const made = await create(group.id, {
      type: 'number',
      decimals: 3,
      minValue: 0.125,
      maxValue: 99.5,
    });

    const again = await asAdminUser('PATCH', `/api/admin/attributes/${made.json().id}`, {
      minValue: 0.125,
    });
    const tooFine = await asAdminUser('PATCH', `/api/admin/attributes/${made.json().id}`, {
      minValue: 0.1234,
    });

    expect(made.json()).toMatchObject({ minValue: 0.125, maxValue: 99.5 });
    expect(again.statusCode).toBe(200);
    expect(await auditLinesOf(made.json().id, 'attribute.update')).toEqual([]);
    expect(errorOf(tooFine)).toEqual({ status: 400, code: 'ATTRIBUTE_FIELDS_INVALID' });
    expect(tooFine.json().details).toEqual({ fields: ['minValue'] });
  });
});
