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
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the groups of the characteristics: the sections of the tab of the characteristics of a card. An
// admin or a root keeps them, each has a place of its own, and a group that has characteristics
// stays
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

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const auditLinesOf = (groupId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'attribute', entityId: groupId, event },
      select: { actorId: true, action: true, meta: true },
    }),
  );

describe('POST /api/admin/attribute-groups', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s add a group at the end of the others', async (_who, who) => {
    const last = await createAttributeGroup();
    const name = `Screen ${uniqueTag()}`;

    const res = await send(who(), 'POST', '/api/admin/attribute-groups', { name: `  ${name} ` });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name, attributesCount: 0 });
    expect(res.json().position).toBeGreaterThan(last.position);
  });

  it('writes a line of the admin log', async () => {
    const res = await asAdminUser('POST', '/api/admin/attribute-groups', {
      name: `Logged ${uniqueTag()}`,
    });

    expect(await auditLinesOf(res.json().id, 'attribute_group.create')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [{ field: 'name', old: null, new: res.json().name }],
      },
    ]);
  });

  it('refuses a name that is blank or over 100 signs, naming the field', async () => {
    const blank = await asAdminUser('POST', '/api/admin/attribute-groups', { name: '   ' });
    const long = await asAdminUser('POST', '/api/admin/attribute-groups', {
      name: 'x'.repeat(101),
    });
    const none = await asAdminUser('POST', '/api/admin/attribute-groups', {});

    expect(errorOf(blank)).toEqual({ status: 400, code: 'ATTRIBUTE_GROUP_FIELDS_INVALID' });
    expect(blank.json().details).toEqual({ fields: ['name'] });
    expect(errorOf(long)).toEqual({ status: 400, code: 'ATTRIBUTE_GROUP_FIELDS_INVALID' });
    expect(errorOf(none)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses a name another group has, letter case ignored, and names that group', async () => {
    const first = await createAttributeGroup();

    const res = await asAdminUser('POST', '/api/admin/attribute-groups', {
      name: first.name.toUpperCase(),
    });

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_GROUP_NAME_TAKEN' });
    expect(res.json().details).toEqual({ groupId: first.id });
  });

  it('refuses a user with 403', async () => {
    const res = await send(user, 'POST', '/api/admin/attribute-groups', { name: 'No' });

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('GET /api/admin/attribute-groups', () => {
  it('lists the groups by their places with the number of their characteristics', async () => {
    const first = await createAttributeGroup();
    const second = await createAttributeGroup();
    await createAttribute({ groupId: first.id });
    await createAttribute({ groupId: first.id });

    const res = await asAdminUser('GET', '/api/admin/attribute-groups');

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      id: number;
      position: number;
      attributesCount: number;
    }>;
    const positions = items.map((item) => item.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(items.find((item) => item.id === first.id)?.attributesCount).toBe(2);
    expect(items.find((item) => item.id === second.id)?.attributesCount).toBe(0);
  });

  it('refuses a user with 403', async () => {
    const res = await send(user, 'GET', '/api/admin/attribute-groups');

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/admin/attribute-groups/:groupId', () => {
  it('renames a group and writes the old and the new name to the log', async () => {
    const group = await createAttributeGroup({ name: `Old ${uniqueTag()}` });

    const res = await asAdminUser('PATCH', `/api/admin/attribute-groups/${group.id}`, {
      name: ' New name ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: group.id, name: 'New name', position: group.position });
    expect(await auditLinesOf(group.id, 'attribute_group.update')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [{ field: 'name', old: group.name, new: 'New name' }],
      },
    ]);
  });

  it('writes no line for the name it has already, and refuses a body with no name', async () => {
    const group = await createAttributeGroup();

    const same = await asAdminUser('PATCH', `/api/admin/attribute-groups/${group.id}`, {
      name: group.name,
    });
    const none = await asAdminUser('PATCH', `/api/admin/attribute-groups/${group.id}`, {});

    expect(same.statusCode).toBe(200);
    expect(await auditLinesOf(group.id, 'attribute_group.update')).toEqual([]);
    expect(errorOf(none)).toEqual({ status: 400, code: 'NO_FIELDS_TO_UPDATE' });
  });

  it('refuses a name another group has, a blank one, and a group that is not there', async () => {
    const first = await createAttributeGroup();
    const second = await createAttributeGroup();

    const taken = await asAdminUser('PATCH', `/api/admin/attribute-groups/${second.id}`, {
      name: first.name,
    });
    const blank = await asAdminUser('PATCH', `/api/admin/attribute-groups/${second.id}`, {
      name: '  ',
    });
    const missing = await asAdminUser('PATCH', '/api/admin/attribute-groups/2000000000', {
      name: 'X',
    });

    expect(errorOf(taken)).toEqual({ status: 409, code: 'ATTRIBUTE_GROUP_NAME_TAKEN' });
    expect(taken.json().details).toEqual({ groupId: first.id });
    expect(errorOf(blank)).toEqual({ status: 400, code: 'ATTRIBUTE_GROUP_FIELDS_INVALID' });
    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_GROUP_NOT_FOUND' });
  });
});

describe('DELETE /api/admin/attribute-groups/:groupId', () => {
  it('deletes a group with no characteristics and writes the log', async () => {
    const group = await createAttributeGroup();

    const res = await asAdminUser('DELETE', `/api/admin/attribute-groups/${group.id}`);

    expect(res.statusCode).toBe(200);
    expect(await asAdmin((tx) => tx.attributeGroup.count({ where: { id: group.id } }))).toBe(0);
    expect(await auditLinesOf(group.id, 'attribute_group.delete')).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [{ field: 'name', old: group.name, new: null }],
      },
    ]);
  });

  it('refuses a group that has characteristics and names some', async () => {
    const group = await createAttributeGroup();
    const attribute = await createAttribute({ groupId: group.id });

    const res = await asAdminUser('DELETE', `/api/admin/attribute-groups/${group.id}`);

    expect(errorOf(res)).toEqual({ status: 409, code: 'ATTRIBUTE_GROUP_IN_USE' });
    expect(res.json().details).toEqual({ attributeIds: [attribute.id], total: 1 });
  });

  it('answers 404 for a group that is not there and 403 for a user', async () => {
    const group = await createAttributeGroup();

    const missing = await asAdminUser('DELETE', '/api/admin/attribute-groups/2000000000');
    const forbidden = await send(user, 'DELETE', `/api/admin/attribute-groups/${group.id}`);

    expect(errorOf(missing)).toEqual({ status: 404, code: 'ATTRIBUTE_GROUP_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

describe('two requests at once', () => {
  it('gives two groups made at once a place each', async () => {
    const [a, b] = await Promise.all([
      asAdminUser('POST', '/api/admin/attribute-groups', { name: `Twin ${uniqueTag()}` }),
      asAdminUser('POST', '/api/admin/attribute-groups', { name: `Twin ${uniqueTag()}` }),
    ]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().position).not.toBe(b.json().position);
  });
});
