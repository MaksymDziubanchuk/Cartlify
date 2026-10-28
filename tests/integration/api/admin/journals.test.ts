import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie, logIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { testTx } from '../../../helpers/db.js';

// the journals an admin reads (GET /api/admin/audit-log, /price-log, /login-log): each sorts by any
// simple column both ways, reads a period, takes some events and some columns, gives a csv file,
// and pages by a cursor that holds its sort. Admin and root read the same lines with the same
// filters; what a journal knows about the account of root is left out for an admin. Other files
// write lines at the same time: a test narrows the journal to the lines of its own admin, product
// or user. The log of consents has a file of its own (it needs the versions in force)

let app: FastifyInstance;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
let csrf: Awaited<ReturnType<typeof getCsrf>>;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
  buyer = await newUser();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const read = (path: string, query: string, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/${path}?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

type Page = {
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  nextCursor: string | null;
};

async function pageOf(path: string, query: string, actor: TestUser = admin): Promise<Page> {
  const res = await read(path, query, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

// every line of a list in one page, or walking it one line at a time
const all = (path: string, query: string, actor?: TestUser) =>
  pageOf(path, `${query}&limit=100`, actor);

async function walk(path: string, query: string): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await pageOf(path, `${query}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return seen;
}

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- what each journal is made of

type Journal = {
  name: string;
  path: string;
  sorts: string[];
  columns: string[];
  // the lines of a test of its own, and the query that finds only them
  seed: () => Promise<{ narrow: string; events: string[] }>;
  // the csv header for the columns asked for
  header: (columns: string[]) => string;
};

type AuditSeed = {
  entityType: string;
  entityId: number | null;
  action: string;
  event: string;
  ip: string | null;
};

// a line of the admin log written by the database function, in the name of the admin
async function auditLine(who: TestUser, line: AuditSeed, userAgent: string | null = null) {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: who.id, role: who.role });
    if (line.ip) await tx.$executeRaw`select set_config('cartlify.request_ip', ${line.ip}, true)`;
    if (userAgent) {
      await tx.$executeRaw`select set_config('cartlify.request_user_agent', ${userAgent}, true)`;
    }
    await tx.$executeRaw`select cartlify.log_admin_action(
      ${who.id}::int, ${who.role}::cartlify."Role", ${line.entityType}::cartlify."AdminAuditEntityType",
      ${line.entityId}::int, ${line.action}::cartlify."AdminAuditAction", ${line.event},
      ${JSON.stringify([{ field: 'name', old: 'a', new: 'b' }])}::jsonb)`;
  });
  // a line of its own moment
  await sleep(5);
}

const AUDIT_LINES: AuditSeed[] = [
  {
    entityType: 'product',
    entityId: 11,
    action: 'PRODUCT_UPDATE',
    event: 'product.update',
    ip: '203.0.113.1',
  },
  {
    entityType: 'order',
    entityId: 22,
    action: 'ORDER_STATUS_CHANGE',
    event: 'order.ship',
    ip: null,
  },
  {
    entityType: 'product',
    entityId: 33,
    action: 'PRODUCT_DELETE',
    event: 'product.delete',
    ip: '203.0.113.9',
  },
  { entityType: 'other', entityId: null, action: 'OTHER', event: 'category.create', ip: null },
];

const AUDIT: Journal = {
  name: 'the admin log',
  path: 'audit-log',
  sorts: [
    'id',
    'createdAt',
    'actorId',
    'actorRole',
    'action',
    'event',
    'entityType',
    'entityId',
    'ip',
    'userAgent',
  ],
  columns: [
    'id',
    'createdAt',
    'actorId',
    'actor',
    'actorRole',
    'action',
    'event',
    'entityType',
    'entityId',
    'ip',
    'userAgent',
    'changes',
  ],
  seed: async () => {
    const owner = await newUser({ role: 'ADMIN' });
    for (const [index, line] of AUDIT_LINES.entries()) {
      await auditLine(owner, line, line.ip ? `Browser ${index}` : null);
    }
    return { narrow: `actorId=${owner.id}`, events: AUDIT_LINES.map((line) => line.event) };
  },
  header: (columns) =>
    columns
      .flatMap((column) => (column === 'actor' ? ['actorName', 'actorEmail'] : [column]))
      .join(','),
};

const PRICE_LINES = [
  { oldPrice: 10, newPrice: 12, mode: 'fixed', value: 2, event: 'price.set', endsAt: null },
  { oldPrice: 12, newPrice: 9, mode: 'fixed', value: -3, event: 'price.set_batch', endsAt: null },
  { oldPrice: 9, newPrice: 8.1, mode: 'percent', value: -10, event: 'price.bulk', endsAt: null },
  {
    oldPrice: 8.1,
    newPrice: 7.2,
    mode: 'percent',
    value: -11.11,
    event: 'price.sale_start',
    endsAt: new Date(Date.now() + 3 * DAY).toISOString(),
  },
];

async function priceLine(who: TestUser, productId: number, line: (typeof PRICE_LINES)[number]) {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: who.id, role: who.role });
    await tx.$executeRaw`select cartlify.log_product_price_change(
      ${productId}::int, ${line.oldPrice}::numeric, ${line.newPrice}::numeric,
      ${line.mode}::cartlify."PriceChangeMode", ${line.value}::numeric, ${line.event},
      (${line.endsAt}::timestamptz at time zone 'UTC'))`;
  });
  await sleep(5);
}

const PRICE: Journal = {
  name: 'the log of prices',
  path: 'price-log',
  sorts: [
    'id',
    'createdAt',
    'productId',
    'actorId',
    'event',
    'oldPrice',
    'newPrice',
    'mode',
    'value',
    'endsAt',
  ],
  columns: [
    'id',
    'createdAt',
    'productId',
    'product',
    'actorId',
    'actor',
    'event',
    'oldPrice',
    'newPrice',
    'mode',
    'value',
    'endsAt',
  ],
  seed: async () => {
    const owner = await newUser({ role: 'ADMIN' });
    const product = await createProduct({ price: 10 });
    for (const line of PRICE_LINES) await priceLine(owner, product.id, line);
    return {
      narrow: `productId=${product.id}&actorId=${owner.id}`,
      events: PRICE_LINES.map((line) => line.event),
    };
  },
  header: (columns) =>
    columns
      .flatMap((column) => {
        if (column === 'product') return ['productName'];
        if (column === 'actor') return ['actorName', 'actorEmail'];
        return [column];
      })
      .join(','),
};

const LOGIN_LINES = [
  { event: 'login.password', ipAddress: '198.51.100.1', userAgent: 'Agent a' },
  { event: 'login.google', ipAddress: null, userAgent: null },
  { event: 'login.github', ipAddress: '198.51.100.7', userAgent: 'Agent c' },
  { event: 'login.linkedin', ipAddress: '198.51.100.3', userAgent: null },
];

const LOGIN: Journal = {
  name: 'the log of logins',
  path: 'login-log',
  sorts: ['id', 'createdAt', 'userId', 'email', 'role', 'ipAddress', 'userAgent', 'event'],
  columns: [
    'id',
    'createdAt',
    'userId',
    'user',
    'email',
    'role',
    'ipAddress',
    'userAgent',
    'event',
  ],
  seed: async () => {
    const person = await newUser();
    for (const [index, line] of LOGIN_LINES.entries()) {
      await testTx(async (tx) => {
        await setUserContext(tx, { userId: person.id, role: 'USER' });
        await tx.loginLog.create({
          data: {
            userId: person.id,
            email: person.email,
            role: 'USER',
            ipAddress: line.ipAddress,
            userAgent: line.userAgent,
            event: line.event,
            createdAt: new Date(Date.now() - (LOGIN_LINES.length - index) * 60_000),
          },
        });
      });
    }
    return { narrow: `userId=${person.id}`, events: LOGIN_LINES.map((line) => line.event) };
  },
  header: (columns) =>
    columns
      .flatMap((column) => (column === 'user' ? ['userName', 'userDeleted'] : [column]))
      .join(','),
};

// ---------------------------------------------------------------- the same for each journal

// a value to compare: numbers as numbers, the rest as text
const comparable = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === 'number' ? value : String(value);

// the lines are in the order of the column, the lines without a value last, whichever way it goes
function expectSorted(items: Record<string, unknown>[], column: string, order: 'asc' | 'desc') {
  const values = items.map((item) => comparable(item[column]));
  const present = values.filter((value) => value !== null);
  const firstNull = values.indexOf(null);
  if (firstNull >= 0) expect(values.slice(firstNull).every((value) => value === null)).toBe(true);

  const ordered = [...present].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  if (order === 'desc') ordered.reverse();
  expect(present).toEqual(ordered);
}

describe.each([AUDIT, PRICE, LOGIN])('$name', (journal) => {
  it('gives every column of every line unless columns are asked for, newest first by default', async () => {
    const { narrow } = await journal.seed();

    const page = await all(journal.path, narrow);

    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(4);
    for (const item of page.items)
      expect(Object.keys(item).sort()).toEqual([...journal.columns].sort());
    expectSorted(page.items, 'createdAt', 'desc');
  });

  it('sorts by every simple column both ways, and the cursor walks the lines in the same order', async () => {
    const { narrow } = await journal.seed();

    for (const sortBy of journal.sorts) {
      for (const sortOrder of ['asc', 'desc'] as const) {
        const query = `${narrow}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

        const whole = await all(journal.path, query);
        const walked = await walk(journal.path, query);

        expect(whole.items).toHaveLength(4);
        expectSorted(whole.items, sortBy, sortOrder);
        // the same lines in the same order, page by page
        expect(walked.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
      }
    }
  });

  it('gives the columns asked for, in the page and in the csv', async () => {
    const { narrow } = await journal.seed();
    const asked = ['event', 'id'];

    const page = await all(journal.path, `${narrow}&columns=${asked.join(',')}`);
    const csv = await read(journal.path, `${narrow}&columns=${asked.join(',')}&format=csv`);

    for (const item of page.items) expect(Object.keys(item).sort()).toEqual(['event', 'id']);
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    // the order of the journal, not the order of the request
    expect(lines[0]).toBe(journal.header(['id', 'event']));
    expect(lines).toHaveLength(5);
  });

  it('gives the csv of every line with the header of all the columns', async () => {
    const { narrow } = await journal.seed();

    const csv = await read(journal.path, `${narrow}&format=csv&sortBy=event`);

    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`cartlify-`);
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(journal.header(journal.columns));
    expect(lines).toHaveLength(5);
  });

  it('keeps the lines of the events asked for and counts only them', async () => {
    const { narrow, events } = await journal.seed();

    const some = await all(journal.path, `${narrow}&events=${events[0]},${events[2]}`);
    const none = await all(journal.path, `${narrow}&events=legacy.unknown`);

    expect(some.total).toBe(2);
    expect(some.items.map((item) => item.event).sort()).toEqual([events[0], events[2]].sort());
    expect(none.total).toBe(0);
  });

  it('refuses a column or an event the journal has not, and names what it has', async () => {
    const column = await read(journal.path, 'columns=id,secret');
    const event = await read(journal.path, 'events=product.update,nothing.here');

    expect(column.statusCode).toBe(400);
    expect(column.json()).toMatchObject({
      errorCode: 'LOG_COLUMNS_INVALID',
      details: { columns: ['secret'], allowed: journal.columns },
    });
    expect(event.statusCode).toBe(400);
    expect(event.json()).toMatchObject({
      errorCode: 'LOG_EVENTS_INVALID',
      details: { events: expect.arrayContaining(['nothing.here']) },
    });
  });

  it('refuses a sort by a column the journal does not sort by', async () => {
    const res = await read(journal.path, 'sortBy=changes');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('reads a period: from taken in, to left out', async () => {
    const { narrow } = await journal.seed();
    const now = Date.now();

    const inside = await all(
      journal.path,
      `${narrow}&from=${new Date(now - 2 * DAY).toISOString()}&to=${new Date(now + DAY).toISOString()}`,
    );
    const before = await all(journal.path, `${narrow}&to=${new Date(now - 2 * DAY).toISOString()}`);
    const after = await all(
      journal.path,
      `${narrow}&from=${new Date(now + 2 * DAY).toISOString()}`,
    );

    expect(inside.total).toBe(4);
    expect(before.total).toBe(0);
    expect(after.total).toBe(0);
  });

  it('refuses a cursor made for another sort', async () => {
    const { narrow } = await journal.seed();
    const first = await pageOf(journal.path, `${narrow}&limit=1&sortBy=event`);

    const res = await read(journal.path, `${narrow}&limit=1&sortBy=id&cursor=${first.nextCursor}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('refuses a customer', async () => {
    const res = await read(journal.path, '', buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await read(
      journal.path,
      'from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z',
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });
});

// ---------------------------------------------------------------- root is hidden from an admin

describe('what the journals say of root', () => {
  // an admin sees the lines root sees, with the same filters; in place of who root is, the word
  // hidden and an id of 0, the role stays
  const hiddenAccount = { id: 0, email: 'hidden', role: 'ROOT' };
  const nameHidden = (name: unknown) => expect([null, 'hidden']).toContain(name);

  it('hides who root is in the admin log from an admin, and shows it to root', async () => {
    const productId = (await createProduct({ price: 10 })).id;
    await auditLine(
      root,
      {
        entityType: 'product',
        entityId: productId,
        action: 'PRODUCT_UPDATE',
        event: 'product.update',
        ip: '203.0.113.50',
      },
      'Root browser',
    );
    const query = `entityType=product&entityId=${productId}`;

    const seenByAdmin = (await all('audit-log', query)).items[0]!;
    const seenByRoot = (await all('audit-log', query, root)).items[0]!;

    expect(seenByAdmin).toMatchObject({
      actorId: 0,
      actor: hiddenAccount,
      // the role stays: it is no secret who did it as root, only who root is
      actorRole: 'ROOT',
      event: 'product.update',
      entityId: productId,
      ip: 'hidden',
      userAgent: 'hidden',
    });
    nameHidden((seenByAdmin.actor as { name: unknown }).name);
    expect(seenByRoot).toMatchObject({
      actorId: root.id,
      actor: { id: root.id, email: root.email, role: 'ROOT' },
      ip: '203.0.113.50',
      userAgent: 'Root browser',
    });
    // the same fields for both: only the values differ
    expect(Object.keys(seenByAdmin).sort()).toEqual(Object.keys(seenByRoot).sort());
  });

  it.each(['ip', 'userAgent', 'actorId'])(
    'does not carry the value of a line of root in the cursor an admin is given when it sorts by %s',
    async (sortBy) => {
      const productId = (await createProduct({ price: 10 })).id;
      for (const ip of ['203.0.113.77', '203.0.113.76']) {
        await auditLine(
          root,
          {
            entityType: 'product',
            entityId: productId,
            action: 'PRODUCT_UPDATE',
            event: 'product.update',
            ip,
          },
          'Root browser 77',
        );
      }

      const page = await pageOf(
        'audit-log',
        `entityType=product&entityId=${productId}&sortBy=${sortBy}&sortOrder=desc&limit=1`,
      );

      expect(page.nextCursor).not.toBeNull();
      const cursor = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'));
      // the id of the line and the sort, no value of the line
      expect(Object.keys(cursor).sort()).toEqual(['id', 's']);
      expect(JSON.stringify(cursor)).not.toContain('203.0.113');
      expect(JSON.stringify(cursor)).not.toContain('Root browser');
      expect(JSON.stringify(cursor)).not.toContain(root.email);
    },
  );

  it('finds the lines of root by its account for an admin as for root, who root is hidden', async () => {
    const productId = (await createProduct({ price: 10 })).id;
    await auditLine(root, {
      entityType: 'product',
      entityId: productId,
      action: 'PRODUCT_UPDATE',
      event: 'product.update',
      ip: null,
    });
    const query = `actorId=${root.id}&entityType=product&entityId=${productId}`;

    const forAdmin = await all('audit-log', query);
    const forRoot = await all('audit-log', query, root);

    expect(forAdmin.total).toBe(1);
    expect(forRoot.total).toBe(1);
    expect(forAdmin.items[0]).toMatchObject({ actorId: 0, actor: hiddenAccount, ip: null });
  });

  it('hides the id and the values of the changes of a line about the account of root from an admin', async () => {
    const owner = await newUser({ role: 'ADMIN' });
    await auditLine(owner, {
      entityType: 'user',
      entityId: root.id,
      action: 'OTHER',
      event: 'user.delete',
      ip: null,
    });

    const seenByAdmin = (await all('audit-log', `actorId=${owner.id}`)).items[0]!;
    const seenByRoot = (await all('audit-log', `actorId=${owner.id}`, root)).items[0]!;
    const byThingForAdmin = await all('audit-log', `entityType=user&entityId=${root.id}`);
    const byThingForRoot = await all('audit-log', `entityType=user&entityId=${root.id}`, root);
    const byFieldForAdmin = await all('audit-log', `actorId=${owner.id}&field=name`);
    const byFieldForRoot = await all('audit-log', `actorId=${owner.id}&field=name`, root);

    // the field is named, the values are not
    expect(seenByAdmin).toMatchObject({
      entityType: 'user',
      entityId: 0,
      changes: [{ field: 'name', old: 'hidden', new: 'hidden' }],
    });
    expect(seenByRoot).toMatchObject({
      entityType: 'user',
      entityId: root.id,
      changes: [{ field: 'name', old: 'a', new: 'b' }],
    });
    // the same lines for both
    expect(byThingForAdmin.total).toBe(byThingForRoot.total);
    expect(byThingForAdmin.total).toBeGreaterThan(0);
    expect(byFieldForAdmin.total).toBe(1);
    expect(byFieldForRoot.total).toBe(1);
  });

  it('hides who root is in the log of prices from an admin, and finds its lines by the account', async () => {
    const product = await createProduct({ price: 10 });
    await priceLine(root, product.id, PRICE_LINES[0]!);
    const query = `productId=${product.id}`;

    const seenByAdmin = (await all('price-log', query)).items[0]!;
    const seenByRoot = (await all('price-log', query, root)).items[0]!;
    const byAccount = await all('price-log', `${query}&actorId=${root.id}`);

    expect(seenByAdmin).toMatchObject({ actorId: 0, actor: hiddenAccount, event: 'price.set' });
    expect(seenByRoot).toMatchObject({ actorId: root.id, actor: { id: root.id } });
    expect(byAccount.total).toBe(1);
  });

  it('hides who root is in the history of the price of a product from an admin, the role stays', async () => {
    const product = await createProduct({ price: 10 });
    await priceLine(root, product.id, PRICE_LINES[0]!);
    const history = (actor: TestUser) =>
      app.inject({
        method: 'GET',
        url: `/api/products/${product.id}/price-history`,
        headers: { cookie: accessCookie(actor) },
      });

    const seenByAdmin = (await history(admin)).json().items[0];
    const seenByRoot = (await history(root)).json().items[0];

    expect(seenByAdmin.actor).toMatchObject({ id: 0, role: 'ROOT', deleted: false });
    nameHidden(seenByAdmin.actor.name);
    expect(seenByRoot.actor).toMatchObject({ id: root.id, role: 'ROOT' });
  });

  it('hides who root is in the log of logins from an admin, and finds its logins as root does', async () => {
    const fresh = await newUser({ role: 'ROOT' });
    const res = await logIn(app, csrf, { email: fresh.email, password: fresh.password });
    expect(res.statusCode).toBe(200);

    const seenByRoot = (await all('login-log', `userId=${fresh.id}`, root)).items[0]!;
    const byAccount = await all('login-log', `userId=${fresh.id}`);
    const byEmail = await all('login-log', `email=${encodeURIComponent(fresh.email)}`);

    expect(byAccount.total).toBe(1);
    expect(byEmail.total).toBe(1);
    expect(seenByRoot).toMatchObject({
      userId: fresh.id,
      email: fresh.email,
      role: 'ROOT',
      event: 'login.password',
      user: { id: fresh.id, role: 'ROOT' },
    });
    expect(seenByRoot.ipAddress).not.toBeNull();
    const seenByAdmin = byAccount.items[0]!;
    expect(seenByAdmin).toMatchObject({
      userId: 0,
      email: 'hidden',
      role: 'ROOT',
      event: 'login.password',
      user: { ...hiddenAccount, deleted: false },
      ipAddress: 'hidden',
    });
    expect([null, 'hidden']).toContain(seenByAdmin.userAgent);
  });
});

describe('GET /api/admin/log-events', () => {
  it('lists the events of each journal, the one of the old lines among them', async () => {
    const res = await read('log-events', '');

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string[]>;
    expect(Object.keys(body).sort()).toEqual(['auditLog', 'consentLog', 'loginLog', 'priceLog']);
    expect(body.auditLog).toEqual(
      expect.arrayContaining(['product.update_batch', 'order.ship_bulk']),
    );
    expect(body.priceLog).toEqual(expect.arrayContaining(['price.set', 'price.bulk']));
    expect(body.loginLog).toEqual(
      expect.arrayContaining(['login.password', 'login.google', 'login.github', 'login.linkedin']),
    );
    expect(body.consentLog).toEqual(expect.arrayContaining(['consent.register', 'consent.order']));
    for (const events of Object.values(body)) expect(events).toContain('legacy.unknown');
  });

  it('refuses a customer', async () => {
    const res = await read('log-events', '', buyer);

    expect(res.statusCode).toBe(403);
  });
});
