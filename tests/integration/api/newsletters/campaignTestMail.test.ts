import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { takeLogs } from '../../../helpers/logs.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { accessCookie } from '../../../helpers/actors.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { dictionaryText } from '../../../helpers/dictionary.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
} from '../../../helpers/factories.js';
import { refuseMail, watchNewsletterMail, type SentMail } from '../../../helpers/mail.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';
import {
  arrange,
  errorAnswer,
  forget,
  journalOf,
  newsletterApi,
  rowsOf,
} from '../../../helpers/newsletterApi.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  draftOf,
  forgetCampaigns,
  moveTo,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// POST /api/newsletters/campaigns/:campaignId/test: the test mail of a campaign, a real mail through the
// stream of the newsletters, as a subscriber would get it in the language chosen but for two marks (a
// word "test" in front of the subject and a line at the top that says the subscribers did not get
// it), to the address of an admin or of root and to no other. Its links of the subscription lead
// nowhere: the page says the link is not valid and the one-click unsubscribe does nothing

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
let hub: ReturnType<typeof newsletterApi>;
let shirt: TestProduct;
let id: number;
const made: number[] = [];
const extraUserIds: number[] = [];
const subscribed: string[] = [];

const NO_ROW = 2_147_483_647;
const LOGO =
  'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/test-mail.png';

// the two marks of a test mail, in the language of the mail
const marksOf = (locale: string) => ({
  prefix: dictionaryText(locale, 'campaignMail.testSubjectPrefix'),
  notice: dictionaryText(locale, 'campaignMail.testNotice'),
});

const content = (productId: number) => ({
  subject: { en: 'Spring sale', es: 'Rebajas de primavera' },
  preview: { en: 'Up to 30% off' },
  blocks: [
    { type: 'text', text: { en: 'The **best** prices', es: 'Los **mejores** precios' } },
    { type: 'products', source: 'manual', productIds: [productId] },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

const send = (to: string, locale: unknown = 'en', user = staff.manager, campaign = id) =>
  api.testMail(user, campaign, { email: to, locale });

// the token of a link "Manage the subscription" in a mail, and the address of its unsubscribe header
const manageTokenOf = (mail: SentMail) =>
  /\/newsletter\/manage#token=([^\s"&<]+)/.exec(mail.text)![1]!;
const unsubscribeUrlOf = (mail: SentMail) =>
  /^<(https:\/\/api\.example\.com\/api\/newsletters\/unsubscribe\/[^?>]+\?c=\d+)>$/.exec(
    mail.headers['List-Unsubscribe'] ?? '',
  )![1]!;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
  hub = newsletterApi(app, csrf);
  shirt = await createProduct({ name: 'Tested shirt', price: 30, stock: 10 });
  id = await draftOf(api, staff.manager, { content: content(shirt.id) });
  made.push(id);
});

afterAll(async () => {
  try {
    await forget(subscribed);
    await forgetCampaigns(api, staff.manager, made);
    await deleteProductFromCatalog(shirt.id);
    await closeStaff(staff);
    await closeSessions(extraUserIds);
  } finally {
    await stopApp();
  }
});

afterEach(() => resetShopSettings());

describe('POST /api/newsletters/campaigns/:campaignId/test, the mail', () => {
  it('sends the mail to the address, through the stream of the newsletters, and answers that it did', async () => {
    const sent = watchNewsletterMail();

    const res = await send(staff.manager.email);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      stream: 'newsletter',
      to: [staff.manager.email],
      from: process.env.NEWSLETTER_EMAIL_FROM,
      replyTo: null,
      subject: `${marksOf('en').prefix} Spring sale`,
      categories: ['newsletter'],
      status: 202,
      accepted: true,
    });
    expect(sent[0]!.html).toContain('Tested shirt');
    expect(sent[0]!.text).toContain('The best prices');
  });

  it('carries the headers of the one-click unsubscribe and none of the tracking of SendGrid', async () => {
    const sent = watchNewsletterMail();

    await send(staff.manager.email);

    expect(sent[0]!.headers).toEqual({
      'List-Unsubscribe': expect.stringMatching(
        /^<https:\/\/api\.example\.com\/api\/newsletters\/unsubscribe\/[A-Za-z0-9_-]{43}\?c=\d+>$/,
      ),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(sent[0]!.headers['List-Unsubscribe']).toContain(`?c=${id}>`);
    expect(sent[0]!.tracking).toMatchObject({
      click_tracking: { enable: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    });
  });

  it('puts no address and no token in the marks that come back with the events of SendGrid', async () => {
    const sent = watchNewsletterMail();

    await send(staff.manager.email);

    // the sender adds the ids of the campaign and of the recipient when a subscriber gets the mail; a
    // test mail has no recipient of the campaign
    expect(sent[0]!.customArgs).toEqual({});
  });

  it.each([
    ['en', 'Spring sale', 'The best prices'],
    ['es', 'Rebajas de primavera', 'Los mejores precios'],
  ])('writes the whole mail in the language chosen: %s', async (locale, subject, words) => {
    const sent = watchNewsletterMail();

    await send(staff.manager.email, locale);

    expect(sent[0]!.subject).toBe(`${marksOf(locale).prefix} ${subject}`);
    expect(sent[0]!.text).toContain(words);
    expect(sent[0]!.html).toContain(`<html lang="${locale}">`);
    expect(sent[0]!.text).toContain(dictionaryText(locale, 'campaignMail.manage'));
    expect(sent[0]!.text).toContain(dictionaryText(locale, 'campaignMail.automatic'));
  });

  // the admin is told it is a test, twice: in the list of mails and at the top of the mail itself, so
  // a test mail that is forwarded is not taken for the newsletter
  it.each(['en', 'es'])(
    'is marked as a test, in the subject and at the top: %s',
    async (locale) => {
      const sent = watchNewsletterMail();
      const { prefix, notice } = marksOf(locale);

      await send(staff.manager.email, locale);

      const mail = sent[0]!;
      expect(mail.subject.startsWith(`${prefix} `)).toBe(true);
      expect(mail.text.startsWith(notice)).toBe(true);
      expect(mail.html).toContain(notice);
      // the notice is the first thing of the page, before any block of the campaign
      expect(mail.html.indexOf(notice)).toBeLessThan(mail.html.indexOf('Tested shirt'));
    },
  );

  // the preview is the same mail with the links of the subscription pointing at the shop; once those
  // and the two marks of a test are put aside the bodies are the same
  it('has the body the preview shows', async () => {
    const sent = watchNewsletterMail();
    const preview = await api.preview(staff.manager, id, { locale: 'en' });
    const { prefix, notice } = marksOf('en');

    await send(staff.manager.email);

    const plain = (body: string) =>
      body
        .replace(/https:\/\/shop\.example\.com\/newsletter\/manage#token=[A-Za-z0-9_-]+/g, 'MANAGE')
        .replace(/https:\/\/shop\.example\.com\/(?=["\s<]|$)/g, 'MANAGE');
    const row = new RegExp(`\\s*<tr>\\s*<td[^>]*>\\s*${notice}\\s*</td>\\s*</tr>`);
    const withoutMarks = (html: string) =>
      html.replace(row, '').replace(`<title>${prefix} `, '<title>');

    expect(plain(withoutMarks(sent[0]!.html))).toBe(plain(preview.json().html));
    expect(plain(sent[0]!.text)).toBe(`${notice}\n\n${plain(preview.json().text)}`);
    expect(sent[0]!.subject).toBe(`${prefix} ${preview.json().subject}`);
  });

  it('does not mark the preview as a test: it shows the mail of a subscriber', async () => {
    const preview = await api.preview(staff.manager, id, { locale: 'en' });
    const { prefix, notice } = marksOf('en');

    expect(preview.json().subject).toBe('Spring sale');
    expect(preview.json().html).not.toContain(notice);
    expect(preview.json().text).not.toContain(notice);
    expect(preview.json().subject).not.toContain(prefix);
  });

  it('shows the logo of the shop by its address, the way every mail of the shop does', async () => {
    setShopSettings({ logoUrl: LOGO });
    const sent = watchNewsletterMail();

    await send(staff.manager.email);

    expect(sent[0]!.attachments).toEqual([]);
    expect(sent[0]!.html).toContain(`<img src="${LOGO}"`);
    expect(sent[0]!.html).not.toContain('cid:');
  });

  it('has no image of a logo while the shop has none', async () => {
    setShopSettings({ logoUrl: null });
    const sent = watchNewsletterMail();

    await send(staff.manager.email);

    expect(sent[0]!.attachments).toEqual([]);
    expect(sent[0]!.html).not.toContain(LOGO);
    expect(sent[0]!.html).not.toContain('cid:');
  });

  it('sends the mail of a campaign of any state', async () => {
    const sent = watchNewsletterMail();

    for (const state of ['scheduled', 'sending', 'finished', 'stopped', 'cancelled'] as const) {
      const campaign = await draftOf(api, staff.manager, { content: content(shirt.id) });
      made.push(campaign);
      await moveTo(staff.manager, campaign, state);

      expect((await send(staff.manager.email, 'en', staff.manager, campaign)).statusCode).toBe(200);
    }

    expect(sent).toHaveLength(5);
  });

  it('has no wait between two: the same admin can ask again at once, within the limit of the hour', async () => {
    const sent = watchNewsletterMail();

    for (let time = 0; time < 12; time++) {
      expect((await send(staff.manager.email)).statusCode).toBe(200);
    }

    expect(sent).toHaveLength(12);
  });

  it('takes the products from the catalog at the moment of the request', async () => {
    const lamp = await createProduct({ name: 'Passing lamp', stock: 5 });
    const campaign = await draftOf(api, staff.manager, { content: content(lamp.id) });
    made.push(campaign);
    const sent = watchNewsletterMail();

    await send(staff.manager.email, 'en', staff.manager, campaign);
    await deleteProductFromCatalog(lamp.id);
    await send(staff.manager.email, 'en', staff.manager, campaign);

    expect(sent[0]!.html).toContain('Passing lamp');
    expect(sent[1]!.html).not.toContain('Passing lamp');
  });
});

// A test mail is a real mail through the stream of the newsletters, to the address of an admin: a loop
// could fill the mailbox of one, or use up the plan of the stream. A user may ask LIMIT_NEWSLETTER_TEST_PER_USER
// times an hour (30 unless set), counted for the user after the guards. The other files of the
// integration tests raise every limit a thousand times, so these cases ask as the server has it
describe('POST /api/newsletters/campaigns/:campaignId/test, the limit of the requests', () => {
  const scale = env.REQUEST_LIMITS_SCALE;
  const was = env.LIMIT_NEWSLETTER_TEST_PER_USER;

  // an admin of the newsletters with a count of their own, and the limit the case sets
  async function limited(max: number, right = true) {
    env.REQUEST_LIMITS_SCALE = 1;
    env.LIMIT_NEWSLETTER_TEST_PER_USER = max;
    const admin = await createUser({ role: 'ADMIN' });
    extraUserIds.push(admin.id);
    if (right) await giveNewsletterRight(staff.root.id, admin.id);

    return admin;
  }

  afterEach(() => {
    env.REQUEST_LIMITS_SCALE = scale;
    env.LIMIT_NEWSLETTER_TEST_PER_USER = was;
  });

  it('refuses the request past the limit, for that user only, and sends nothing for it', async () => {
    const admin = await limited(2);
    const sent = watchNewsletterMail();

    expect((await send(admin.email, 'en', admin)).statusCode).toBe(200);
    expect((await send(admin.email, 'en', admin)).statusCode).toBe(200);
    const refused = await send(admin.email, 'en', admin);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'newsletterTest' },
    });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(sent).toHaveLength(2);

    // the count is the user's own, and the translation has a count of its own
    const other = await limited(2);
    expect((await send(other.email, 'en', other)).statusCode).toBe(200);
  });

  it('counts the requests of all the campaigns and all the addresses of the user together', async () => {
    const admin = await limited(2);
    const second = await draftOf(api, staff.manager, { content: content(shirt.id) });
    made.push(second);

    expect((await send(admin.email, 'en', admin, id)).statusCode).toBe(200);
    expect((await send(staff.manager.email, 'en', admin, second)).statusCode).toBe(200);

    expect((await send(admin.email, 'en', admin, id)).statusCode).toBe(429);
  });

  it('does not count the request the guards refuse', async () => {
    const admin = await limited(1, false);
    const sent = watchNewsletterMail();

    for (let i = 0; i < 3; i += 1) {
      const res = await send(admin.email, 'en', admin);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
    }
    await giveNewsletterRight(staff.root.id, admin.id);

    expect((await send(admin.email, 'en', admin)).statusCode).toBe(200);
    expect((await send(admin.email, 'en', admin)).statusCode).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it('counts the request that fails after the limit, not the one the schema refuses', async () => {
    const admin = await limited(1);

    // refused by the schema, before the limit
    expect((await api.testMail(admin, id, {})).statusCode).toBe(400);
    // a campaign that is not there: it passed the limit, so it counts
    expect((await send(admin.email, 'en', admin, NO_ROW)).statusCode).toBe(404);

    expect((await send(admin.email, 'en', admin)).statusCode).toBe(429);
  });

  it('keeps to the setting: more requests when it is higher', async () => {
    const admin = await limited(4);

    for (let i = 0; i < 4; i += 1) {
      expect((await send(admin.email, 'en', admin)).statusCode).toBe(200);
    }
    expect((await send(admin.email, 'en', admin)).statusCode).toBe(429);
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, the links of the subscription', () => {
  it('lead nowhere: the page says the link is not valid and nothing is touched', async () => {
    const reader = await arrange({ source: 'form', status: 'active' });
    subscribed.push(reader.email);
    const before = { rows: await rowsOf(reader.email), journal: await journalOf(reader.email) };
    const sent = watchNewsletterMail();

    await send(staff.manager.email);
    const mail = sent[0]!;

    // the page "Manage the subscription": the token of the mail is nobody's
    const page = await hub.post('/api/newsletters/manage', { token: manageTokenOf(mail) });
    expect(page.statusCode).toBe(400);
    expect(page.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

    // the one-click unsubscribe of the mail program: nothing to end
    const url = new URL(unsubscribeUrlOf(mail));
    const click = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(click.statusCode).toBe(400);
    expect(click.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

    expect(await rowsOf(reader.email)).toEqual(before.rows);
    expect(await journalOf(reader.email)).toEqual(before.journal);
    expect((await rowsOf(reader.email))[0]!.status).toBe('active');
  });

  it('are another token every time, in the page and in the header alike', async () => {
    const sent = watchNewsletterMail();

    await send(staff.manager.email);
    await send(staff.manager.email);

    expect(manageTokenOf(sent[0]!)).not.toBe(manageTokenOf(sent[1]!));
    for (const mail of sent) {
      expect(unsubscribeUrlOf(mail)).toContain(`/unsubscribe/${manageTokenOf(mail)}?c=`);
    }
  });

  it('are not the link of a subscription of the admin who asked', async () => {
    const own = await arrange({ source: 'form', email: staff.manager.email });
    subscribed.push(own.email);
    const sent = watchNewsletterMail();

    await send(staff.manager.email);

    expect(manageTokenOf(sent[0]!)).not.toBe(own.manageToken);
    expect(sent[0]!.text).not.toContain(own.manageToken);
    const rows = await rowsOf(own.email);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, who gets it', () => {
  it('lets the admin who asks send it to their own address', async () => {
    const sent = watchNewsletterMail();

    expect((await send(staff.plainAdmin.email, 'en', staff.manager)).statusCode).toBe(200);
    expect(sent[0]!.to).toEqual([staff.plainAdmin.email]);
  });

  it.each([
    ['their own address', () => staff.manager.email],
    ['the address of another admin', () => staff.plainAdmin.email],
    ['the address of root', () => staff.root.email],
  ])('lets a manager send it to %s', async (_case, to) => {
    const sent = watchNewsletterMail();

    const res = await send(to(), 'en', staff.manager);

    expect(res.statusCode).toBe(200);
    expect(sent.map((mail) => mail.to)).toEqual([[to()]]);
  });

  it('lets root send it to the address of an admin', async () => {
    const sent = watchNewsletterMail();

    const res = await send(staff.manager.email, 'en', staff.root);

    expect(res.statusCode).toBe(200);
    expect(sent[0]!.to).toEqual([staff.manager.email]);
  });

  it('takes the address as the accounts keep it: spaces round it and its case do not matter', async () => {
    const sent = watchNewsletterMail();

    const res = await send(`  ${staff.manager.email.toUpperCase()} `);

    expect(res.statusCode).toBe(200);
    expect(sent[0]!.to).toEqual([staff.manager.email]);
  });

  describe('is refused, the same for every address that is not one of an admin or of root', () => {
    let deletedAdmin: { id: number; email: string };

    beforeAll(async () => {
      const admin = await createUser({ role: 'ADMIN' });
      extraUserIds.push(admin.id);
      const email = admin.email;
      // the account was deleted (root does it; the address is not the admin's any more)
      await inOwnerTx(
        async (db) => {
          await db.as({ role: 'ROOT', userId: staff.root.id });
          await db.rows(
            `update cartlify.users set "deletedAt" = (now() at time zone 'utc') where id = $1`,
            admin.id,
          );
        },
        { commit: true },
      );
      deletedAdmin = { id: admin.id, email };
    });

    const refusals = () => [
      ['the address of a user', staff.user.email],
      ['an address nobody has', 'nobody-has-this-address@example.com'],
      ['an address that is not one', 'not-an-address'],
      ['an address of another domain', 'someone@elsewhere.example'],
      ['a part of the address of an admin', staff.manager.email.slice(0, -4)],
      ['the address of an admin with a part added', `x${staff.manager.email}`],
      ['the address of an admin with a wildcard', staff.manager.email.replace(/^./, '%')],
      ['a list of addresses', `${staff.manager.email}, ${staff.root.email}`],
      ['an address with a new line', `${staff.manager.email}\nBcc: ${staff.user.email}`],
    ];

    it('is 403 NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED, and no mail goes', async () => {
      const sent = watchNewsletterMail();

      for (const [, to] of refusals()) {
        const res = await send(to!);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED' });
      }

      expect(sent).toEqual([]);
    });

    it('says the same for all of them: the answer does not tell a user from a stranger', async () => {
      const answers = [];
      for (const [, to] of refusals()) answers.push(errorAnswer(await send(to!)));

      for (const answer of answers) expect(answer).toEqual(answers[0]);
    });

    it('refuses the address of an account that was deleted', async () => {
      const sent = watchNewsletterMail();

      const res = await send(deletedAdmin.email);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED' });
      expect(sent).toEqual([]);
    });

    it('refuses an address that is only a subscriber, an admin or not', async () => {
      const reader = await arrange({ source: 'form' });
      subscribed.push(reader.email);
      const sent = watchNewsletterMail();

      const res = await send(reader.email);

      expect(res.statusCode).toBe(403);
      expect(sent).toEqual([]);
    });
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, the log of the admins', () => {
  it('writes one line with the campaign and the account of the recipient, never the address', async () => {
    const before = (await campaignLinesOf(id)).length;
    const row = (await campaignRowOf(id))!;

    await send(staff.plainAdmin.email, 'es', staff.root);

    const lines = (await campaignLinesOf(id)).slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_test_sent',
    });
    const written = JSON.stringify(lines[0]);
    expect(written).toContain(String(staff.plainAdmin.id));
    expect(written).not.toContain(staff.plainAdmin.email);
    expect(written).not.toContain('@');
    // the campaign itself is not touched
    expect((await campaignRowOf(id))!.updatedAt).toEqual(row.updatedAt);
  });

  it('writes no line for a mail that was refused', async () => {
    const before = (await campaignLinesOf(id)).length;

    await send(staff.user.email);

    expect((await campaignLinesOf(id)).length).toBe(before);
  });

  it('writes no line when SendGrid does not take the mail', async () => {
    const before = (await campaignLinesOf(id)).length;
    refuseMail('newsletter');

    const res = await send(staff.manager.email);

    expect(res.statusCode).toBe(502);
    takeLogs({ msg: 'request failed' });
    expect((await campaignLinesOf(id)).length).toBe(before);
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, when the mail is not taken', () => {
  it('is a bad gateway, as the mails of the other routes are, with no word of the provider', async () => {
    refuseMail('newsletter');

    const res = await send(staff.manager.email);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_TEST_SEND_FAILED',
      message: 'Bad Gateway',
    });
    expect(JSON.stringify(res.json())).not.toMatch(/credit|SendGrid|sendgrid/i);
    takeLogs({ msg: 'request failed' });
  });

  it('is only a refusal of the provider: the stream of the orders does not matter', async () => {
    refuseMail('orders');
    const sent = watchNewsletterMail();

    expect((await send(staff.manager.email)).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, the logs', () => {
  // every line of the log of the server, the lines of a request that went well and of one that did
  // not included: the level is lowered for the test so the lines about the requests are there too
  it('keep the address of the recipient and the tokens of the links out of every line', async () => {
    app.log.level = 'info';
    try {
      const sent = watchNewsletterMail();

      await send(staff.manager.email);
      await send(staff.user.email);
      refuseMail('newsletter');
      await send(staff.manager.email);

      const lines = takeLogs({}).map((entry) => JSON.stringify(entry));
      const token = manageTokenOf(sent[0]!);
      expect(lines.length).toBeGreaterThan(2);
      expect(lines.some((line) => line.includes('request failed'))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain(staff.manager.email);
        expect(line).not.toContain(staff.user.email);
        expect(line).not.toContain(token);
      }
    } finally {
      app.log.level = process.env.TEST_LOG_LEVEL ?? 'warn';
    }
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/test, the refusals of the request', () => {
  it('looks for the campaign first', async () => {
    const res = await send(staff.user.email, 'xx', staff.manager, NO_ROW);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_CAMPAIGN_NOT_FOUND' });
  });

  it.each([
    ['a language the shop does not answer in', 'xx', 'LOCALE_INVALID'],
    ['a language the campaign has no subject in', 'uk', 'NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN'],
  ])('refuses %s, before the address is judged', async (_case, locale, errorCode) => {
    const sent = watchNewsletterMail();

    const res = await send(staff.user.email, locale);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(sent).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['no address', { locale: 'en' }],
    ['no language', { email: 'a@b.c' }],
    ['an address that is no text', { email: 5, locale: 'en' }],
    ['a language that is no text', { email: 'a@b.c', locale: 5 }],
    ['an empty address', { email: '', locale: 'en' }],
    [
      'an address over the longest an address may be',
      { email: `${'a'.repeat(251)}@b.c`, locale: 'en' },
    ],
    ['a field the route does not take', { email: 'a@b.c', locale: 'en', subject: 'x' }],
  ])('refuses %s with VALIDATION_ERROR', async (_case, payload) => {
    const res = await api.testMail(staff.manager, id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a request without the csrf token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/newsletters/campaigns/${id}/test`,
      headers: { cookie: accessCookie(staff.manager) },
      payload: { email: staff.manager.email, locale: 'en' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });

  it('is for the managers only, and a refused person gets nothing sent', async () => {
    const sent = watchNewsletterMail();

    const plain = await app.inject({
      method: 'POST',
      url: `/api/newsletters/campaigns/${id}/test`,
      headers: withCsrf(csrf, accessCookie(staff.plainAdmin)),
      payload: { email: staff.plainAdmin.email, locale: 'en' },
    });
    const user = await send(staff.user.email, 'en', staff.user);

    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
    expect(user.statusCode).toBe(403);
    expect(user.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(sent).toEqual([]);
  });
});
