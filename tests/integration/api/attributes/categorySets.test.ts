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
  createCategory,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';

// the characteristics a category asks for (the form of the admin): which ones there are and which
// are required, written whole, without an order (the order is the directory's). A child category
// has the set of its parents and adds its own; the same characteristic in a parent and a child
// takes the child's setting. The set is a hint to the form, not a ban
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

type Method = 'GET' | 'PUT' | 'DELETE';

const send = (who: TestUser, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'GET' ? { cookie: accessCookie(who) } : withCsrf(csrf, accessCookie(who)),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const setUrl = (categoryId: number) => `/api/categories/${categoryId}/attributes`;

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

type Item = {
  attribute: { id: number; name: string; group: { id: number } };
  required: boolean;
  categoryId: number;
  inherited: boolean;
};

const summary = (items: Item[]) =>
  items.map((item) => [item.attribute.id, item.required, item.categoryId, item.inherited]);

const askFor = (categoryId: number, attributeId: number, required = false) =>
  asAdmin((tx) => tx.categoryAttribute.create({ data: { categoryId, attributeId, required } }));

const rowsOf = (categoryId: number) =>
  asAdmin((tx) =>
    tx.categoryAttribute.findMany({
      where: { categoryId },
      orderBy: { attributeId: 'asc' },
      select: { attributeId: true, required: true },
    }),
  );

const auditLinesOf = (categoryId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'category', entityId: categoryId, event: 'category.attributes_set' },
      select: { actorId: true, action: true, meta: true },
    }),
  );

describe('GET /api/categories/:categoryId/attributes', () => {
  it('gives an empty set for a category that asks for nothing', async () => {
    const category = await createCategory();

    const res = await asAdminUser('GET', setUrl(category.id));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('gives the set in the order of the directory, a group and then a place in it', async () => {
    const category = await createCategory();
    const first = await createAttributeGroup();
    const second = await createAttributeGroup();
    // made in the order of the ids the other way round, so an order by id would show it
    const b = await createAttribute({ groupId: second.id });
    const c = await createAttribute({ groupId: second.id, type: 'boolean' });
    const a = await createAttribute({ groupId: first.id, type: 'number' });
    await askFor(category.id, c.id, true);
    await askFor(category.id, a.id);
    await askFor(category.id, b.id);

    const res = await asAdminUser('GET', setUrl(category.id));

    // the group made first comes first; in a group, the characteristic made first
    expect(summary(res.json().items)).toEqual([
      [a.id, false, category.id, false],
      [b.id, false, category.id, false],
      [c.id, true, category.id, false],
    ]);
    expect(res.json().items[1].attribute).toMatchObject({
      id: b.id,
      name: b.name,
      type: 'text',
      group: { id: second.id },
    });
  });

  it('gives the set of the parents too, marked as inherited, down every level', async () => {
    const top = await createCategory();
    const middle = await createCategory({ parentId: top.id });
    const leaf = await createCategory({ parentId: middle.id });
    const group = await createAttributeGroup();
    const warranty = await createAttribute({ groupId: group.id });
    const colour = await createAttribute({ groupId: group.id, type: 'option' });
    const memory = await createAttribute({ groupId: group.id, type: 'number' });
    await askFor(top.id, warranty.id, true);
    await askFor(middle.id, colour.id);
    await askFor(leaf.id, memory.id);

    const res = await asAdminUser('GET', setUrl(leaf.id));

    expect(summary(res.json().items)).toEqual([
      [warranty.id, true, top.id, true],
      [colour.id, false, middle.id, true],
      [memory.id, false, leaf.id, false],
    ]);
  });

  it('does not give a parent the set of its children', async () => {
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    const attribute = await createAttribute();
    await askFor(child.id, attribute.id);

    const res = await asAdminUser('GET', setUrl(parent.id));

    expect(res.json()).toEqual({ items: [] });
  });

  it('takes the setting of the child when a parent and a child ask for the same characteristic', async () => {
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    const attribute = await createAttribute();
    await askFor(parent.id, attribute.id, false);
    await askFor(child.id, attribute.id, true);

    const fromChild = await asAdminUser('GET', setUrl(child.id));
    const fromParent = await asAdminUser('GET', setUrl(parent.id));

    expect(summary(fromChild.json().items)).toEqual([[attribute.id, true, child.id, false]]);
    expect(summary(fromParent.json().items)).toEqual([[attribute.id, false, parent.id, false]]);
  });

  it('lets a root read it, and refuses a user with 403', async () => {
    const category = await createCategory();

    const asRoot = await send(root, 'GET', setUrl(category.id));
    const forbidden = await send(user, 'GET', setUrl(category.id));

    expect(asRoot.statusCode).toBe(200);
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });

  it('answers 404 for a category that is not there and 400 for a bad id', async () => {
    const missing = await asAdminUser('GET', setUrl(2_000_000_000));
    const bad = await asAdminUser('GET', '/api/categories/12abc/attributes');

    expect(errorOf(missing)).toEqual({ status: 404, code: 'CATEGORY_NOT_FOUND' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('PUT /api/categories/:categoryId/attributes', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('lets %s write the set; required is false when it is not said', async (_who, who) => {
    const category = await createCategory();
    const a = await createAttribute();
    const b = await createAttribute({ type: 'option' });

    const res = await send(who(), 'PUT', setUrl(category.id), {
      items: [{ attributeId: b.id, required: true }, { attributeId: a.id }],
    });

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(category.id)).toEqual(
      [
        { attributeId: a.id, required: false },
        { attributeId: b.id, required: true },
      ].sort((x, y) => x.attributeId - y.attributeId),
    );
    expect(
      res
        .json()
        .items.map((item: Item) => item.attribute.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('answers with the set the category has, the parents included', async () => {
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    const inherited = await createAttribute();
    const own = await createAttribute();
    await askFor(parent.id, inherited.id, true);

    const res = await asAdminUser('PUT', setUrl(child.id), {
      items: [{ attributeId: own.id }],
    });

    expect(summary(res.json().items).sort()).toEqual(
      [
        [inherited.id, true, parent.id, true],
        [own.id, false, child.id, false],
      ].sort(),
    );
    // only its own rows are stored for the child
    expect(await rowsOf(child.id)).toEqual([{ attributeId: own.id, required: false }]);
  });

  it('replaces the set whole: what is left out goes, what changed is written, what is new comes', async () => {
    const category = await createCategory();
    const keep = await createAttribute();
    const drop = await createAttribute();
    const made = await createAttribute();
    await askFor(category.id, keep.id, false);
    await askFor(category.id, drop.id, true);

    const res = await asAdminUser('PUT', setUrl(category.id), {
      items: [
        { attributeId: keep.id, required: true },
        { attributeId: made.id, required: false },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(category.id)).toEqual(
      [
        { attributeId: keep.id, required: true },
        { attributeId: made.id, required: false },
      ].sort((x, y) => x.attributeId - y.attributeId),
    );
  });

  it('empties the set with an empty list', async () => {
    const category = await createCategory();
    const attribute = await createAttribute();
    await askFor(category.id, attribute.id);

    const res = await asAdminUser('PUT', setUrl(category.id), { items: [] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    expect(await rowsOf(category.id)).toEqual([]);
  });

  it('lets a child ask for what a parent asks, to make it required', async () => {
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    const attribute = await createAttribute();
    await askFor(parent.id, attribute.id, false);

    const res = await asAdminUser('PUT', setUrl(child.id), {
      items: [{ attributeId: attribute.id, required: true }],
    });

    expect(summary(res.json().items)).toEqual([[attribute.id, true, child.id, false]]);
  });

  it('writes a line of the admin log with the set before and after, and none when it is the same', async () => {
    const category = await createCategory();
    const a = await createAttribute();
    const b = await createAttribute();
    await askFor(category.id, a.id, false);
    const items = [
      { attributeId: a.id, required: true },
      { attributeId: b.id, required: false },
    ];

    await asAdminUser('PUT', setUrl(category.id), { items });
    const same = await asAdminUser('PUT', setUrl(category.id), { items: [...items].reverse() });

    expect(same.statusCode).toBe(200);
    const sorted = (list: Array<{ attributeId: number; required: boolean }>) =>
      [...list].sort((x, y) => x.attributeId - y.attributeId);
    expect(await auditLinesOf(category.id)).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        meta: [
          {
            field: 'attributes',
            old: [{ attributeId: a.id, required: false }],
            new: sorted(items),
          },
        ],
      },
    ]);
  });

  it('refuses a characteristic named twice, and names it', async () => {
    const category = await createCategory();
    const attribute = await createAttribute();
    const other = await createAttribute();

    const res = await asAdminUser('PUT', setUrl(category.id), {
      items: [
        { attributeId: attribute.id },
        { attributeId: other.id },
        { attributeId: attribute.id, required: true },
      ],
    });

    expect(errorOf(res)).toEqual({ status: 400, code: 'CATEGORY_ATTRIBUTES_REPEATED' });
    expect(res.json().details).toEqual({ attributeIds: [attribute.id] });
    expect(await rowsOf(category.id)).toEqual([]);
  });

  it('refuses characteristics that are not there, writes nothing, and names them', async () => {
    const category = await createCategory();
    const attribute = await createAttribute();
    await askFor(category.id, attribute.id);

    const res = await asAdminUser('PUT', setUrl(category.id), {
      items: [{ attributeId: attribute.id, required: true }, { attributeId: 2_000_000_000 }],
    });

    expect(errorOf(res)).toEqual({ status: 404, code: 'ATTRIBUTE_NOT_FOUND' });
    expect(res.json().details).toEqual({ attributeIds: [2_000_000_000] });
    expect(await rowsOf(category.id)).toEqual([{ attributeId: attribute.id, required: false }]);
  });

  it.each([
    ['no items', {}],
    ['items that is no list', { items: 'all' }],
    ['an item that is no object', { items: [5] }],
    ['an item with no id', { items: [{ required: true }] }],
    ['an id that is no number', { items: [{ attributeId: 'abc' }] }],
    ['an id below 1', { items: [{ attributeId: 0 }] }],
    ['required that is no boolean', { items: [{ attributeId: 1, required: 'yes' }] }],
    [
      'over 100 items',
      { items: Array.from({ length: 101 }, (_, at) => ({ attributeId: at + 1 })) },
    ],
  ])('refuses %s with 400', async (_case, body) => {
    const category = await createCategory();

    const res = await asAdminUser('PUT', setUrl(category.id), body);

    expect(errorOf(res)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('answers 404 for a category that is not there, 403 for a user and 400 for a bad id', async () => {
    const category = await createCategory();

    const missing = await asAdminUser('PUT', setUrl(2_000_000_000), { items: [] });
    const forbidden = await send(user, 'PUT', setUrl(category.id), { items: [] });
    const bad = await asAdminUser('PUT', '/api/categories/12abc/attributes', { items: [] });

    expect(errorOf(missing)).toEqual({ status: 404, code: 'CATEGORY_NOT_FOUND' });
    expect(errorOf(forbidden)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('the set and its category', () => {
  it('goes with the category when the category is deleted', async () => {
    const category = await createCategory();
    const attribute = await createAttribute();
    await askFor(category.id, attribute.id);

    const res = await asAdminUser('DELETE', `/api/categories/${category.id}`);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(category.id)).toEqual([]);
    expect(await asAdmin((tx) => tx.attribute.count({ where: { id: attribute.id } }))).toBe(1);
  });
});

describe('two requests at once', () => {
  it('leaves one of two sets written at once whole, and tells the other to come again', async () => {
    const category = await createCategory();
    const a = await createAttribute();
    const b = await createAttribute();
    const c = await createAttribute();

    const [one, two] = await Promise.all([
      asAdminUser('PUT', setUrl(category.id), {
        items: [{ attributeId: a.id }, { attributeId: b.id }],
      }),
      asAdminUser('PUT', setUrl(category.id), {
        items: [{ attributeId: b.id }, { attributeId: c.id }],
      }),
    ]);

    for (const res of [one, two]) {
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 409) expect(res.json().errorCode).toBe('RESOURCE_BUSY');
    }
    const stored = (await rowsOf(category.id)).map((row) => row.attributeId);
    expect([
      [a.id, b.id],
      [b.id, c.id],
    ]).toContainEqual(stored);
  });
});
