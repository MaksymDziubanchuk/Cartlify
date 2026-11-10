import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { createUser } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  BASE,
  arrange,
  errorAnswer,
  forget,
  journalOf,
  rowsOf,
} from '../../../helpers/newsletterApi.js';
import { DAY } from '../../../helpers/newsletterFns.js';
import {
  campaignIn,
  recipientIn,
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
} from '../../../helpers/newsletterDb.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

// The one-click unsubscribe of a mail client (RFC 8058). Every mail of the newsletters carries a
// List-Unsubscribe header with this address and List-Unsubscribe-Post: List-Unsubscribe=One-Click;
// the client posts the form to it by itself, with no cookie and no csrf token, and takes any 2xx as
// done. The token is in the path (the standard asks for it), so the logs mask it

let app: FastifyInstance;
let fixtures: NewsletterFixtures;
let finishedCampaign: number;
let draftCampaign: number;
const emails: string[] = [];

const FORM = 'application/x-www-form-urlencoded';

// what a mail client sends: the form of RFC 8058, nothing else
const click = (token: string, query = '', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `${BASE}/unsubscribe/${token}${query}`,
    headers: { 'content-type': FORM, ...headers },
    payload: 'List-Unsubscribe=One-Click',
  });

const unsubscribedCount = (campaign: number) =>
  inOwnerTx(async (db) => {
    const [row] = await db.rows<{ n: number }>(
      'select "unsubscribedCount" as n from cartlify.newsletter_campaigns where id = $1',
      campaign,
    );
    return row!.n;
  });

// a subscription the campaign mailed: a row of its recipients (the unsubscribe is counted by the
// campaign only for a subscription it has a mail to; the row goes with the subscription)
const mailedBy = (campaign: number, subscriptionId: number) =>
  inOwnerTx((db) => recipientIn(db, campaign, subscriptionId), { commit: true });

beforeAll(async () => {
  app = await startApp();
  fixtures = await setupNewsletterFixtures();
  draftCampaign = fixtures.campaign;
  // a campaign that went out long ago: it counts the unsubscribes it caused and stays clear of the
  // windows of the limit of campaigns, which look at the days around a start
  finishedCampaign = await inOwnerTx(
    (db) =>
      campaignIn(db, { role: 'ADMIN', userId: fixtures.manager.id }, 'finished', utc(-400 * DAY)),
    { commit: true },
  );
});

afterAll(async () => {
  try {
    await forget(emails);
    await removeNewsletterFixtures(fixtures);
  } finally {
    await stopApp();
  }
});

async function live(opts: Parameters<typeof arrange>[0] = {}) {
  const row = await arrange(opts);
  emails.push(row.email);
  return row;
}

describe('POST /api/newsletters/unsubscribe/:token', () => {
  it('ends the subscription at once, with no cookie and no csrf token', async () => {
    const row = await live();

    const res = await click(row.unsubscribeToken, '', {
      'x-forwarded-for': '198.51.100.71',
      'user-agent': 'GoogleMail-unsubscribe',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    expect((await rowsOf(row.email))[0]).toMatchObject({
      status: 'ended',
      endReason: 'unsubscribed',
    });
    expect(await journalOf(row.email)).toEqual([
      expect.objectContaining({
        event: 'unsubscribed',
        place: 'mail_client',
        ip: '198.51.100.71',
        userAgent: 'GoogleMail-unsubscribe',
        campaignId: null,
      }),
    ]);
  });

  it('is harmless a second time: the same answer, nothing more written', async () => {
    const row = await live();

    const first = await click(row.unsubscribeToken);
    const second = await click(row.unsubscribeToken);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ unsubscribed: true });
    expect(await journalOf(row.email)).toHaveLength(1);
  });

  it.each([
    ['the form of RFC 8058', FORM, 'List-Unsubscribe=One-Click'],
    ['the form with a field more', FORM, 'List-Unsubscribe=One-Click&utm=x'],
    ['an empty form', FORM, ''],
  ])('takes %s', async (_case, contentType, payload) => {
    const row = await live();

    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/unsubscribe/${row.unsubscribeToken}`,
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
  });

  it('takes a post with no body at all, as some mail clients send it', async () => {
    const row = await live();

    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/unsubscribe/${row.unsubscribeToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
  });

  it('ends a subscription of an account and one paused by a complaint', async () => {
    const user = await createUser();
    const account = await live({ source: 'account', userId: user.id });
    const paused = await live({ status: 'paused_complaint' });

    for (const row of [account, paused]) {
      expect((await click(row.unsubscribeToken)).statusCode).toBe(200);
      expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
    }
  });

  it('answers a subscription that is gone already with 200, as a second click', async () => {
    const ended = await live({ status: 'ended' });
    const stopped = await live({ status: 'stopped_bounce' });
    const waiting = await live({ status: 'pending' });

    for (const row of [ended, stopped, waiting]) {
      const res = await click(row.unsubscribeToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unsubscribed: true });
    }
    expect((await rowsOf(waiting.email))[0]).toMatchObject({ status: 'pending' });
  });

  it('refuses a token nobody was given', async () => {
    const res = await click('a-token-nobody-was-given');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });

  it('refuses the token of the page of management of the same subscription, and ends nothing', async () => {
    const row = await live();

    const res = await click(row.manageToken);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'active' });
    expect(await journalOf(row.email)).toEqual([]);
  });

  it('refuses every wrong token with one and the same answer', async () => {
    const answers = [];
    for (const token of ['x', 'a-token-nobody-was-given', 'A'.repeat(43), 'a'.repeat(100)]) {
      answers.push(errorAnswer(await click(token)));
    }

    expect(answers).toEqual(Array(answers.length).fill(answers[0]));
  });

  describe('the campaign the mail came from', () => {
    it('counts the unsubscribe for the campaign, and names it in the journal', async () => {
      const row = await live();
      await mailedBy(finishedCampaign, row.id);
      const before = await unsubscribedCount(finishedCampaign);

      const res = await click(row.unsubscribeToken, `?c=${finishedCampaign}`);

      expect(res.statusCode).toBe(200);
      expect(await unsubscribedCount(finishedCampaign)).toBe(before + 1);
      expect(await journalOf(row.email)).toEqual([
        expect.objectContaining({ event: 'unsubscribed', campaignId: finishedCampaign }),
      ]);
    });

    it('counts a subscription once, however often the button is pressed', async () => {
      const row = await live();
      await mailedBy(finishedCampaign, row.id);
      const before = await unsubscribedCount(finishedCampaign);

      await click(row.unsubscribeToken, `?c=${finishedCampaign}`);
      await click(row.unsubscribeToken, `?c=${finishedCampaign}`);

      expect(await unsubscribedCount(finishedCampaign)).toBe(before + 1);
    });

    // the id of the campaign is in the address of the link, so a campaign that went out but never mailed
    // this subscription counts nothing: the unsubscribe works, the journal names no campaign
    it('counts nothing for a campaign that went out and never mailed this subscription', async () => {
      const row = await live();
      const before = await unsubscribedCount(finishedCampaign);

      const res = await click(row.unsubscribeToken, `?c=${finishedCampaign}`);

      expect(res.statusCode).toBe(200);
      expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
      expect(await journalOf(row.email)).toEqual([expect.objectContaining({ campaignId: null })]);
      expect(await unsubscribedCount(finishedCampaign)).toBe(before);
    });

    // an address that mailed nothing out yet has nothing to count: the unsubscribe still works
    it.each([
      ['a campaign that has sent nothing', () => draftCampaign],
      ['a campaign that does not exist', () => 2_000_000_000],
    ])('ends the subscription and counts nothing for %s', async (_case, campaign) => {
      const row = await live();
      const before = await unsubscribedCount(finishedCampaign);

      const res = await click(row.unsubscribeToken, `?c=${campaign()}`);

      expect(res.statusCode).toBe(200);
      expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
      expect(await journalOf(row.email)).toEqual([expect.objectContaining({ campaignId: null })]);
      expect(await unsubscribedCount(finishedCampaign)).toBe(before);
    });

    // the address is ours to build, so a reader cannot make the button fail with a bad c
    it.each(['abc', '0', '-3', '1.5', '99999999999', ''])(
      'ignores a campaign id it cannot read (c=%s) and unsubscribes',
      async (value) => {
        const row = await live();

        const res = await click(row.unsubscribeToken, `?c=${value}`);

        expect(res.statusCode).toBe(200);
        expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
      },
    );
  });

  describe('the logs', () => {
    // the token is in the path, so the request log and the log of a refusal hide it
    it('hide the token of the link in the line of the request and in the line of a refusal', async () => {
      const row = await live();
      app.log.level = 'info';

      try {
        await click(row.unsubscribeToken, `?c=${finishedCampaign}`);
        await click('a-token-nobody-was-given');
        await app.inject({
          method: 'POST',
          url: `${BASE}/unsubscribe/${row.unsubscribeToken}/extra`,
          headers: { 'content-type': FORM },
          payload: '',
        });
        // the router reads an encoded letter of the path as the letter, so the log must too
        await app.inject({
          method: 'POST',
          url: `${BASE}/%75nsubscribe/${row.unsubscribeToken}`,
          headers: { 'content-type': FORM },
          payload: '',
        });
      } finally {
        app.log.level = 'warn';
      }

      const lines = takeLogs({});
      const text = JSON.stringify(lines);

      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(text).not.toContain(row.unsubscribeToken);
      expect(text).not.toContain('a-token-nobody-was-given');
      expect(text).toContain('/api/newsletters/unsubscribe/[hidden]?c=');
      expect(text).toContain('"errorCode":"NEWSLETTER_LINK_INVALID"');
    });
  });
});

// The same address opened with a GET: the person pressing the unsubscribe button of a mail program
// that opens the link in a browser (or a scanner that follows every link). A GET changes nothing; it
// sends the browser to the page "Manage the subscription" with the token after the #, and the page
// shows one button that posts to the same address
describe('GET /api/newsletters/unsubscribe/:token', () => {
  const MANAGE_PAGE_URL = 'https://shop.example.com/newsletter/manage';

  const open = (token: string, query = '', headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `${BASE}/unsubscribe/${token}${query}`, headers });

  it('sends the browser to the page of management with the token after the #, and changes nothing', async () => {
    const row = await live();

    const res = await open(row.unsubscribeToken, '', {
      'x-forwarded-for': '198.51.100.72',
      'user-agent': 'Mozilla/5.0',
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${MANAGE_PAGE_URL}#unsubscribe=${row.unsubscribeToken}`);
    expect(new URL(String(res.headers.location)).search).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('');
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'active' });
    expect(await journalOf(row.email)).toEqual([]);
  });

  // a scanner opens every link of a mail: once or ten times, nobody is unsubscribed by it
  it('unsubscribes nobody however often it is opened', async () => {
    const row = await live();

    for (let i = 0; i < 3; i += 1) expect((await open(row.unsubscribeToken)).statusCode).toBe(303);

    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'active' });
    expect(await journalOf(row.email)).toEqual([]);
  });

  it('carries the campaign of the mail to the page, so its post can count the unsubscribe', async () => {
    const row = await live();

    const res = await open(row.unsubscribeToken, `?c=${finishedCampaign}`);

    expect(res.headers.location).toBe(
      `${MANAGE_PAGE_URL}#unsubscribe=${row.unsubscribeToken}&c=${finishedCampaign}`,
    );
  });

  it.each(['abc', '0', '-3', '1.5', '99999999999', ''])(
    'leaves a campaign id it cannot read (c=%s) out of the page address',
    async (value) => {
      const row = await live();

      const res = await open(row.unsubscribeToken, `?c=${value}`);

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${MANAGE_PAGE_URL}#unsubscribe=${row.unsubscribeToken}`);
    },
  );

  // the GET looks nothing up, so the redirect cannot tell a token somebody was given from one nobody
  // was: the page learns it from the post
  it('redirects a token nobody was given, a token of the page of management and a token of an ended subscription alike', async () => {
    const row = await live();
    const ended = await live({ status: 'ended' });

    const answers = [];
    for (const token of ['a-token-nobody-was-given', row.manageToken, ended.unsubscribeToken]) {
      const res = await open(token);
      answers.push(res.statusCode);
      expect(res.headers.location).toBe(`${MANAGE_PAGE_URL}#unsubscribe=${token}`);
    }

    expect(answers).toEqual([303, 303, 303]);
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'active' });
  });

  it('keeps a token that is not url-safe whole inside the fragment', async () => {
    const res = await open('a%26b%3Dc%23d');

    expect(res.statusCode).toBe(303);
    const url = new URL(String(res.headers.location));
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('unsubscribe')).toBe('a&b=c#d');
  });

  it('is the address the post of the page goes to: the page unsubscribes with what it read after the #', async () => {
    const row = await live();
    await mailedBy(finishedCampaign, row.id);
    const opened = await open(row.unsubscribeToken, `?c=${finishedCampaign}`);
    const before = await unsubscribedCount(finishedCampaign);

    const fragment = new URLSearchParams(new URL(String(opened.headers.location)).hash.slice(1));
    const res = await click(
      fragment.get('unsubscribe')!,
      fragment.get('c') ? `?c=${fragment.get('c')}` : '',
    );

    expect(res.statusCode).toBe(200);
    expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
    expect(await unsubscribedCount(finishedCampaign)).toBe(before + 1);
  });

  it('hides the token in the line of the request', async () => {
    const row = await live();
    app.log.level = 'info';

    try {
      await open(row.unsubscribeToken, `?c=${finishedCampaign}`);
    } finally {
      app.log.level = 'warn';
    }

    const text = JSON.stringify(takeLogs({}));
    expect(text).not.toContain(row.unsubscribeToken);
    expect(text).toContain('/api/newsletters/unsubscribe/[hidden]?c=');
  });
});
