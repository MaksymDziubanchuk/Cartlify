import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, logIn, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { dictionaryText } from '../../helpers/dictionary.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  uniqueEmail,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchNewsletterMail, type SentMail } from '../../helpers/mail.js';
import { BASE, forget, newsletterApi } from '../../helpers/newsletterApi.js';
import {
  manageTokenOf,
  newsletterDesk,
  subscribeOnPage,
  type Locale,
} from '../../helpers/newsletterFlow.js';
import { stopModel, useModel } from '../../helpers/openai.js';

// A campaign from the idea of an admin to the mail of the readers, each step with what its actor sees.
// Root gives a person the right to run the newsletters and the person, who could not open the area a
// minute ago, writes the campaign in English, looks at the preview (which tells that one product is
// gone), takes that product out, asks for the drafts in the other languages and puts them in, sends the
// test mail to a colleague, to root and to the own address, each in a language of its own, and
// schedules the campaign. Root has set the limit of the campaigns to two in a week: two copies ask for
// the same week, the second is refused with the campaigns that hold the week, the admin calls the first
// off and the second takes its place. At the day the pass sends the campaign and three readers, one for
// each language, get one mail in their language with the product of the admin, the category and the
// button, and with links to the shop only; the admin reads the summary of the campaign, and root reads
// the log of what the admin did, step by step. The refusals, the shape of the answers and the rules of
// the content are the tests of the routes (api/newsletters); what the alerts say of the campaign that
// went out, the stop and the end of the right are in the next file of the flows (newsletterWatch).
// *.shopwide: a campaign mails every subscription in force in the database.

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let person: TestUser;
let colleague: TestUser;
let shirt: TestProduct;
let gone: TestProduct;
const emails: string[] = [];
const userIds: number[] = [];
// the campaigns the flow leaves scheduled when it breaks half way: they are called off at the end
const planned: number[] = [];

const SHOP = 'https://shop.example.com';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Run Root' });
  person = await createUser({ name: 'Olena Run' });
  colleague = await createUser({ role: 'ADMIN', name: 'Colleague Run' });
  userIds.push(root.id, person.id, colleague.id);
  shirt = await createProduct({ name: 'Flow shirt', price: 30, stock: 10 });
  gone = await createProduct({ name: 'Gone shirt', price: 20, stock: 0 });
});

afterEach(async () => {
  stopModel();
  // the readers of a flow are not the audience of the next *.shopwide file: the addresses go before
  // the shop lock does, which is before afterAll
  await forget(emails.splice(0));
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const as = (session: Session) => ({ cookie: sessionCookie(session) });

const put = (session: Session, url: string, value: unknown) =>
  app.inject({
    method: 'PUT',
    url,
    headers: withCsrf(csrf, sessionCookie(session)),
    payload: { value },
  });

// every URL a mail writes: the links of the html and the addresses of the text
const linksOf = (mail: SentMail): string[] => [
  ...[...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!),
  ...(mail.text.match(/https?:\/\/[^\s)]+/g) ?? []),
];

describe('a campaign from the draft of an admin to the mail of the readers', () => {
  it('is written, checked, tested, held by the limit, scheduled, sent and read in the log', async () => {
    const api = newsletterApi(app, csrf);
    const rootSession = await signIn(app, csrf, root);
    const category = await createCategory({ name: 'Flow shoes' });
    const get = (session: Session, url: string) => api.get(url, as(session));
    const post = (session: Session, url: string, body?: Record<string, unknown>) =>
      api.post(url, body, as(session));
    const patch = (session: Session, url: string, body: Record<string, unknown>) =>
      api.patch(url, body, as(session));

    // the limit of the shop as it stands; root sets two campaigns in a week for this flow
    const settings = await get(rootSession, '/api/admin/shop-settings');
    const limitBefore = {
      count: settings.json().newsletterLimitCount as number,
      days: settings.json().newsletterLimitDays as number,
    };

    try {
      expect(
        (await put(rootSession, '/api/root/shop-settings/newsletterLimitCount', 2)).statusCode,
      ).toBe(200);
      expect(
        (await put(rootSession, '/api/root/shop-settings/newsletterLimitDays', 7)).statusCode,
      ).toBe(200);

      // root finds the person in the list of users and makes them an admin
      const found = await get(rootSession, `/api/users?email=${encodeURIComponent(person.email)}`);
      expect(found.statusCode).toBe(200);
      const personId = (found.json().items as { id: number }[])[0]!.id;
      const promoted = await post(rootSession, '/api/root/admins', { userId: personId });
      expect(promoted.statusCode).toBe(201);

      // the new admin logs in: the profile says admin with no right to run the newsletters, and the
      // area of the campaigns is closed
      const login = await logIn(app, csrf, { email: person.email, password: person.password });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });
      const jar = cookieJar(login);
      const admin: Session = { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };

      const closed = await get(admin, `${BASE}/campaigns`);
      expect(closed.statusCode).toBe(403);
      expect(closed.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });

      // root gives the right; the same session sees it in the profile and the area is open
      const given = await patch(rootSession, `/api/root/admins/${personId}`, {
        canManageNewsletters: true,
      });
      expect(given.statusCode).toBe(200);
      expect((await get(admin, '/api/users/me')).json()).toMatchObject({
        canManageNewsletters: true,
      });
      expect((await get(admin, `${BASE}/campaigns`)).statusCode).toBe(200);

      // the admin writes the campaign in English: a text, two products (one of them is gone from the
      // shelf), the category and a button
      const english = {
        subject: { en: 'Spring sale' },
        preview: { en: 'The best prices of the spring' },
        blocks: [
          { type: 'text', text: { en: 'Hello **readers**, see [the sale](/sale).' } },
          {
            type: 'products',
            source: 'manual',
            productIds: [shirt.id, gone.id],
            title: { en: 'Our picks' },
          },
          { type: 'category', categoryId: category.id, title: { en: 'Shoes for spring' } },
          { type: 'button', kind: 'sale', url: '/sale' },
        ],
      };
      const created = await post(admin, `${BASE}/campaigns`, {
        name: 'Spring flow',
        missingLocale: 'shop_locale',
        content: english,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ status: 'draft', createdById: personId });
      const id = created.json().id as number;

      // the preview shows the mail with the product that is on the shelf and warns of the other
      const preview = await post(admin, `${BASE}/campaigns/${id}/preview`, { locale: 'en' });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().html).toContain('Flow shirt');
      expect(preview.json().html).not.toContain('Gone shirt');
      const unavailable = (
        preview.json().warnings as { code: string; productId?: number }[]
      ).filter((warning) => warning.code === 'PRODUCT_UNAVAILABLE');
      expect(unavailable).toEqual([
        { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: gone.id },
      ]);

      // the admin takes that product out of the block, by the id the warning gave
      const kept = [shirt.id, gone.id].filter((product) => product !== unavailable[0]!.productId);
      const tidied = {
        ...english,
        blocks: english.blocks.map((block) =>
          block.type === 'products' ? { ...block, productIds: kept } : block,
        ),
      };
      const mended = await patch(admin, `${BASE}/campaigns/${id}`, { content: tidied });
      expect(mended.statusCode).toBe(200);

      // the admin asks for the drafts in the other languages of the shop, and puts the ones that came
      // into the campaign
      useModel();
      const translated = await post(admin, `${BASE}/translate`, {
        to: ['es', 'uk'],
        items: [
          { key: 'subject', text: english.subject.en, kind: 'line' },
          { key: 'preview', text: english.preview.en, kind: 'line' },
          {
            key: 'text0',
            text: (english.blocks[0] as { text: { en: string } }).text.en,
            kind: 'markup',
          },
          { key: 'title1', text: 'Our picks', kind: 'line', maxChars: 120 },
          { key: 'title2', text: 'Shoes for spring', kind: 'line', maxChars: 120 },
        ],
      });
      expect(translated.statusCode).toBe(200);
      expect(translated.json().warnings).toEqual([]);
      const drafts = translated.json().translations as Record<'es' | 'uk', Record<string, string>>;

      const everyLanguage = {
        subject: { en: 'Spring sale', es: drafts.es.subject!, uk: drafts.uk.subject! },
        preview: { en: english.preview.en, es: drafts.es.preview!, uk: drafts.uk.preview! },
        blocks: [
          {
            type: 'text',
            text: {
              en: (english.blocks[0] as { text: { en: string } }).text.en,
              es: drafts.es.text0!,
              uk: drafts.uk.text0!,
            },
          },
          {
            type: 'products',
            source: 'manual',
            productIds: kept,
            title: { en: 'Our picks', es: drafts.es.title1!, uk: drafts.uk.title1! },
          },
          {
            type: 'category',
            categoryId: category.id,
            title: { en: 'Shoes for spring', es: drafts.es.title2!, uk: drafts.uk.title2! },
          },
          { type: 'button', kind: 'sale', url: '/sale' },
        ],
      };
      const completed = await patch(admin, `${BASE}/campaigns/${id}`, { content: everyLanguage });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().disabledLocales).toEqual([]);

      // the preview in a language that was drafted shows the draft
      const previewEs = await post(admin, `${BASE}/campaigns/${id}/preview`, { locale: 'es' });
      expect(previewEs.statusCode).toBe(200);
      expect(previewEs.json().subject).toBe(drafts.es.subject);
      expect(previewEs.json().warnings).toEqual([]);

      // the test mails: to a colleague who checks the look in Spanish, to root in English and to the
      // address of the admin in Ukrainian. Each goes to the address named, none to the admin's own
      // unless the admin named it
      const tests = watchNewsletterMail();
      const testSent: [string, Locale][] = [
        [colleague.email, 'es'],
        [root.email, 'en'],
        [person.email, 'uk'],
      ];
      for (const [email, locale] of testSent) {
        const res = await post(admin, `${BASE}/campaigns/${id}/test`, { email, locale });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ sent: true });
      }
      expect(tests.map((mail) => mail.to)).toEqual(testSent.map(([email]) => [email]));
      const subjects = { en: 'Spring sale', es: drafts.es.subject!, uk: drafts.uk.subject! };
      testSent.forEach(([, locale], index) => {
        const mail = tests[index]!;
        // a test mail says it is one: a word in front of the subject, and a line at the top
        expect(mail.subject).toBe(
          `${dictionaryText(locale, 'campaignMail.testSubjectPrefix')} ${subjects[locale]}`,
        );
        expect(mail.text.startsWith(dictionaryText(locale, 'campaignMail.testNotice'))).toBe(true);
        expect(mail.html).toContain(`<html lang="${locale}">`);
        expect(mail.text).toContain(dictionaryText(locale, 'campaignMail.manage'));
        expect(mail.text).toContain('Flow shirt');
        expect(mail.text).not.toContain('Gone shirt');
        // a test mail belongs to no recipient of the campaign
        expect(mail.customArgs).toEqual({});
      });

      // the colleague opens "Manage the subscription" in the test mail: it is nobody's subscription
      const lost = await api.post(`${BASE}/manage`, { token: manageTokenOf(tests[0]!) });
      expect(lost.statusCode).toBe(400);
      expect(lost.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

      // the admin schedules the campaign for a day of the desk
      const desk = newsletterDesk(app, csrf, sessionCookie(admin));
      const day = desk.slot();
      const scheduled = await post(admin, `${BASE}/campaigns/${id}/schedule`, {
        scheduledAt: day.toISOString(),
      });
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json()).toMatchObject({ id, status: 'scheduled' });
      planned.push(id);

      // two copies ask for the same week: the first fills it up, the second is refused with the
      // campaigns that hold the week (the order of the time)
      const firstCopy = (await post(admin, `${BASE}/campaigns/${id}/copy`)).json() as {
        id: number;
      };
      const secondCopy = (await post(admin, `${BASE}/campaigns/${id}/copy`)).json() as {
        id: number;
      };
      const at = (days: number) => new Date(day.getTime() + days * 86_400_000).toISOString();
      const first = await post(admin, `${BASE}/campaigns/${firstCopy.id}/schedule`, {
        scheduledAt: at(2),
      });
      expect(first.statusCode).toBe(200);
      planned.push(firstCopy.id);

      const held = await post(admin, `${BASE}/campaigns/${secondCopy.id}/schedule`, {
        scheduledAt: at(4),
      });
      expect(held.statusCode).toBe(409);
      expect(held.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LIMIT_REACHED',
        details: { limit: { count: 2, days: 7 } },
      });
      expect((held.json().details.campaigns as { id: number }[]).map((item) => item.id)).toEqual([
        id,
        firstCopy.id,
      ]);

      // the admin calls the first copy off and the second takes its place
      expect((await post(admin, `${BASE}/campaigns/${firstCopy.id}/cancel`)).statusCode).toBe(200);
      const second = await post(admin, `${BASE}/campaigns/${secondCopy.id}/schedule`, {
        scheduledAt: at(4),
      });
      expect(second.statusCode).toBe(200);
      planned.push(secondCopy.id);

      // meanwhile three readers subscribed on the page, one in each language of the shop
      const readers = [
        { email: uniqueEmail('reader-en'), locale: 'en' as const },
        { email: uniqueEmail('reader-es'), locale: 'es' as const },
        { email: uniqueEmail('reader-uk'), locale: 'uk' as const },
      ];
      for (const reader of readers) {
        emails.push(reader.email);
        await subscribeOnPage(app, csrf, reader.email, reader.locale);
      }

      // the day comes: the pass sends the campaign, narrowed to it (the copy waits for its week)
      const { summary, mails } = await desk.pass([id], day);
      expect(summary).toMatchObject({ reason: 'done', launched: 1, rejected: 0, finished: 1 });

      for (const reader of readers) {
        const own = mails.filter((mail) => mail.to[0] === reader.email);
        expect(own).toHaveLength(1);
        const mail = own[0]!;
        const texts = reader.locale === 'en' ? null : drafts[reader.locale];

        expect(mail).toMatchObject({
          stream: 'newsletter',
          from: process.env.NEWSLETTER_EMAIL_FROM,
          categories: ['newsletter'],
          accepted: true,
          subject: subjects[reader.locale],
        });
        expect(mail.html).toContain(`<html lang="${reader.locale}">`);
        // the cards of the admin: the product that was on the shelf, the category, the button
        expect(mail.text).toContain('Flow shirt');
        expect(mail.text).not.toContain('Gone shirt');
        expect(mail.text).toContain('Flow shoes');
        expect(mail.text).toContain(texts?.title1 ?? 'Our picks');
        expect(mail.text).toContain(texts?.title2 ?? 'Shoes for spring');
        expect(mail.text).toContain(dictionaryText(reader.locale, 'campaignMail.manage'));
        expect(mail.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.example\.com\//);
        // the links of the card and of the button go to the shop, each marked with the campaign
        expect(mail.html).toContain(`href="${SHOP}/products/${shirt.id}?`);
        expect(mail.html).toContain(`href="${SHOP}/categories/${category.id}?`);
        expect(mail.html).toContain(`utm_campaign=${id}`);
        // and nothing leads away from the shop but the address of the shop's support
        for (const link of linksOf(mail)) {
          expect(link.startsWith(SHOP) || link.startsWith('mailto:')).toBe(true);
        }
        // the tokens of the mail are the reader's own (the colleague's test mail had a dead one)
        expect(manageTokenOf(mail)).not.toBe(manageTokenOf(tests[0]!));
      }

      // the admin reads the summary of the campaign: every mail planned went out
      const finished = await get(admin, `${BASE}/campaigns/${id}`);
      expect(finished.statusCode).toBe(200);
      expect(finished.json()).toMatchObject({
        status: 'finished',
        counters: {
          planned: mails.length,
          sent: mails.length,
          rejected: 0,
          undelivered: 0,
          complaints: 0,
          unsubscribed: 0,
        },
      });
      expect(finished.json().startedAt).toEqual(expect.any(String));
      expect(finished.json().finishedAt).toEqual(expect.any(String));
      const listed = await get(admin, `${BASE}/campaigns?status=finished&limit=100`);
      expect((listed.json().items as { id: number }[]).map((item) => item.id)).toContain(id);

      // the copy that waits is called off, as the flow ends
      expect((await post(admin, `${BASE}/campaigns/${secondCopy.id}/cancel`)).statusCode).toBe(200);
      planned.splice(0);

      // root reads what the admin did to the campaign, step by step, and who gave the right
      const log = await get(
        rootSession,
        `/api/admin/audit-log?entityType=newsletter_campaign&entityId=${id}&sortBy=id&sortOrder=asc`,
      );
      expect(log.statusCode).toBe(200);
      const lines = log.json().items as {
        event: string;
        actorId: number;
        changes: { field: string; old: unknown; new: unknown }[];
      }[];
      expect(lines.map((line) => line.event)).toEqual([
        'newsletter.campaign_created',
        'newsletter.campaign_updated',
        'newsletter.campaign_updated',
        'newsletter.campaign_test_sent',
        'newsletter.campaign_test_sent',
        'newsletter.campaign_test_sent',
        'newsletter.campaign_scheduled',
      ]);
      expect(lines.every((line) => line.actorId === personId)).toBe(true);
      // the test mails name the accounts they went to and the language, never an address
      const sentTo = lines.filter((line) => line.event === 'newsletter.campaign_test_sent');
      expect(sentTo.map((line) => line.changes)).toEqual(
        testSent.map(([, locale], index) => [
          { field: 'recipientId', old: null, new: [colleague, root, person][index]!.id },
          { field: 'locale', old: null, new: locale },
        ]),
      );

      const granted = await get(
        rootSession,
        `/api/admin/audit-log?entityType=user&entityId=${personId}&actions=NEWSLETTER_MANAGER_CHANGE`,
      );
      expect(
        (granted.json().items as { event: string; actorId: number }[]).map((line) => [
          line.event,
          line.actorId,
        ]),
      ).toEqual([['newsletter.manager_granted', root.id]]);
      expect(desk.problems()).toEqual([]);
    } finally {
      // whatever happened, nothing stays scheduled and the limit of the shop is as it was found
      for (const id of planned) {
        await app.inject({
          method: 'POST',
          url: `${BASE}/campaigns/${id}/cancel`,
          headers: withCsrf(csrf, accessCookie(root)),
        });
      }
      const again = await signIn(app, csrf, root);
      for (const [key, value] of [
        ['newsletterLimitCount', limitBefore.count],
        ['newsletterLimitDays', limitBefore.days],
      ] as const) {
        await put(again, `/api/root/shop-settings/${key}`, value);
      }
      await deleteProductFromCatalog(shirt.id);
      await deleteProductFromCatalog(gone.id);
    }
  });
});
