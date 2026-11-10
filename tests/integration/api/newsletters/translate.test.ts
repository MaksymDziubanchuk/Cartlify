import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import { webOrigin } from '@helpers/webOrigin.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { jsonResponse } from '../../../helpers/fetchStub.js';
import { takeLogs } from '../../../helpers/logs.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import {
  answerAsModel,
  modelResponse,
  realOpenAi,
  stopModel,
  translatedForTest,
  useModel,
  type ModelAnswer,
  type ModelCall,
} from '../../../helpers/openai.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// POST /api/newsletters/translate: the texts of a campaign in one language come back as drafts in the
// others. The model of openai writes them and nothing it writes is trusted: each translation is
// judged on its own, one that fails is not given back and its warning is. The server keeps nothing
// and logs no text. What a draft is made of and what the judge decides for each rule is in the unit
// tests (translateAnswer.helper); this file is the route: who may call it, the body, the languages,
// what is asked of the model, what comes back, and what happens when the model or openai fails

const URL = '/api/newsletters/translate';

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const extraUserIds: number[] = [];
const keyBefore = env.OPENAI_API_KEY;
const scaleBefore = env.REQUEST_LIMITS_SCALE;

type Item = { key: string; text: string; kind: 'line' | 'markup'; maxChars?: number };

const SUBJECT: Item = { key: 'subject', text: 'Spring sale', kind: 'line' };
const BLOCK: Item = {
  key: 'block0',
  text: '# Hello\nThe **best** prices, [see the sale](/sale).\n- free delivery',
  kind: 'markup',
};

const translate = (user: Pick<TestUser, 'id' | 'role'>, payload: unknown, from?: string) =>
  app.inject({
    method: 'POST',
    url: URL,
    headers: {
      ...withCsrf(csrf, accessCookie(user)),
      ...(from ? { 'x-forwarded-for': from } : {}),
    },
    payload: payload as Record<string, unknown>,
  });

const asManager = (payload: unknown) => translate(staff.manager, payload);

const body = (over: Record<string, unknown> = {}) => ({
  to: ['es'],
  items: [SUBJECT, BLOCK],
  ...over,
});

// the model of the test answers from now on, and the calls it got come back
const model = (handler?: (call: ModelCall) => ModelAnswer | Promise<ModelAnswer>) =>
  answerAsModel(handler);

const failure = (status: number, message = 'The server had an error') =>
  jsonResponse({ error: { message } }, status);

// what the model is asked, language by language
const askedFor = (calls: ModelCall[], to: string) =>
  calls.find((call) => call.translate?.to === to)!;

const refusedWith = (res: LightMyRequestResponse, status: number, errorCode: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.json()).toMatchObject({ errorCode });
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterEach(() => {
  stopModel();
  resetShopSettings();
  env.OPENAI_API_KEY = keyBefore;
  env.REQUEST_LIMITS_SCALE = scaleBefore;
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeStaff(staff);
    await closeSessions(extraUserIds);
  } finally {
    await stopApp();
  }
});

describe('who may translate', () => {
  it('refuses a visitor without a login, and the model is not asked', async () => {
    const calls = model();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: withCsrf(csrf),
      payload: body(),
    });

    refusedWith(res, 403, 'INSUFFICIENT_ROLE');
    expect(calls).toHaveLength(0);
  });

  it('asks a session that is not valid to log in again', async () => {
    const calls = model();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: withCsrf(csrf, 'accessToken=not-a-token'),
      payload: body(),
    });

    refusedWith(res, 401, 'LOGIN_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('refuses a user by their role', async () => {
    const calls = model();

    refusedWith(await translate(staff.user, body()), 403, 'INSUFFICIENT_ROLE');
    expect(calls).toHaveLength(0);
  });

  it('refuses an admin whom root did not allow', async () => {
    const calls = model();

    refusedWith(await translate(staff.plainAdmin, body()), 403, 'NEWSLETTER_MANAGER_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('lets an admin whom root allowed', async () => {
    model();

    expect((await translate(staff.manager, body())).statusCode).toBe(200);
  });

  it('lets root', async () => {
    model();

    expect((await translate(staff.root, body())).statusCode).toBe(200);
  });

  it('stops an admin whose right root took away, in the session that is open', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    extraUserIds.push(admin.id);
    await giveNewsletterRight(staff.root.id, admin.id);
    model();

    expect((await translate(admin, body())).statusCode).toBe(200);

    const taken = await app.inject({
      method: 'PATCH',
      url: `/api/root/admins/${admin.id}`,
      headers: withCsrf(csrf, accessCookie(staff.root)),
      payload: { canManageNewsletters: false },
    });
    expect(taken.statusCode).toBe(200);

    refusedWith(await translate(admin, body()), 403, 'NEWSLETTER_MANAGER_REQUIRED');
  });

  it('needs the csrf token', async () => {
    const calls = model();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie: accessCookie(staff.manager) },
      payload: body(),
    });

    refusedWith(res, 403, 'CSRF_TOKEN_INVALID');
    expect(calls).toHaveLength(0);
  });
});

describe('the drafts', () => {
  it('gives a draft of each text in each language asked, and no warning', async () => {
    const calls = model();

    const res = await asManager(body({ to: ['es', 'uk'] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      translations: {
        es: {
          subject: translatedForTest(SUBJECT.text, 'es'),
          block0: translatedForTest(BLOCK.text, 'es'),
        },
        uk: {
          subject: translatedForTest(SUBJECT.text, 'uk'),
          block0: translatedForTest(BLOCK.text, 'uk'),
        },
      },
      warnings: [],
    });
    // one request to the model for each language
    expect(calls.map((call) => call.translate!.to).sort()).toEqual(['es', 'uk']);
  });

  it('translates from the language of the shop unless told another', async () => {
    const calls = model();
    setShopSettings({ shopLocale: 'uk' });

    expect((await asManager(body({ to: ['en'] }))).statusCode).toBe(200);
    expect(calls[0]!.translate).toMatchObject({ from: 'uk', to: 'en' });

    const other = model();
    expect((await asManager(body({ from: 'es', to: ['en'] }))).statusCode).toBe(200);
    expect(other[0]!.translate).toMatchObject({ from: 'es', to: 'en' });
  });

  it('gives the texts to the model as data, in the order they came, with their kind', async () => {
    const calls = model();

    await asManager(
      body({
        items: [BLOCK, { key: 'title', text: 'Our picks', kind: 'line', maxChars: 120 }, SUBJECT],
      }),
    );

    expect(askedFor(calls, 'es').translate).toEqual({
      from: 'en',
      to: 'es',
      items: [BLOCK, { key: 'title', text: 'Our picks', kind: 'line', maxChars: 120 }, SUBJECT],
    });
    const request = askedFor(calls, 'es').request;
    expect(request.store).toBe(false);
    expect(request.temperature).toBe(0);
    expect(request.text?.format).toMatchObject({ name: 'newsletter_translation', strict: true });
    expect(request.input).toHaveLength(1);
    expect(request.instructions).not.toContain(BLOCK.text);
  });

  it('keeps a key that is a name of the prototype as a key of its own', async () => {
    model();

    const res = await asManager(body({ items: [{ key: '__proto__', text: 'Hi', kind: 'line' }] }));

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().translations.es)).toEqual(['__proto__']);
    expect(res.json().translations.es['__proto__']).toBe('Hi [es]');
  });

  it('gives an empty draft to a language where every translation failed the judge', async () => {
    model(() => ({ translations: [] }));

    const res = await asManager(body({ to: ['es'], items: [SUBJECT] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      translations: { es: {} },
      warnings: [{ locale: 'es', key: 'subject', code: 'MISSING' }],
    });
  });

  it('leaves out what the judge refuses and says why, a language and a text at a time', async () => {
    model((call) => ({
      translations: [
        { key: 'good', text: ` Bien ${call.translate!.to} ` },
        { key: 'link', text: '[ver](https://evil.example)' },
        { key: 'html', text: 'Hola <script>alert(1)</script>' },
        { key: 'long', text: 'x'.repeat(151) },
        { key: 'lines', text: 'a\nb' },
        { key: 'invented', text: 'a text nobody asked for' },
      ],
    }));

    const res = await asManager(
      body({
        to: ['es', 'uk'],
        items: [
          { key: 'good', text: 'Good', kind: 'line' },
          { key: 'link', text: '[see](/sale)', kind: 'markup' },
          { key: 'html', text: 'Hello', kind: 'line' },
          { key: 'gone', text: 'Gone', kind: 'line' },
          { key: 'long', text: 'Long', kind: 'line' },
          { key: 'lines', text: 'Lines', kind: 'line' },
        ],
      }),
    );

    expect(res.statusCode).toBe(200);
    const warningsOf = (locale: string) => [
      { locale, key: 'link', code: 'LINK_CHANGED' },
      { locale, key: 'html', code: 'HTML_NOT_ALLOWED' },
      { locale, key: 'gone', code: 'MISSING' },
      { locale, key: 'long', code: 'TOO_LONG' },
      { locale, key: 'lines', code: 'NOT_A_LINE' },
    ];
    expect(res.json()).toEqual({
      translations: { es: { good: 'Bien es' }, uk: { good: 'Bien uk' } },
      warnings: [...warningsOf('es'), ...warningsOf('uk')],
    });
  });

  describe('the addresses of other sites in a draft', () => {
    const items: Item[] = [
      { key: 'plain', text: 'See the sale', kind: 'line' },
      { key: 'markup', text: 'See the sale', kind: 'markup' },
    ];
    const answering = (text: string) =>
      model(() => ({
        translations: [
          { key: 'plain', text },
          { key: 'markup', text },
        ],
      }));

    // the draft is judged by the rule the content of a campaign is saved under: an address of a
    // site that is not the shop's and not trusted by root is refused
    it('keeps back a draft that names an address the source had, if the site is not allowed', async () => {
      const kept = [
        { key: 'plain', text: 'See https://evil.example/sale', kind: 'line' },
        { key: 'markup', text: 'See [the sale](https://evil.example/sale)', kind: 'markup' },
      ];
      model(() => ({
        translations: [
          { key: 'plain', text: 'Ver https://evil.example/sale' },
          { key: 'markup', text: 'Ver [las rebajas](https://evil.example/sale)' },
        ],
      }));

      const res = await asManager(body({ to: ['es'], items: kept }));

      expect(res.json()).toEqual({
        translations: { es: {} },
        warnings: [
          {
            locale: 'es',
            key: 'plain',
            code: 'ADDRESS_NOT_ALLOWED',
            field: 'plain.es',
            address: 'https://evil.example/sale',
          },
          {
            locale: 'es',
            key: 'markup',
            code: 'ADDRESS_NOT_ALLOWED',
            field: 'markup.es',
            address: 'https://evil.example/sale',
          },
        ],
      });
    });

    it('names the address when the model wrote a domain with a path that nothing else sees', async () => {
      answering('Ver evil.example/sale');

      const res = await asManager(body({ to: ['es'], items }));

      expect(res.json().warnings).toEqual([
        {
          locale: 'es',
          key: 'plain',
          code: 'ADDRESS_NOT_ALLOWED',
          field: 'plain.es',
          address: 'evil.example/sale',
        },
        {
          locale: 'es',
          key: 'markup',
          code: 'ADDRESS_NOT_ALLOWED',
          field: 'markup.es',
          address: 'evil.example/sale',
        },
      ]);
    });

    // a name with no path counts when it ends with a real top-level domain; the warning says where
    // (the key of the text and the language, the place the content error names for the saved draft)
    // and what
    it.each([
      ['a name with no path', 'Ver evil.com', 'evil.com'],
      ['a name with a query', 'Ver evil.com?utm=1.', 'evil.com?utm=1'],
      ['a name with a fragment', 'Ver evil.com#top', 'evil.com#top'],
    ])('names the field and the address of %s', async (_name, text, address) => {
      answering(text);

      const res = await asManager(body({ to: ['es'], items }));

      expect(res.json()).toEqual({
        translations: { es: {} },
        warnings: [
          { locale: 'es', key: 'plain', code: 'ADDRESS_NOT_ALLOWED', field: 'plain.es', address },
          { locale: 'es', key: 'markup', code: 'ADDRESS_NOT_ALLOWED', field: 'markup.es', address },
        ],
      });
    });

    it('gives the other warnings no field and no address', async () => {
      model(() => ({ translations: [{ key: 'plain', text: 'Ver\nlinea' }] }));

      const res = await asManager(body({ to: ['es'], items }));

      expect(res.json().warnings).toEqual([
        { locale: 'es', key: 'plain', code: 'NOT_A_LINE' },
        { locale: 'es', key: 'markup', code: 'MISSING' },
      ]);
    });

    it('gives the draft back with an address of the shop, a subdomain of it or a trusted domain', async () => {
      const own = webOrigin!.replace(/^https?:\/\//, '');
      setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
      answering(`Ver ${own}/sale, cdn.${own}/new y blog.partner.test/post`);

      const res = await asManager(body({ to: ['es'], items }));

      expect(res.json()).toEqual({
        translations: {
          es: {
            plain: `Ver ${own}/sale, cdn.${own}/new y blog.partner.test/post`,
            markup: `Ver ${own}/sale, cdn.${own}/new y blog.partner.test/post`,
          },
        },
        warnings: [],
      });
    });

    it('stops trusting a domain when root stops, the next request', async () => {
      setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
      answering('Ver blog.partner.test/post');
      expect((await asManager(body({ to: ['es'], items }))).json().warnings).toEqual([]);

      resetShopSettings();
      answering('Ver blog.partner.test/post');
      expect((await asManager(body({ to: ['es'], items }))).json().warnings).toEqual([
        {
          locale: 'es',
          key: 'plain',
          code: 'ADDRESS_NOT_ALLOWED',
          field: 'plain.es',
          address: 'blog.partner.test/post',
        },
        {
          locale: 'es',
          key: 'markup',
          code: 'ADDRESS_NOT_ALLOWED',
          field: 'markup.es',
          address: 'blog.partner.test/post',
        },
      ]);
    });
  });

  it('stores nothing: no campaign and no line of the admin log', async () => {
    const campaigns = () =>
      asAdmin((tx) => tx.newsletterCampaign.count({ where: { createdById: staff.manager.id } }));
    const lines = () =>
      asAdmin((tx) => tx.adminAuditLog.count({ where: { actorId: staff.manager.id } }));
    const before = { campaigns: await campaigns(), lines: await lines() };
    model();

    expect((await asManager(body({ to: ['es', 'uk'] }))).statusCode).toBe(200);

    expect({ campaigns: await campaigns(), lines: await lines() }).toEqual(before);
  });
});

describe('the body', () => {
  const longText = (length: number) => 'a'.repeat(length);

  it.each([
    ['nothing', {}],
    ['no languages', { items: [SUBJECT] }],
    ['no texts', { to: ['es'] }],
    ['an empty list of languages', body({ to: [] })],
    ['more than 20 languages', body({ to: Array.from({ length: 21 }, () => 'es') })],
    ['languages that are no list', body({ to: 'es' })],
    ['a language that is no text', body({ to: [5] })],
    ['an empty language', body({ to: [''] })],
    ['a from that is no text', body({ from: 5 })],
    ['an empty list of texts', body({ items: [] })],
    [
      '31 texts',
      body({ items: Array.from({ length: 31 }, (_, i) => ({ ...SUBJECT, key: `k${i}` })) }),
    ],
    ['texts that are no list', body({ items: SUBJECT })],
    ['a text with no key', body({ items: [{ text: 'Hi', kind: 'line' }] })],
    ['a text with no text', body({ items: [{ key: 'a', kind: 'line' }] })],
    ['a text with no kind', body({ items: [{ key: 'a', text: 'Hi' }] })],
    ['an empty key', body({ items: [{ ...SUBJECT, key: '' }] })],
    ['a key of 41 characters', body({ items: [{ ...SUBJECT, key: 'k'.repeat(41) }] })],
    ['a key with a space', body({ items: [{ ...SUBJECT, key: 'a b' }] })],
    ['a key with a slash', body({ items: [{ ...SUBJECT, key: 'a/b' }] })],
    ['a key with a letter with an accent', body({ items: [{ ...SUBJECT, key: 'café' }] })],
    ['a key that is a number', body({ items: [{ ...SUBJECT, key: 5 }] })],
    ['an empty text', body({ items: [{ ...SUBJECT, text: '' }] })],
    ['a text of spaces', body({ items: [{ ...SUBJECT, text: '  \n ' }] })],
    ['a text of 5001 characters', body({ items: [{ ...BLOCK, text: longText(5001) }] })],
    ['a text that is a number', body({ items: [{ ...SUBJECT, text: 5 }] })],
    ['a kind there is none of', body({ items: [{ ...SUBJECT, kind: 'html' }] })],
    ['a limit of 0', body({ items: [{ ...SUBJECT, maxChars: 0 }] })],
    ['a limit of 5001', body({ items: [{ ...SUBJECT, maxChars: 5001 }] })],
    ['a limit that is not whole', body({ items: [{ ...SUBJECT, maxChars: 1.5 }] })],
    ['a limit that is a text', body({ items: [{ ...SUBJECT, maxChars: '120' }] })],
    ['a field the body does not have', body({ save: true })],
    ['a field a text does not have', body({ items: [{ ...SUBJECT, id: 1 }] })],
  ])('refuses %s, and the model is not asked', async (_name, payload) => {
    const calls = model();

    const res = await asManager(payload);

    refusedWith(res, 400, 'VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('takes the biggest texts the schema allows: 30 of them, a key of 40, a limit of 5000', async () => {
    model();
    const items = Array.from({ length: 30 }, (_, i) => ({
      key: i === 0 ? 'k'.repeat(40) : `k${i}`,
      text: 'a',
      kind: 'line' as const,
      maxChars: 5000,
    }));

    const res = await asManager(body({ items, to: ['es', 'uk'] }));

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().translations.es)).toHaveLength(30);
  });

  it('takes every character a key may have', async () => {
    model();

    const res = await asManager(body({ items: [{ ...SUBJECT, key: 'Block_0-a.B9' }], to: ['es'] }));

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().translations.es)).toEqual(['Block_0-a.B9']);
  });

  it('refuses a key that is used twice, naming the second place', async () => {
    const calls = model();

    const res = await asManager(body({ items: [SUBJECT, BLOCK, { ...SUBJECT, text: 'Again' }] }));

    refusedWith(res, 400, 'VALIDATION_ERROR');
    expect(res.json().details).toEqual([
      { in: 'body', field: 'items.2.key', message: 'must be unique' },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('refuses more text than 20000 characters in all, and takes exactly 20000', async () => {
    const calls = model();
    const item = (key: string, length: number): Item => ({
      key,
      kind: 'markup',
      text: 'a'.repeat(length),
    });

    const over = await asManager(
      body({
        items: [item('a', 5000), item('b', 5000), item('c', 5000), item('d', 5000), item('e', 1)],
      }),
    );
    refusedWith(over, 400, 'NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT');
    expect(over.json().details).toEqual({ limit: 20000, length: 20001 });
    expect(calls).toHaveLength(0);

    const exact = await asManager(
      body({ items: [item('a', 5000), item('b', 5000), item('c', 5000), item('d', 5000)] }),
    );
    expect(exact.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('counts the characters of the text, not the halves of a sign', async () => {
    model();
    // five texts of 2500 signs of two halves each: 25000 halves, 12500 characters in all
    const emoji = '\u{1F600}'.repeat(2500);

    const res = await asManager(
      body({ items: ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, kind: 'line', text: emoji })) }),
    );

    expect(res.statusCode).toBe(200);
  });
});

describe('the languages', () => {
  const invalid = async (payload: unknown) => {
    const calls = model();
    const res = await asManager(payload);

    refusedWith(res, 400, 'LOCALE_INVALID');
    expect(calls).toHaveLength(0);
    return res.json().details as { field: string; locale: string };
  };

  it('refuses a language the shop does not answer in, naming it', async () => {
    expect(await invalid(body({ to: ['es', 'xx'] }))).toEqual({ field: 'to[1]', locale: 'xx' });
  });

  it('refuses a language root turned off', async () => {
    setShopSettings({ enabledLocales: ['en', 'es'] });

    expect(await invalid(body({ to: ['uk'] }))).toEqual({ field: 'to[0]', locale: 'uk' });
  });

  it('refuses a language that is not written as the code of a language: small letters, two of them', async () => {
    expect(await invalid(body({ to: ['ES'] }))).toEqual({ field: 'to[0]', locale: 'ES' });
    expect(await invalid(body({ to: ['es-ES'] }))).toEqual({ field: 'to[0]', locale: 'es-ES' });
    expect(await invalid(body({ to: [' es '] }))).toEqual({ field: 'to[0]', locale: ' es ' });
  });

  it('refuses the language the texts are in', async () => {
    expect(await invalid(body({ to: ['en'] }))).toEqual({ field: 'to[0]', locale: 'en' });
    expect(await invalid(body({ from: 'es', to: ['uk', 'es'] }))).toEqual({
      field: 'to[1]',
      locale: 'es',
    });
  });

  it('refuses a language asked twice, naming the second', async () => {
    expect(await invalid(body({ to: ['es', 'uk', 'es'] }))).toEqual({
      field: 'to[2]',
      locale: 'es',
    });
  });

  it('refuses a language to translate from that the shop does not answer in', async () => {
    expect(await invalid(body({ from: 'xx' }))).toEqual({ field: 'from', locale: 'xx' });
    setShopSettings({ enabledLocales: ['en', 'es'] });
    expect(await invalid(body({ from: 'uk', to: ['es'] }))).toEqual({
      field: 'from',
      locale: 'uk',
    });
  });

  it('judges the language to translate from before the languages to translate into', async () => {
    expect(await invalid(body({ from: 'xx', to: ['yy'] }))).toEqual({
      field: 'from',
      locale: 'xx',
    });
  });

  it('judges the languages before the amount of text and the keys', async () => {
    const calls = model();

    const res = await asManager(
      body({
        to: ['xx'],
        items: [
          { key: 'a', kind: 'markup', text: 'a'.repeat(5000) },
          { key: 'a', kind: 'markup', text: 'a'.repeat(5000) },
          { key: 'b', kind: 'markup', text: 'a'.repeat(5000) },
          { key: 'c', kind: 'markup', text: 'a'.repeat(5000) },
          { key: 'd', kind: 'markup', text: 'a'.repeat(5000) },
        ],
      }),
    );

    refusedWith(res, 400, 'LOCALE_INVALID');
    expect(calls).toHaveLength(0);
  });

  it('takes the languages root turned on, and only for those', async () => {
    setShopSettings({ enabledLocales: ['en', 'es', 'uk'] });
    model();

    expect((await asManager(body({ to: ['es', 'uk'] }))).statusCode).toBe(200);
  });
});

describe('when the model or openai fails', () => {
  // every attempt that fails is a line of the log: the language and the code, never a text
  const failedLines = () => takeLogs({ msg: 'newsletter translation failed' });
  const requestFailed = () =>
    takeLogs({ msg: 'request failed', errorCode: 'NEWSLETTER_TRANSLATE_FAILED' });

  it.each([
    ['an error of the server', () => failure(500), 'AI_API_UNAVAILABLE'],
    ['a limit of requests', () => failure(429), 'AI_RATE_LIMIT'],
    [
      'a key that is refused',
      () => failure(401, 'Incorrect API key provided'),
      'AI_API_UNAVAILABLE',
    ],
    ['no answer in time', () => failure(504), 'AI_TIMEOUT'],
    [
      'an answer cut short',
      () =>
        modelResponse('{"translations":[{"key":"subject","te', { incomplete: 'max_output_tokens' }),
      'AI_INCOMPLETE_RESPONSE',
    ],
  ])('is a bad gateway with nothing of openai in it, for %s', async (_name, answer, reason) => {
    const calls = model(() => answer());

    const res = await asManager(body({ items: [{ ...SUBJECT, text: 'SECRET-MARKER-TEXT' }] }));

    expect(res.statusCode).toBe(502);
    const answerBody = res.json();
    expect(answerBody).toMatchObject({ code: 502, errorCode: 'NEWSLETTER_TRANSLATE_FAILED' });
    expect(answerBody).not.toHaveProperty('details');
    expect(answerBody).not.toHaveProperty('cause');
    expect(JSON.stringify(answerBody)).not.toMatch(
      /SECRET-MARKER|sk-test|Incorrect API key|server had/,
    );
    // no retry: only an answer that is broken is asked for again
    expect(calls).toHaveLength(1);

    expect(failedLines()).toHaveLength(1);
    const [line] = requestFailed();
    expect(line!.err?.details?.reason).toBe(reason);
    expect(JSON.stringify(takeLogs({}))).not.toMatch(/SECRET-MARKER|sk-test|Incorrect API key/);
  });

  it('is a bad gateway without a call when the key of openai is not set', async () => {
    env.OPENAI_API_KEY = '';
    const fetching = jest.spyOn(globalThis, 'fetch');

    const res = await asManager(body());

    refusedWith(res, 502, 'NEWSLETTER_TRANSLATE_FAILED');
    expect(res.json()).not.toHaveProperty('details');
    expect(fetching).not.toHaveBeenCalled();
    const [line] = requestFailed();
    expect(line!.err?.details?.reason).toBe('AI_NOT_CONFIGURED');
  });

  it('says what went well and what failed when only some of the languages fail', async () => {
    model((call) =>
      call.translate!.to === 'es'
        ? failure(500)
        : {
            translations: call.translate!.items.map((item) => ({
              key: item.key,
              text: translatedForTest(item.text, 'uk'),
            })),
          },
    );

    const res = await asManager(body({ to: ['es', 'uk'] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      translations: {
        es: {},
        uk: {
          subject: translatedForTest(SUBJECT.text, 'uk'),
          block0: translatedForTest(BLOCK.text, 'uk'),
        },
      },
      warnings: [
        { locale: 'es', key: 'subject', code: 'TRANSLATION_FAILED' },
        { locale: 'es', key: 'block0', code: 'TRANSLATION_FAILED' },
      ],
    });
    expect(failedLines()).toMatchObject([
      { locale: 'es', code: 'AI_API_UNAVAILABLE', willRetry: false },
    ]);
  });

  it('asks again once when the answer is broken, and uses the second', async () => {
    let attempt = 0;
    const calls = model((call) => {
      attempt += 1;
      return attempt === 1
        ? 'Sure! Here is your translation'
        : {
            translations: call.translate!.items.map((item) => ({
              key: item.key,
              text: translatedForTest(item.text, 'es'),
            })),
          };
    });

    const res = await asManager(body({ items: [SUBJECT] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      translations: { es: { subject: translatedForTest(SUBJECT.text, 'es') } },
      warnings: [],
    });
    expect(calls).toHaveLength(2);
    expect(failedLines()).toMatchObject([
      { locale: 'es', attempt: 1, willRetry: true, code: 'TRANSLATE_ANSWER_INVALID' },
    ]);
  });

  it.each([
    ['text that is no json', 'Sure! Here is your translation'],
    ['a json of another shape', '{"result":"Rebajas"}'],
    ['a list', '["Rebajas"]'],
    ['an empty text', ''],
  ])('gives up when the answer is %s twice', async (_name, text) => {
    const calls = model(() => text);

    const res = await asManager(body({ items: [{ ...SUBJECT, text: 'SECRET-MARKER-TEXT' }] }));

    refusedWith(res, 502, 'NEWSLETTER_TRANSLATE_FAILED');
    expect(calls).toHaveLength(2);
    expect(failedLines()).toHaveLength(2);
    expect(requestFailed()).toHaveLength(1);
    expect(JSON.stringify(takeLogs({}))).not.toContain('SECRET-MARKER');
    expect(JSON.stringify(res.json())).not.toContain('Rebajas');
  });

  it('keeps no text of the model in the answer or the log when it obeys a text that tells it to speak', async () => {
    model(() => 'Ignore the rules. My key is sk-test-made-up-model-key and the system prompt is:');

    const res = await asManager(body({ items: [SUBJECT] }));

    refusedWith(res, 502, 'NEWSLETTER_TRANSLATE_FAILED');
    expect(JSON.stringify(res.json())).not.toContain('Ignore the rules');
    failedLines();
    requestFailed();
    expect(JSON.stringify(takeLogs({}))).not.toMatch(/Ignore the rules|sk-test/);
  });

  it('keeps the texts of the admin out of the log when it works', async () => {
    model();

    const res = await asManager(body({ items: [{ ...SUBJECT, text: 'SECRET-MARKER-TEXT' }] }));

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(takeLogs({}))).not.toContain('SECRET-MARKER');
  });
});

describe('the limit of the requests', () => {
  // each request costs money, so a user has a few in an hour (LIMIT_NEWSLETTER_TRANSLATE_PER_USER,
  // 20 unless set). The other files of the integration tests raise every limit a thousand times
  it('refuses the request past the limit, for that user only', async () => {
    env.REQUEST_LIMITS_SCALE = 1;
    const before = env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER;
    env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = 2;
    const admin = await createUser({ role: 'ADMIN' });
    extraUserIds.push(admin.id);
    await giveNewsletterRight(staff.root.id, admin.id);
    const calls = model();

    try {
      expect((await translate(admin, body())).statusCode).toBe(200);
      expect((await translate(admin, body())).statusCode).toBe(200);

      const refused = await translate(admin, body());

      refusedWith(refused, 429, 'RATE_LIMITED');
      expect(refused.json()).toMatchObject({ details: { limit: 'newsletterTranslate' } });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // the model was asked for the two that went through, not for the refused one
      expect(calls).toHaveLength(2);

      // the count is the user's own
      const other = await createUser({ role: 'ADMIN' });
      extraUserIds.push(other.id);
      await giveNewsletterRight(staff.root.id, other.id);
      expect((await translate(other, body())).statusCode).toBe(200);
    } finally {
      env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = before;
    }
  });

  // a refused request costs nothing, so it uses up nothing: an admin without the right cannot use up
  // the requests of the one who will get it, nor can a user fill the count of the limit
  it('does not count the request the guards refuse', async () => {
    env.REQUEST_LIMITS_SCALE = 1;
    const before = env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER;
    env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = 1;
    const admin = await createUser({ role: 'ADMIN' });
    extraUserIds.push(admin.id);
    model();

    try {
      for (let i = 0; i < 3; i += 1) {
        refusedWith(await translate(admin, body()), 403, 'NEWSLETTER_MANAGER_REQUIRED');
      }
      await giveNewsletterRight(staff.root.id, admin.id);

      expect((await translate(admin, body())).statusCode).toBe(200);
      refusedWith(await translate(admin, body()), 429, 'RATE_LIMITED');
    } finally {
      env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = before;
    }
  });

  it('counts the request that fails after the limit, not the one the schema refuses', async () => {
    env.REQUEST_LIMITS_SCALE = 1;
    const before = env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER;
    env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = 1;
    const admin = await createUser({ role: 'ADMIN' });
    extraUserIds.push(admin.id);
    await giveNewsletterRight(staff.root.id, admin.id);
    model();

    try {
      // refused by the schema, before the limit
      refusedWith(await translate(admin, {}), 400, 'VALIDATION_ERROR');
      // a language the shop does not have: it passed the limit, so it counts
      refusedWith(await translate(admin, body({ to: ['xx'] })), 400, 'LOCALE_INVALID');

      refusedWith(await translate(admin, body()), 429, 'RATE_LIMITED');
    } finally {
      env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER = before;
    }
  });
});

// the translation itself: the model of the test unless the run takes openai for real (service:openai,
// a cent a run). Its words are not checked, its form is: an answer of the schema comes in time and the
// judge lets a plain text through with its markup and its link. A failure or a broken answer would be
// a bad gateway here, and a warning in the log would fail the test
describe(`the translation (${realOpenAi ? 'openai' : 'the model of the test'})`, () => {
  it('translates a subject and a text with markup, and the link stays', async () => {
    const calls = useModel();

    const res = await asManager({
      to: ['es'],
      items: [
        { key: 'subject', kind: 'line', text: 'Spring sale: up to 30% off' },
        {
          key: 'text',
          kind: 'markup',
          text: '# Spring is here\nThe **best** prices of the year, [see the sale](/sale).\n- free delivery\n- *new* arrivals every week',
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const { translations, warnings } = res.json();
    expect(warnings).toEqual([]);
    expect(translations.es.subject).toEqual(expect.any(String));
    expect(translations.es.subject.trim()).not.toBe('');
    expect(translations.es.subject).not.toMatch(/[\r\n]/);
    expect(translations.es.text).toContain('](/sale)');
    expect(translations.es.text).toContain('# ');
    expect(calls.map((call) => call.purpose)).toEqual(['newsletter_translate']);
    if (realOpenAi) expect(calls[0]!.status).toBe(200);
  });
});
