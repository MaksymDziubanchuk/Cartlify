import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { prisma } from '@db/client.js';

import { asAdmin, inCommittedTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueEmail,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail } from '../../../helpers/mail.js';
import {
  answerAsGithub,
  callback,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  startLogin,
  type Provider,
} from '../../../helpers/oauth.js';
import { placeOrder, shippingData } from '../../../helpers/orders.js';
import { openPaymentPage, orderStateOf, payPage } from '../../../helpers/payments.js';
import { closeOpenSessions, deliver } from '../../../helpers/stripe.js';

// the terms and the contract of the shop. Root publishes a version of each (POST
// /api/root/legal-documents), everybody reads the versions in force; a customer accepts them when
// registering, or later with POST /api/legal/acceptances (an account made by a provider, a new
// version); an order is confirmed only by a customer who accepted the versions in force, and the
// mail after the payment carries their texts. A version in force is for the whole shop and cannot
// be taken back: this file runs last and alone (.shopwide.test.ts, tests/setup/sequencer.mjs)

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await newUser({ role: 'ROOT' });
  admin = await newUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Kind = 'terms' | 'contract';
type LegalDocument = {
  id: number;
  kind: Kind;
  version: number;
  title: string;
  content: string;
  sha256: string;
  publishedAt: string;
};

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const publish = (actor: TestUser, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/root/legal-documents',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

async function published(kind: Kind, content = `The ${kind} of the shop, ${Date.now()}.`) {
  const res = await publish(root, { kind, title: `The ${kind}`, content });
  expect(res.statusCode).toBe(201);
  return res.json() as LegalDocument;
}

const currentDocuments = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/legal/documents/current' });
  expect(res.statusCode).toBe(200);
  return res.json().items as LegalDocument[];
};

const currentIds = async () => (await currentDocuments()).map((doc) => doc.id);

// the versions in force the way a refusal names them: a checkbox for each, its text by its id
const inForce = (docs: LegalDocument[]) =>
  docs.map(({ id, kind, version, title }) => ({ id, kind, version, title }));

const statusOf = (user: TestUser) =>
  app.inject({
    method: 'GET',
    url: '/api/legal/acceptances/me',
    headers: { cookie: accessCookie(user) },
  });

const acceptAs = (user: TestUser, documentIds: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/legal/acceptances',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { documentIds },
  });

const register = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/auth/register', headers: withCsrf(csrf), payload });

const consentsOf = (userId: number) =>
  asAdmin((tx) =>
    tx.legalAcceptance.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
      select: { documentId: true, orderId: true, ip: true, userAgent: true },
    }),
  );

// a customer who accepted the versions in force
async function consentingUser() {
  const user = await newUser();
  expect((await acceptAs(user, await currentIds())).statusCode).toBe(200);
  return user;
}

// a cart of the user with one unit of a product, read back for its id
async function cartOf(user: TestUser) {
  const product = await createProduct({ price: 10, stock: 5 });
  const headers = withCsrf(csrf, accessCookie(user));
  const added = await app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers,
    payload: { productId: product.id, quantity: 1 },
  });
  expect(added.statusCode).toBe(200);
  const cart = await app.inject({
    method: 'GET',
    url: '/api/orders/current',
    headers: { cookie: accessCookie(user) },
  });
  return cart.json().id as number;
}

const confirm = (user: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });

describe('POST /api/root/legal-documents', () => {
  it('publishes a version of the terms for root, numbered after the last one', async () => {
    const before = (await currentDocuments()).find((doc) => doc.kind === 'terms')?.version ?? 0;
    const content = 'The terms of the shop.\nThe second line.';

    const res = await publish(root, { kind: 'terms', title: 'Terms of use', content });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      kind: 'terms',
      version: before + 1,
      title: 'Terms of use',
      content,
      sha256: sha256(content),
      publishedAt: expect.any(String),
    });
  });

  it('numbers each kind on its own', async () => {
    const before = await currentDocuments();
    const versionOf = (kind: Kind) => before.find((doc) => doc.kind === kind)?.version ?? 0;

    const contract = await published('contract');
    const terms = await published('terms');

    expect(contract.version).toBe(versionOf('contract') + 1);
    expect(terms.version).toBe(versionOf('terms') + 1);
  });

  it('keeps the title without the spaces at its edges and the text as it was sent', async () => {
    const content = '\n  The contract, word for word.  \n';

    const res = await publish(root, { kind: 'contract', title: '  The contract  ', content });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: 'The contract', content, sha256: sha256(content) });
  });

  it.each([
    ['a kind there is not', { kind: 'policy', title: 'T', content: 'C' }],
    ['no title', { kind: 'terms', content: 'C' }],
    ['an empty text', { kind: 'terms', title: 'T', content: '' }],
    ['a title past 200 characters', { kind: 'terms', title: 'T'.repeat(201), content: 'C' }],
    ['a text past 200 000 characters', { kind: 'terms', title: 'T', content: 'w'.repeat(200_001) }],
  ])('refuses %s', async (_case, payload) => {
    const res = await publish(root, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it.each([
    ['a title', { kind: 'terms', title: '   ', content: 'C' }],
    ['a text', { kind: 'terms', title: 'T', content: ' \n ' }],
  ])('refuses %s of spaces only (LEGAL_DOCUMENT_EMPTY)', async (_case, payload) => {
    const res = await publish(root, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LEGAL_DOCUMENT_EMPTY' });
  });

  it.each([
    ['an admin', () => admin],
    ['a user', () => newUser()],
  ])('refuses %s', async (_case, who) => {
    const res = await publish(await who(), { kind: 'terms', title: 'T', content: 'C' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('GET /api/root/legal-documents', () => {
  const history = (actor: TestUser, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/root/legal-documents${query}`,
      headers: { cookie: accessCookie(actor) },
    });

  it('lists every version, the latest first, without the text, with who published it', async () => {
    const last = await published('terms');

    const res = await history(root);

    expect(res.statusCode).toBe(200);
    const [first] = res.json().items as Array<Record<string, unknown>>;
    expect(first).toEqual({
      id: last.id,
      kind: 'terms',
      version: last.version,
      title: last.title,
      sha256: last.sha256,
      publishedAt: last.publishedAt,
      publishedBy: { id: root.id, name: null, email: root.email },
    });
  });

  it('keeps the versions of one kind and goes page by page', async () => {
    await published('contract');
    await published('contract');

    const first = await history(root, '?kind=contract&limit=1');
    const second = await history(root, `?kind=contract&limit=1&cursor=${first.json().nextCursor}`);

    expect(first.json().items).toHaveLength(1);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0].id).toBeLessThan(first.json().items[0].id);
    expect(
      [...first.json().items, ...second.json().items].every(
        (doc: { kind: string }) => doc.kind === 'contract',
      ),
    ).toBe(true);
  });

  it('refuses an admin', async () => {
    const res = await history(admin);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('the versions in force', () => {
  it('gives a guest the latest version of each kind with its text', async () => {
    const terms = await published('terms');
    const contract = await published('contract');

    expect(await currentDocuments()).toEqual([terms, contract]);
  });

  it('gives any version by its id, an old one too', async () => {
    const old = await published('terms', 'An old text of the terms.');
    await published('terms');

    const res = await app.inject({ method: 'GET', url: `/api/legal/documents/${old.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(old);
  });

  it('answers LEGAL_DOCUMENT_NOT_FOUND for a version that is not there', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/legal/documents/2147483000' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'LEGAL_DOCUMENT_NOT_FOUND' });
  });
});

describe('the consent at the registration', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    email: uniqueEmail('legal'),
    password: 'secret-password-1',
    ...extra,
  });

  it('refuses a registration without the consent to the versions in force', async () => {
    const res = await register(body());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
      details: { kinds: ['terms', 'contract'], current: inForce(await currentDocuments()) },
    });
  });

  it('names the kind that is missing', async () => {
    const [terms] = await currentDocuments();

    const res = await register(body({ acceptedDocumentIds: [terms!.id] }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
      details: { kinds: ['contract'] },
    });
  });

  it('refuses a version that is no longer in force and names the ones in force', async () => {
    const old = await published('contract');
    await published('contract');
    const current = await currentDocuments();
    const terms = current.find((doc) => doc.kind === 'terms')!;

    const res = await register(body({ acceptedDocumentIds: [terms.id, old.id] }));

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_VERSION_OUTDATED',
      details: { current: inForce(current) },
    });
  });

  it('refuses a version that is not there', async () => {
    const res = await register(
      body({ acceptedDocumentIds: [...(await currentIds()), 2147483000] }),
    );

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'LEGAL_DOCUMENT_NOT_FOUND' });
  });

  it('keeps the consent with the address and the browser of the request', async () => {
    const ids = await currentIds();

    const res = await register(body({ acceptedDocumentIds: ids }));

    expect(res.statusCode).toBe(201);
    const user: TestUser = {
      id: res.json().id,
      email: res.json().email,
      password: '',
      role: 'USER',
    };
    userIds.push(user.id);
    expect(await consentsOf(user.id)).toEqual(
      ids.map((documentId) => ({
        documentId,
        orderId: null,
        ip: '127.0.0.1',
        userAgent: 'lightMyRequest',
      })),
    );
    expect((await statusOf(user)).json()).toMatchObject({ required: [] });
  });
});

describe('the consent later', () => {
  it('names what an account made without the form has to accept', async () => {
    const user = await newUser();
    const current = await currentDocuments();

    const res = await statusOf(user);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      current: current.map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        version: doc.version,
        title: doc.title,
      })),
      accepted: [],
      required: ['terms', 'contract'],
    });
  });

  it('keeps the consent to the versions in force, once', async () => {
    const user = await newUser();
    const ids = await currentIds();

    const first = await acceptAs(user, ids);
    const again = await acceptAs(user, ids);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ required: [] });
    expect(first.json().accepted.map((row: { documentId: number }) => row.documentId)).toEqual(ids);
    expect(again.statusCode).toBe(200);
    expect(await consentsOf(user.id)).toHaveLength(2);
  });

  it('asks for the consent to a new version only', async () => {
    const user = await consentingUser();
    const terms = await published('terms');

    const res = await statusOf(user);

    expect(res.json()).toMatchObject({ required: ['terms'] });
    expect((await acceptAs(user, [terms.id])).json()).toMatchObject({ required: [] });
  });

  it('refuses a version that is no longer in force', async () => {
    const old = await published('terms');
    await published('terms');

    const res = await acceptAs(await newUser(), [old.id]);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'LEGAL_VERSION_OUTDATED' });
  });

  it('refuses a version that is not there', async () => {
    const res = await acceptAs(await newUser(), [2147483000]);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'LEGAL_DOCUMENT_NOT_FOUND' });
  });

  it.each([[[]], [[1, 1]], ['one']])('refuses the list %p', async (documentIds) => {
    const res = await acceptAs(await newUser(), documentIds);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses an admin', async () => {
    const res = await acceptAs(admin, await currentIds());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('POST /api/orders/current/confirm and the consent', () => {
  // the page shows a checkbox for each version named, opens its text by its id, and the customer
  // accepts and confirms again
  it('refuses an order of a customer who did not accept the versions in force', async () => {
    const user = await newUser();
    const orderId = await cartOf(user);
    const current = await currentDocuments();

    const res = await confirm(user, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: 409,
      errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
      message: expect.any(String),
      reqId: expect.any(String),
      details: { kinds: ['terms', 'contract'], current: inForce(current) },
    });
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'pending' });

    for (const { id } of res.json().details.current) {
      const text = await app.inject({ method: 'GET', url: `/api/legal/documents/${id}` });
      expect(text.json()).toMatchObject({ id, content: expect.any(String) });
    }
    expect(
      (
        await acceptAs(
          user,
          current.map((doc) => doc.id),
        )
      ).statusCode,
    ).toBe(200);
    expect((await confirm(user, orderId)).statusCode).toBe(200);
  });

  it('refuses it after a new version until the customer accepts it', async () => {
    const user = await consentingUser();
    const orderId = await cartOf(user);
    const contract = await published('contract');

    const refused = await confirm(user, orderId);
    await acceptAs(user, [contract.id]);
    const confirmed = await confirm(user, orderId);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { kinds: ['contract'] } });
    expect(confirmed.statusCode).toBe(200);
  });

  it('keeps the versions the order was confirmed with', async () => {
    const user = await consentingUser();
    const ids = await currentIds();

    const orderId = await placeOrder(
      app,
      csrf,
      user,
      await createProduct({ price: 10 }),
      'waiting',
    );

    const links = (await consentsOf(user.id)).filter((row) => row.orderId === orderId);
    expect(links.map((row) => row.documentId)).toEqual(ids);
  });
});

// the mail of the payment carries the versions of the terms and of the contract the order was
// confirmed with: the copy of the contract the buyer keeps. No other mail comes for them
describe('the mail of the payment', () => {
  // an order confirmed and paid; beforePayment runs between the two
  async function paidOrderOf(user: TestUser, beforePayment?: () => Promise<unknown>) {
    const orderId = await placeOrder(
      app,
      csrf,
      user,
      await createProduct({ price: 10, stock: 5 }),
      'waiting',
    );
    await beforePayment?.();
    const sessionId = await openPaymentPage(app, csrf, user, orderId);
    const { event } = await payPage(sessionId);
    expect((await deliver(app, event)).statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'paid' });
    return orderId;
  }

  it('attaches the terms and the contract the order was confirmed with, in one mail', async () => {
    const terms = await published('terms', 'The terms the buyer accepted.');
    const contract = await published('contract', 'The contract the buyer accepted.');
    const user = await consentingUser();
    const mails = watchMail();

    // a version published after the order was confirmed is not its contract
    const orderId = await paidOrderOf(user, () =>
      published('contract', 'A contract the order was not made under.'),
    );

    const own = mails.filter((mail) => mail.to.includes(user.email));
    expect(own).toHaveLength(1);
    expect(own[0]!.subject).toContain(`Order #${orderId} is paid`);
    expect(own[0]!.text).toContain(
      'The terms and the contract you accepted are attached to this mail.',
    );
    // the files of the mail; the logo goes inline, as in every mail of the shop
    expect(own[0]!.attachments.filter((file) => file.disposition === 'attachment')).toEqual([
      { filename: 'terms.txt', type: 'text/plain', disposition: 'attachment', text: terms.content },
      {
        filename: 'contract.txt',
        type: 'text/plain',
        disposition: 'attachment',
        text: contract.content,
      },
    ]);
  });

  it('only logs a mail that fails, the order stays paid', async () => {
    const user = await consentingUser();
    refuseMail();

    await paidOrderOf(user);

    expect(takeLogs({ msg: 'order paid mail was not sent' })).toHaveLength(1);
  });
});

describe('GET /api/users/me/export', () => {
  it('gives the customer their consents', async () => {
    const user = await consentingUser();
    const current = await currentDocuments();

    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me/export',
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().legalAcceptances).toEqual(
      current.map((doc) => ({
        documentId: doc.id,
        kind: doc.kind,
        version: doc.version,
        title: doc.title,
        orderId: null,
        ip: '127.0.0.1',
        userAgent: 'lightMyRequest',
        createdAt: expect.any(String),
      })),
    );
  });
});

// a step one transaction waits for until the test lets it go on
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

// a statement of another transaction waits for the lock the versions of a kind are published under
async function waitsForVersionsOf(kind: Kind): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from pg_locks
    where locktype = 'advisory' and not granted and objsubid = 1
      and objid::bigint = (hashtext(${`cartlify.legal_documents:${kind}`})::bigint & 4294967295)
  `;
  return rows[0]!.n > 0;
}

// until a statement waits for that lock, or the work that might have waited is over
async function untilWaiting(kind: Kind, work: Promise<unknown>) {
  let over = false;
  void work.then(
    () => (over = true),
    () => (over = true),
  );
  for (let tries = 0; tries < 400; tries++) {
    if (over || (await waitsForVersionsOf(kind))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nothing waited for the versions of ${kind}`);
}

const insertVersion = (kind: Kind) =>
  `insert into cartlify.legal_documents (kind, title, content, "publishedById")
   values ('${kind}'::cartlify."LegalDocumentKind", 'The ${kind}', $1, $2)
   returning id, version, "createdAt"`;

type VersionRow = { id: number; version: number; createdAt: Date };

// a version and a consent written at the same time: the consent is to the version in force at the
// moment it is written, and a version is dated after every consent to the one before it
describe('a version published while a consent is written', () => {
  it('refuses the consent to the version it put out of force and names the new one', async () => {
    const user = await newUser();
    const before = await currentIds();
    const written = gate();
    const commit = gate();

    const publishing = inCommittedTx(async (db) => {
      await db.as({ role: 'ROOT', userId: root.id });
      const [row] = await db.rows<VersionRow>(
        insertVersion('terms'),
        `The terms, ${Date.now()}.`,
        root.id,
      );
      written.open();
      await commit.opened;
      return row!;
    });
    await written.opened;

    // the versions the customer read are still the ones in force: the new one is not committed
    const consenting = acceptAs(user, before);
    await untilWaiting('terms', consenting);
    commit.open();
    const terms = await publishing;
    const res = await consenting;

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_VERSION_OUTDATED',
      details: {
        current: expect.arrayContaining([
          { id: terms.id, kind: 'terms', version: terms.version, title: 'The terms' },
        ]),
      },
    });
    expect(await consentsOf(user.id)).toEqual([]);
  });

  it('dates a new version after every consent given to the one before it', async () => {
    const user = await newUser();
    const terms = (await currentDocuments()).find((doc) => doc.kind === 'terms')!;
    const begun = gate();
    const consented = gate();

    // the transaction of root begins before the consent: a version dated by the start of its
    // transaction would come before a consent to the version it replaces
    const publishing = inCommittedTx(async (db) => {
      await db.as({ role: 'ROOT', userId: root.id });
      begun.open();
      await consented.opened;
      const [row] = await db.rows<VersionRow>(
        insertVersion('terms'),
        `The terms, ${Date.now()}.`,
        root.id,
      );
      return row!;
    });
    await begun.opened;

    const consent = await inCommittedTx(async (db) => {
      await db.as({ role: 'USER', userId: user.id });
      const [row] = await db.rows<{ createdAt: Date }>(
        `insert into cartlify.legal_acceptances ("userId", "documentId")
         values ($1, $2) returning "createdAt"`,
        user.id,
        terms.id,
      );
      consented.open();
      await untilWaiting('terms', publishing);
      return row!;
    });
    const version = await publishing;

    expect(consent.createdAt.getTime()).toBeLessThan(version.createdAt.getTime());
  });
});

// a login by a provider makes an account the way a registration does: with the consent to every
// version in force, which the page of the shop sends with the start of the login and the signed
// state carries to the callback. Without it no account is made and the page gets the code to
// show the checkboxes and start again. A login to an account the shop has asks for the versions
// that came in force since, the way a login with a password does
describe('a login by Google, GitHub or LinkedIn and the consent', () => {
  const PROVIDERS: Provider[] = ['google', 'github', 'linkedin'];
  // one key of each provider for the file: the keys of the provider are read once
  const idps = { google: oidcProvider('google'), linkedin: oidcProvider('linkedin') };
  let githubId = Number(`${Date.now()}`.slice(-8)) + 7_000_000;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  type Account = { provider: Provider; email: string; sub: string };

  const newAccount = (provider: Provider): Account => ({
    provider,
    email: uniqueEmail(`legal-${provider}`),
    sub: provider === 'github' ? String(++githubId) : `${provider}-${uniqueTag()}`,
  });

  // the provider answers for the account, the whole login runs in one browser
  async function loginBy(who: Account, query: Record<string, string> = {}) {
    if (who.provider === 'github') {
      answerAsGithub({
        id: Number(who.sub),
        name: 'Octo Legal',
        emails: [{ email: who.email, primary: true, verified: true }],
      });
    } else {
      const idp = idps[who.provider];
      idp.answer(
        idp.idToken({ sub: who.sub, email: who.email, email_verified: true, name: 'Legal Test' }),
      );
    }

    const { guestId, state } = await startLogin(app, who.provider, '', query);
    return callback(app, who.provider, { code: 'test-code', state }, cookieHeader({ guestId }));
  }

  async function accountOf(email: string) {
    const row = await asAdmin((tx) =>
      tx.user.findUnique({ where: { email }, select: { id: true } }),
    );
    if (row) userIds.push(row.id);
    return row;
  }

  it.each(PROVIDERS)(
    'makes no account by %s without the consent to the versions in force',
    async (provider) => {
      const who = newAccount(provider);

      const res = await loginBy(who);

      expect(landing(res)).toEqual({
        status: 302,
        page: FRONTEND_CALLBACK,
        error: 'LEGAL_ACCEPTANCE_REQUIRED',
      });
      expect(setCookies(res).accessToken).toBeUndefined();
      expect(await accountOf(who.email)).toBeNull();
    },
  );

  it.each(PROVIDERS)(
    'makes the account by %s with the consent the login started with',
    async (provider) => {
      const who = newAccount(provider);
      const ids = await currentIds();

      const res = await loginBy(who, { acceptedDocumentIds: ids.join(',') });

      expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
      expect(setCookies(res).accessToken).toBeDefined();
      const account = await accountOf(who.email);
      expect(await consentsOf(account!.id)).toEqual(
        ids.map((documentId) => ({
          documentId,
          orderId: null,
          ip: '127.0.0.1',
          userAgent: 'lightMyRequest',
        })),
      );
    },
  );

  it('makes no account with a version no longer in force', async () => {
    const old = await published('terms');
    await published('terms');
    const contract = (await currentDocuments()).find((doc) => doc.kind === 'contract')!;
    const who = newAccount('google');

    const res = await loginBy(who, { acceptedDocumentIds: `${old.id},${contract.id}` });

    expect(landing(res).error).toBe('LEGAL_VERSION_OUTDATED');
    expect(await accountOf(who.email)).toBeNull();
  });

  it('makes no account with a version that is not there', async () => {
    const who = newAccount('linkedin');

    const res = await loginBy(who, {
      acceptedDocumentIds: [...(await currentIds()), 9999999999].join(','),
    });

    expect(landing(res).error).toBe('LEGAL_DOCUMENT_NOT_FOUND');
    expect(await accountOf(who.email)).toBeNull();
  });

  it('lets in an account the shop has that accepted the versions in force', async () => {
    const who = newAccount('github');
    await loginBy(who, { acceptedDocumentIds: (await currentIds()).join(',') });
    const account = await accountOf(who.email);
    const consents = await consentsOf(account!.id);

    const res = await loginBy(who);

    expect(landing(res).error).toBeNull();
    expect(setCookies(res).accessToken).toBeDefined();
    expect(await consentsOf(account!.id)).toEqual(consents);
  });

  it('asks an account the shop has for a version that came in force since, then lets it in', async () => {
    const who = newAccount('google');
    await loginBy(who, { acceptedDocumentIds: (await currentIds()).join(',') });
    const account = await accountOf(who.email);
    const before = await consentsOf(account!.id);
    const contract = await published('contract');

    const refused = await loginBy(who);
    const accepted = await loginBy(who, { acceptedDocumentIds: String(contract.id) });

    expect(landing(refused).error).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(setCookies(refused).accessToken).toBeUndefined();
    expect(landing(accepted).error).toBeNull();
    expect(setCookies(accepted).accessToken).toBeDefined();
    expect((await consentsOf(account!.id)).map((row) => row.documentId)).toEqual([
      ...before.map((row) => row.documentId),
      contract.id,
    ]);
  });

  it.each(['one', '1,,2', '0', '1;2'])(
    'refuses to start a login with the list %p',
    async (list) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/google?acceptedDocumentIds=${encodeURIComponent(list)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );
});

// a customer who logs out and comes back after a new version came in force accepts it at the
// login: the login answers which versions, the page shows a checkbox for each and logs in again
// with them. The order keeps its own check, a session open since before the version is asked there
describe('POST /api/auth/login and the consent', () => {
  const loginAs = (user: TestUser, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: withCsrf(csrf),
      payload: { email: user.email, password: user.password, ...extra },
    });

  it('refuses a customer who did not accept the versions in force and names them', async () => {
    const user = await newUser();

    const res = await loginAs(user);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
      details: { kinds: ['terms', 'contract'], current: inForce(await currentDocuments()) },
    });
    expect(setCookies(res).accessToken).toBeUndefined();
    expect(setCookies(res).refreshToken).toBeUndefined();
  });

  it('lets the customer in with the consent the login sends, kept with the request', async () => {
    const user = await newUser();
    const ids = await currentIds();

    const res = await loginAs(user, { acceptedDocumentIds: ids });

    expect(res.statusCode).toBe(200);
    expect(setCookies(res).accessToken).toBeDefined();
    expect(await consentsOf(user.id)).toEqual(
      ids.map((documentId) => ({
        documentId,
        orderId: null,
        ip: '127.0.0.1',
        userAgent: 'lightMyRequest',
      })),
    );
  });

  it('asks for a version that came in force since the last login, and only for it', async () => {
    const user = await consentingUser();
    expect((await loginAs(user)).statusCode).toBe(200);
    const terms = await published('terms');

    const refused = await loginAs(user);
    const accepted = await loginAs(user, { acceptedDocumentIds: [terms.id] });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { kinds: ['terms'] } });
    expect(accepted.statusCode).toBe(200);
    expect((await statusOf(user)).json()).toMatchObject({ required: [] });
  });

  it('refuses a consent that leaves a kind out', async () => {
    const user = await newUser();
    const contract = (await currentDocuments()).find((doc) => doc.kind === 'contract')!;

    const res = await loginAs(user, { acceptedDocumentIds: [contract.id] });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'LEGAL_ACCEPTANCE_REQUIRED',
      details: { kinds: ['terms'] },
    });
    expect(await consentsOf(user.id)).toEqual([]);
  });

  it('refuses a version no longer in force and one that is not there', async () => {
    const old = await published('contract');
    await published('contract');
    const terms = (await currentDocuments()).find((doc) => doc.kind === 'terms')!;
    const user = await newUser();

    const outdated = await loginAs(user, { acceptedDocumentIds: [terms.id, old.id] });
    const unknown = await loginAs(user, { acceptedDocumentIds: [terms.id, 2147483000] });

    expect(outdated.statusCode).toBe(409);
    expect(outdated.json()).toMatchObject({ errorCode: 'LEGAL_VERSION_OUTDATED' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ errorCode: 'LEGAL_DOCUMENT_NOT_FOUND' });
  });

  // the consent is asked only of the one who proved the password
  it('says nothing of the consent to a wrong password', async () => {
    const user = await newUser();

    const res = await loginAs(user, { password: 'not-the-password-1' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_CREDENTIALS' });
  });

  it('asks nothing of an admin or root, who buys nothing', async () => {
    for (const role of ['ADMIN', 'ROOT'] as const) {
      const res = await loginAs(await newUser({ role }));

      expect(res.statusCode).toBe(200);
    }
  });

  it.each([[[]], [[1, 1]], ['one']])('refuses the list %p', async (acceptedDocumentIds) => {
    const res = await loginAs(await newUser(), { acceptedDocumentIds });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

// an admin reads what a customer accepted, in the profile of the customer (include=consents), and
// opens the text of each version by its id
describe('the consents of a customer for an admin', () => {
  const profileOf = (userId: number, viewer: TestUser) =>
    app.inject({
      method: 'GET',
      url: `/api/users/${userId}?include=consents`,
      headers: { cookie: accessCookie(viewer) },
    });

  it('gives an admin each consent of the customer with its version, newest first', async () => {
    const user = await consentingUser();
    const current = await currentDocuments();
    const orderId = await placeOrder(
      app,
      csrf,
      user,
      await createProduct({ price: 10 }),
      'waiting',
    );

    const res = await profileOf(user.id, admin);

    expect(res.statusCode).toBe(200);
    const row = (doc: LegalDocument, order: number | null) => ({
      id: expect.any(Number),
      documentId: doc.id,
      kind: doc.kind,
      version: doc.version,
      title: doc.title,
      orderId: order,
      ip: '127.0.0.1',
      userAgent: 'lightMyRequest',
      createdAt: expect.any(String),
    });
    // the order keeps the versions it was confirmed with, written after the consent
    expect(res.json().consents).toEqual([
      ...[...current].reverse().map((doc) => row(doc, orderId)),
      ...[...current].reverse().map((doc) => row(doc, null)),
    ]);

    for (const { documentId } of res.json().consents) {
      const text = await app.inject({ method: 'GET', url: `/api/legal/documents/${documentId}` });
      expect(text.json()).toMatchObject({ id: documentId, content: expect.any(String) });
    }
  });

  it('keeps the consents from another customer', async () => {
    const user = await consentingUser();

    const res = await profileOf(user.id, await newUser());

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('consents');
  });
});
