import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import { prisma } from '@db/client.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  arrange,
  forget,
  journalOf,
  newsletterApi,
  rowsOf,
  type Arranged,
} from '../../../helpers/newsletterApi.js';
import { campaignRowOf } from '../../../helpers/newsletterCampaigns.js';
import { campaignIn, recipientIn, utc } from '../../../helpers/newsletterDb.js';
import { DAY } from '../../../helpers/newsletterFns.js';
import { closeStaff, createNewsletterStaff } from '../../../helpers/newsletterStaff.js';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_URL,
  deliverEvents,
  mailEvent,
  nowSeconds,
  requestOf,
  signerOfAnotherKey,
  type MailRef,
} from '../../../helpers/newsletterWebhook.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import type { NewsletterStaff } from '../../../helpers/newsletterStaff.js';

// POST /api/newsletters/sendgrid/webhook, the Event Webhook of the account that sends the newsletters.
// SendGrid posts a JSON list of the events of the mails it sent, signed with ECDSA (P-256): the
// signature is made over the timestamp header followed by the raw body, and the app checks it with the
// Verification Key (SENDGRID_NEWSLETTER_WEBHOOK_KEY) before it reads the body. Of the events it keeps
// three: a bounce (the address does not exist: the subscription ends), a drop and a spam report (the
// subscription pauses). Both webhooks of the account (dev and prod) hear every event of the account,
// the mails of the orders and the mails of the other environment too, so an event counts only when it
// carries the marks of a mail of this environment. The tests sign with the key pair of the test file
// (tests/helpers/newsletterWebhookKey.ts)

let app: FastifyInstance;
let staff: NewsletterStaff;
const emails: string[] = [];

type Mail = MailRef & { campaignId: number; recipientId: number; subscription: Arranged };

beforeAll(async () => {
  app = await startApp();
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

// a campaign that went out long ago (it stays clear of the windows of the limit of campaigns); the
// counters of each test are its own
async function oldCampaign(): Promise<number> {
  return inOwnerTx(
    (db) =>
      campaignIn(db, { role: 'ADMIN', userId: staff.manager.id }, 'finished', utc(-400 * DAY)),
    { commit: true },
  );
}

// a reader with a subscription in the state given and the mail of a campaign to it, in the state
// given: what the Event Webhook is about
async function mailTo(
  opts: {
    campaignId?: number;
    subscription?: 'active' | 'paused_complaint';
    recipient?: 'sent' | 'queued' | 'rejected' | 'skipped';
  } = {},
): Promise<Mail> {
  const subscription = await arrange({ status: opts.subscription ?? 'active', locale: 'en' });
  emails.push(subscription.email);
  const campaignId = opts.campaignId ?? (await oldCampaign());

  const recipientId = await inOwnerTx(
    async (db) => {
      await db.as({ role: 'ADMIN' });
      return recipientIn(db, campaignId, subscription.id, opts.recipient ?? 'sent');
    },
    { commit: true },
  );

  return { campaignId, recipientId, subscription };
}

const recipientOf = (id: number) =>
  asAdmin((tx) => tx.newsletterRecipient.findUnique({ where: { id } }));

const statusOf = async (mail: Mail) => (await recipientOf(mail.recipientId))!.status;
const subscriptionOf = async (mail: Mail) => (await rowsOf(mail.subscription.email))[0]!;

async function totalsOf(campaignId: number) {
  const row = (await campaignRowOf(campaignId))!;
  return { undelivered: row.undeliveredCount, complaints: row.complaintCount };
}

// the mail as it was left: not reported, its subscription in force
async function expectUntouched(mail: Mail) {
  expect(await statusOf(mail)).toBe('sent');
  expect((await subscriptionOf(mail)).status).toBe('active');
  expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 0, complaints: 0 });
}

const bounce = (mail: MailRef, over: Record<string, unknown> = {}) =>
  mailEvent('bounce', mail, over);

describe('POST /api/newsletters/sendgrid/webhook', () => {
  describe('the events', () => {
    it('ends the subscription and counts the mail when the address bounces', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [bounce(mail)]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(await statusOf(mail)).toBe('bounced');
      expect(await subscriptionOf(mail)).toMatchObject({
        status: 'stopped_bounce',
        endReason: 'bounced',
      });
      expect(await journalOf(mail.subscription.email)).toEqual([
        expect.objectContaining({
          event: 'bounced',
          place: 'webhook',
          campaignId: mail.campaignId,
          ip: null,
          userAgent: null,
        }),
      ]);
      expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
    });

    it('takes a bounce of a mail the pass has not written down as sent yet', async () => {
      const mail = await mailTo({ recipient: 'queued' });

      const res = await deliverEvents(app, [bounce(mail)]);

      expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(await statusOf(mail)).toBe('bounced');
      expect((await subscriptionOf(mail)).status).toBe('stopped_bounce');
    });

    it('ends a subscription a complaint paused, when its address bounces too', async () => {
      const mail = await mailTo({ subscription: 'paused_complaint' });

      await deliverEvents(app, [bounce(mail)]);

      expect((await subscriptionOf(mail)).status).toBe('stopped_bounce');
    });

    // a block is the receiving server refusing the mail for a reason that is not the address
    // (the sender, the content), so the address may be fine: the mail is lost, the subscription stays
    it('only counts the mail, and keeps the subscription, when SendGrid calls the bounce a block', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [bounce(mail, { type: 'blocked' })]);

      expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(await statusOf(mail)).toBe('dropped');
      expect((await subscriptionOf(mail)).status).toBe('active');
      expect(await journalOf(mail.subscription.email)).toEqual([]);
      expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
    });

    it('counts the mail as not delivered, and keeps the subscription, for a drop', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [mailEvent('dropped', mail)]);

      expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(await statusOf(mail)).toBe('dropped');
      expect((await subscriptionOf(mail)).status).toBe('active');
      expect(await journalOf(mail.subscription.email)).toEqual([]);
      expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
    });

    // SendGrid says why it dropped a mail (the field "reason" of the event): a drop because the address
    // bounced before is a bounce of the address, a drop because the address reported spam before is a
    // complaint, and any other reason (or none) only loses the mail
    describe('a drop and its reason', () => {
      it.each(['Bounced Address', 'bounced address', '  BOUNCED ADDRESS  '])(
        'ends the subscription as a bounce, and counts the mail as not delivered, for the reason %j',
        async (reason) => {
          const mail = await mailTo();

          const res = await deliverEvents(app, [mailEvent('dropped', mail, { reason })]);

          expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
          expect(await statusOf(mail)).toBe('dropped');
          expect(await subscriptionOf(mail)).toMatchObject({
            status: 'stopped_bounce',
            endReason: 'bounced',
          });
          expect(await journalOf(mail.subscription.email)).toEqual([
            expect.objectContaining({
              event: 'bounced',
              place: 'webhook',
              campaignId: mail.campaignId,
            }),
          ]);
          expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
        },
      );

      it.each(['Spam Reporting Address', 'spam reporting address', ' SPAM REPORTING ADDRESS '])(
        'pauses the subscription as a complaint, but counts the mail as not delivered, for the reason %j',
        async (reason) => {
          const mail = await mailTo();

          const res = await deliverEvents(app, [mailEvent('dropped', mail, { reason })]);

          expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
          expect(await statusOf(mail)).toBe('dropped');
          expect(await subscriptionOf(mail)).toMatchObject({ status: 'paused_complaint' });
          expect(await journalOf(mail.subscription.email)).toEqual([
            expect.objectContaining({
              event: 'complaint',
              place: 'webhook',
              campaignId: mail.campaignId,
            }),
          ]);
          // the mail did not arrive: it is no complaint of the campaign
          expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
        },
      );

      it.each([
        'Invalid',
        'Unsubscribed Address',
        'Spam Content',
        'Bounced Address and more',
        'x'.repeat(5000),
        '',
      ])('only counts the mail, and keeps the subscription, for the reason %j', async (reason) => {
        const mail = await mailTo();

        const res = await deliverEvents(app, [mailEvent('dropped', mail, { reason })]);

        expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
        expect(await statusOf(mail)).toBe('dropped');
        expect((await subscriptionOf(mail)).status).toBe('active');
        expect(await journalOf(mail.subscription.email)).toEqual([]);
        expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
      });

      it.each([
        ['no reason field', { reason: undefined }],
        ['a reason that is no text', { reason: 5 }],
        ['a reason that is null', { reason: null }],
        ['a reason that is a list', { reason: ['Bounced Address'] }],
      ])('only counts the mail for %s', async (_what, over) => {
        const mail = await mailTo();

        const res = await deliverEvents(app, [mailEvent('dropped', mail, over)]);

        expect(res.statusCode).toBe(200);
        expect(await statusOf(mail)).toBe('dropped');
        expect((await subscriptionOf(mail)).status).toBe('active');
        expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
      });

      it('reads the reason of a drop only: a block that says the same does not end the subscription', async () => {
        const mail = await mailTo();

        await deliverEvents(app, [bounce(mail, { type: 'blocked', reason: 'Bounced Address' })]);

        expect(await statusOf(mail)).toBe('dropped');
        expect((await subscriptionOf(mail)).status).toBe('active');
      });

      it('leaves a subscription that is paused as it is for the reason of a complaint, and ends it for a bounce', async () => {
        const complaint = await mailTo({ subscription: 'paused_complaint' });
        const bounced = await mailTo({ subscription: 'paused_complaint' });

        await deliverEvents(app, [
          mailEvent('dropped', complaint, { reason: 'Spam Reporting Address' }),
          mailEvent('dropped', bounced, { reason: 'Bounced Address' }),
        ]);

        expect((await subscriptionOf(complaint)).status).toBe('paused_complaint');
        expect(await journalOf(complaint.subscription.email)).toEqual([]);
        expect((await subscriptionOf(bounced)).status).toBe('stopped_bounce');
      });

      it('applies the reason once when the same drop comes again', async () => {
        const mail = await mailTo();
        const event = mailEvent('dropped', mail, { reason: 'Bounced Address' });

        await deliverEvents(app, [event]);
        const again = await deliverEvents(app, [event, event]);

        expect(again.statusCode).toBe(200);
        expect(await journalOf(mail.subscription.email)).toHaveLength(1);
        expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
      });

      it('does not end the subscription of another reader: the mail named by the arguments decides', async () => {
        const mail = await mailTo();
        const stranger = await mailTo();

        await deliverEvents(app, [
          mailEvent('dropped', mail, {
            reason: 'Bounced Address',
            email: stranger.subscription.email,
          }),
        ]);

        expect((await subscriptionOf(mail)).status).toBe('stopped_bounce');
        expect((await subscriptionOf(stranger)).status).toBe('active');
      });
    });

    it('pauses the subscription and counts a complaint for a spam report', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [mailEvent('spamreport', mail)]);

      expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(await statusOf(mail)).toBe('complained');
      expect(await subscriptionOf(mail)).toMatchObject({ status: 'paused_complaint' });
      expect(await journalOf(mail.subscription.email)).toEqual([
        expect.objectContaining({
          event: 'complaint',
          place: 'webhook',
          campaignId: mail.campaignId,
        }),
      ]);
      expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 0, complaints: 1 });
    });

    it('reads the arguments of the mail, not the address of the event', async () => {
      const mail = await mailTo();
      const stranger = await mailTo();

      // the address of the event is another reader's: the arguments of the mail decide
      await deliverEvents(app, [bounce(mail, { email: stranger.subscription.email })]);

      expect(await statusOf(mail)).toBe('bounced');
      expect(await statusOf(stranger)).toBe('sent');
      expect((await subscriptionOf(stranger)).status).toBe('active');
    });

    // SendGrid delivers each event at least once, and delivers a batch again when it got no 2xx
    it('counts a mail once when the same event comes again, in a later request or in the same one', async () => {
      const mail = await mailTo();
      const event = bounce(mail);

      const first = await deliverEvents(app, [event]);
      const again = await deliverEvents(app, [event]);
      const twice = await deliverEvents(app, [event, event]);

      expect(first.json()).toEqual({ received: true, applied: 1, skipped: 0 });
      expect(again.statusCode).toBe(200);
      expect(twice.statusCode).toBe(200);
      expect(await totalsOf(mail.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
      expect(await journalOf(mail.subscription.email)).toHaveLength(1);
      expect(await statusOf(mail)).toBe('bounced');
    });

    it.each([
      'processed',
      'delivered',
      'deferred',
      'open',
      'click',
      'unsubscribe',
      'group_unsubscribe',
      'group_resubscribe',
    ])('answers 200 and changes nothing for %s', async (kind) => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [mailEvent(kind, mail)]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 1 });
      await expectUntouched(mail);
    });

    it('answers 200 and changes nothing for a kind of event it does not know', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [mailEvent('something_new', mail), mailEvent('', mail)]);

      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 2 });
      await expectUntouched(mail);
    });
  });

  // the Event Webhooks of dev and prod hear every event of the account that sends the newsletters
  describe('the events that are not of a mail of this environment', () => {
    it('leaves alone an event of a mail with no marks, as the mails of the orders have', async () => {
      const mail = await mailTo();
      const orderMail = { email: 'buyer@example.com', event: 'bounce', category: ['order'] };

      const res = await deliverEvents(app, [orderMail, { ...orderMail, event: 'spamreport' }]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 2 });
      await expectUntouched(mail);
    });

    it.each([
      ['the campaign', { campaignId: undefined }],
      ['the recipient', { recipientId: undefined }],
      ['the environment', { environment: undefined }],
    ])('leaves alone an event of a mail with no mark of %s', async (_name, over) => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [bounce(mail, over)]);

      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 1 });
      await expectUntouched(mail);
    });

    // the ids of one environment are the ids of another (every database counts from 1), so an
    // event of a mail of the other environment would otherwise end a stranger's subscription
    it.each([['prod'], ['dev'], ['PRODUCTION'], ['']])(
      'leaves alone an event of a mail the environment %j sent, with ids this database has',
      async (environment) => {
        const mail = await mailTo();

        const res = await deliverEvents(app, [
          bounce(mail, { environment }),
          mailEvent('spamreport', mail, { environment }),
        ]);

        expect(res.json()).toEqual({ received: true, applied: 0, skipped: 2 });
        await expectUntouched(mail);
      },
    );

    it.each([
      ['a recipient this database has not', { recipientId: '2000000000' }],
      ['an id over the biggest the database holds', { recipientId: '2147483648' }],
      ['an id that is not a number', { recipientId: 'abc' }],
      ['an id that is no whole number', { recipientId: '1.5' }],
      ['an id that is not text', { recipientId: 7 }],
    ])('leaves alone an event with %s', async (_name, over) => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [bounce(mail, over)]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 1 });
      await expectUntouched(mail);
    });

    it('leaves alone an event of a mail that was never sent or was left out', async () => {
      const refused = await mailTo({ recipient: 'rejected' });
      const left = await mailTo({ recipient: 'skipped' });

      const res = await deliverEvents(app, [bounce(refused), mailEvent('dropped', left)]);

      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 2 });
      expect(await statusOf(refused)).toBe('rejected');
      expect(await statusOf(left)).toBe('skipped');
      expect((await subscriptionOf(refused)).status).toBe('active');
      expect(await totalsOf(refused.campaignId)).toEqual({ undelivered: 0, complaints: 0 });
    });

    it('skips the items that are no events at all', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [null, 5, 'bounce', true, [], [bounce(mail)]]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 6 });
      await expectUntouched(mail);
    });
  });

  describe('a batch of events', () => {
    it('takes the events of the mails of this environment and leaves the rest alone', async () => {
      const campaignId = await oldCampaign();
      const bounced = await mailTo({ campaignId });
      const dropped = await mailTo({ campaignId });
      const complained = await mailTo({ campaignId });
      const delivered = await mailTo({ campaignId });
      const foreign = await mailTo({ campaignId });
      const unmarked = await mailTo({ campaignId });

      const res = await deliverEvents(app, [
        mailEvent('delivered', delivered),
        bounce(bounced),
        bounce(foreign, { environment: 'prod' }),
        mailEvent('dropped', dropped),
        { email: 'buyer@example.com', event: 'bounce' },
        mailEvent('spamreport', complained),
        bounce({ campaignId, recipientId: 2_000_000_000 }),
        bounce(unmarked, { environment: undefined }),
        'junk',
        mailEvent('open', delivered),
      ]);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 3, skipped: 7 });
      expect(await statusOf(bounced)).toBe('bounced');
      expect(await statusOf(dropped)).toBe('dropped');
      expect(await statusOf(complained)).toBe('complained');
      for (const mail of [delivered, foreign, unmarked]) expect(await statusOf(mail)).toBe('sent');
      expect((await subscriptionOf(bounced)).status).toBe('stopped_bounce');
      expect((await subscriptionOf(dropped)).status).toBe('active');
      expect((await subscriptionOf(complained)).status).toBe('paused_complaint');
      expect(await totalsOf(campaignId)).toEqual({ undelivered: 2, complaints: 1 });
    });

    it('answers 200 for an empty list', async () => {
      const res = await deliverEvents(app, []);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, applied: 0, skipped: 0 });
    });

    it('counts the mails of two campaigns each in its own', async () => {
      const first = await mailTo();
      const second = await mailTo();

      await deliverEvents(app, [bounce(first), mailEvent('spamreport', second)]);

      expect(await totalsOf(first.campaignId)).toEqual({ undelivered: 1, complaints: 0 });
      expect(await totalsOf(second.campaignId)).toEqual({ undelivered: 0, complaints: 1 });
    });

    // one event the database cannot store must not hold back the others, and SendGrid must deliver
    // the batch again: it is not told 200. Applying an event is idempotent, so the events of the
    // batch that were stored are harmless the second time
    it('stores the other events, answers with an error, and takes the batch again without counting twice', async () => {
      const campaignId = await oldCampaign();
      const first = await mailTo({ campaignId });
      const second = await mailTo({ campaignId });
      const third = await mailTo({ campaignId });
      const batch = [bounce(first), mailEvent('dropped', second), mailEvent('spamreport', third)];

      // the first event meets a failure of the database (a lost connection), the others do not
      const transaction = jest.spyOn(prisma, '$transaction').mockImplementationOnce(async () => {
        throw new Error('the connection to the database was lost');
      });
      let failed;
      try {
        failed = await deliverEvents(app, batch);
      } finally {
        transaction.mockRestore();
      }

      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
      expect(takeLogs({ msg: 'request failed' })).toHaveLength(1);
      expect(
        takeLogs({
          msg: 'newsletter events were not stored, the request fails for SendGrid to deliver them again',
        }),
      ).toEqual([expect.objectContaining({ failed: 1, total: 3 })]);
      expect(await statusOf(first)).toBe('sent');
      expect(await statusOf(second)).toBe('dropped');
      expect(await statusOf(third)).toBe('complained');

      const again = await deliverEvents(app, batch);

      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ received: true, applied: 3, skipped: 0 });
      expect(await statusOf(first)).toBe('bounced');
      expect(await totalsOf(campaignId)).toEqual({ undelivered: 2, complaints: 1 });
      expect(await journalOf(first.subscription.email)).toHaveLength(1);
      expect(await journalOf(third.subscription.email)).toHaveLength(1);
    });
  });

  describe('the signature', () => {
    // a request that is refused must change nothing, whatever the events say
    const batchOf = (mail: Mail) => [bounce(mail), mailEvent('spamreport', mail)];

    it('refuses a request signed with another key', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, batchOf(mail), { signWith: signerOfAnotherKey() });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
      await expectUntouched(mail);
    });

    it('refuses a body changed after it was signed', async () => {
      const mail = await mailTo();
      const other = await mailTo();
      const signed = JSON.stringify([mailEvent('delivered', mail)]);
      const changed = JSON.stringify([bounce(other)]);

      const res = await deliverEvents(app, null, { body: changed, signedBody: signed });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
      await expectUntouched(other);
    });

    it('refuses a timestamp that is not the one that was signed', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, batchOf(mail), {
        timestamp: nowSeconds(),
        signedTimestamp: nowSeconds() - 60,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
      await expectUntouched(mail);
    });

    it.each([
      ['not base64', 'not*a*base64!'],
      ['base64 of nothing like a signature', Buffer.from('hello there').toString('base64')],
      ['too long', 'A'.repeat(4000)],
      ['the secret of another service', 'whsec_1234567890'],
    ])('refuses a signature that is %s', async (_name, signature) => {
      const mail = await mailTo();

      const res = await deliverEvents(app, batchOf(mail), { signature });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
      await expectUntouched(mail);
    });

    it('refuses a request that has the signature of the body alone, with no timestamp in it', async () => {
      const mail = await mailTo();
      const body = JSON.stringify(batchOf(mail));

      const res = await deliverEvents(app, null, { body, signedTimestamp: '' });

      expect(res.statusCode).toBe(401);
      await expectUntouched(mail);
    });

    it('refuses a timestamp that is no number of seconds, even when it was signed', async () => {
      const mail = await mailTo();

      for (const timestamp of ['abc', '12.5', '-5', '1e9', '0x10', ' 5']) {
        const res = await deliverEvents(app, batchOf(mail), { timestamp });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
      }
      await expectUntouched(mail);
    });

    // SendGrid delivers a batch again for a day; a request that is older, or comes from the future,
    // is not one of its own
    describe('the age of the request', () => {
      const HOUR = 3600;

      it('takes a request that is a few hours old, as a delivery of the day before is', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, [bounce(mail)], { timestamp: nowSeconds(-23 * HOUR) });

        expect(res.statusCode).toBe(200);
        expect(await statusOf(mail)).toBe('bounced');
      });

      it('refuses a request that is more than a day and an hour old', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, batchOf(mail), { timestamp: nowSeconds(-26 * HOUR) });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
        await expectUntouched(mail);
      });

      it('takes a request a few minutes ahead of the clock of the server', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, [bounce(mail)], { timestamp: nowSeconds(4 * 60) });

        expect(res.statusCode).toBe(200);
        expect(await statusOf(mail)).toBe('bounced');
      });

      it('refuses a request dated an hour ahead', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, batchOf(mail), { timestamp: nowSeconds(HOUR) });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
        await expectUntouched(mail);
      });
    });

    describe('the headers', () => {
      it('answers 400 for a request with no signature header', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, batchOf(mail), { signature: null });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
        await expectUntouched(mail);
      });

      it('answers 400 for a request with no timestamp header', async () => {
        const mail = await mailTo();

        const res = await deliverEvents(app, batchOf(mail), { omitTimestamp: true });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
        await expectUntouched(mail);
      });

      it.each([
        ['signature', SIGNATURE_HEADER],
        ['timestamp', TIMESTAMP_HEADER],
      ])(
        'answers SENDGRID_SIGNATURE_REQUIRED for a %s header of only spaces',
        async (_name, header) => {
          const mail = await mailTo();

          const res = await deliverEvents(app, batchOf(mail), { headers: { [header]: '   ' } });

          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_REQUIRED' });
          await expectUntouched(mail);
        },
      );

      it('does not take the signature of the Stripe webhook for its own', async () => {
        const mail = await mailTo();
        const { payload } = requestOf(batchOf(mail));

        const res = await app.inject({
          method: 'POST',
          url: WEBHOOK_URL,
          headers: {
            'content-type': 'application/json',
            'stripe-signature': 't=1700000000,v1=abc',
          },
          payload,
        });

        expect(res.statusCode).toBe(400);
        await expectUntouched(mail);
      });
    });

    // the body is parsed after the signature is checked: what an unsigned request holds is not read
    it('refuses a body that is not json with the signature first', async () => {
      const res = await deliverEvents(app, null, {
        body: '{"event": ',
        signature: 'AAAA',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_SIGNATURE_INVALID' });
    });
  });

  describe('the key of the server', () => {
    const key = env.SENDGRID_NEWSLETTER_WEBHOOK_KEY;

    afterEach(() => {
      env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = key;
    });

    // a server without its key could take nothing as signed, so it takes nothing; the error makes
    // SendGrid deliver the events again once the key is in place
    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['not a key', 'this is not a key'],
    ])(
      'answers 503 and takes nothing when the key is %s, whatever the request is signed with',
      async (_name, value) => {
        const mail = await mailTo();
        env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = value;

        const res = await deliverEvents(app, [bounce(mail)]);

        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_WEBHOOK_KEY_UNAVAILABLE' });
        expect(takeLogs({ errorCode: 'SENDGRID_WEBHOOK_KEY_UNAVAILABLE' })).toHaveLength(1);
        env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = key;
        await expectUntouched(mail);
      },
    );

    it('answers 503 for a request that is not signed at all, not 401', async () => {
      env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = '';

      const res = await deliverEvents(app, [], { signature: 'AAAA' });

      expect(res.statusCode).toBe(503);
      expect(takeLogs({ errorCode: 'SENDGRID_WEBHOOK_KEY_UNAVAILABLE' })).toHaveLength(1);
    });

    it('reads the key at every request, so a key put in place works at once', async () => {
      const mail = await mailTo();
      env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = '';
      expect((await deliverEvents(app, [bounce(mail)])).statusCode).toBe(503);
      takeLogs({ errorCode: 'SENDGRID_WEBHOOK_KEY_UNAVAILABLE' });

      env.SENDGRID_NEWSLETTER_WEBHOOK_KEY = key;

      expect((await deliverEvents(app, [bounce(mail)])).statusCode).toBe(200);
      expect(await statusOf(mail)).toBe('bounced');
    });
  });

  describe('the body', () => {
    it('refuses a signed body that is not json', async () => {
      const res = await deliverEvents(app, null, { body: '[{"event": "bounce"' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'REQUEST_BODY_INVALID_JSON' });
    });

    it('refuses a signed body that is empty', async () => {
      const res = await deliverEvents(app, null, { body: '' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'REQUEST_BODY_INVALID_JSON' });
    });

    it.each([
      ['an object', '{"event":"bounce"}'],
      ['an object that holds the list', '{"events":[]}'],
      ['a string', '"bounce"'],
      ['a number', '5'],
      ['null', 'null'],
      ['true', 'true'],
    ])('refuses a signed body that is %s, not a list of events', async (_name, body) => {
      const res = await deliverEvents(app, null, { body });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'SENDGRID_EVENTS_INVALID' });
    });

    it('takes the content type with a charset', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [bounce(mail)], {
        contentType: 'application/json; charset=utf-8',
      });

      expect(res.statusCode).toBe(200);
      expect(await statusOf(mail)).toBe('bounced');
    });

    it('refuses a content type that is not json', async () => {
      const res = await deliverEvents(app, [], { contentType: 'text/plain' });

      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ errorCode: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('reads a body of text that is not ASCII as the bytes it is', async () => {
      const mail = await mailTo();

      const res = await deliverEvents(app, [
        bounce(mail, { reason: '550 ünï — 日本語 😀', email: 'jürgen@exämple.de' }),
      ]);

      expect(res.statusCode).toBe(200);
      expect(await statusOf(mail)).toBe('bounced');
    });

    // SendGrid batches the events it delivers; a batch of a few megabytes is ordinary, and one that
    // is bigger than any batch is refused before anything is read
    describe('the size', () => {
      const LIMIT = 4 * 1024 * 1024;
      const paddedTo = (bytes: number) => {
        const head = JSON.stringify([{ event: 'delivered', pad: '' }]);
        return JSON.stringify([{ event: 'delivered', pad: 'x'.repeat(bytes - head.length) }]);
      };

      it('takes a batch up to four megabytes', async () => {
        const body = paddedTo(LIMIT);
        expect(Buffer.byteLength(body)).toBe(LIMIT);

        const res = await deliverEvents(app, null, { body });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ received: true, applied: 0, skipped: 1 });
      });

      it('refuses a batch over four megabytes with 413, signed or not', async () => {
        const body = paddedTo(LIMIT + 1);

        const signed = await deliverEvents(app, null, { body });
        const unsigned = await deliverEvents(app, null, { body, signature: 'AAAA' });

        for (const res of [signed, unsigned]) {
          expect(res.statusCode).toBe(413);
          expect(res.json()).toMatchObject({ errorCode: 'PAYLOAD_TOO_LARGE' });
        }
      });

      it('keeps the limit of one megabyte on the other routes of the module', async () => {
        const api = newsletterApi(app, await getCsrf(app));

        const res = await api.post('/api/newsletters/subscriptions/confirm', {
          token: 'x'.repeat(1024 * 1024 + 1),
        });

        expect(res.statusCode).toBe(413);
        expect(res.json()).toMatchObject({ errorCode: 'PAYLOAD_TOO_LARGE' });
      });
    });
  });

  describe('the route', () => {
    it('needs no csrf token and no cookie of a session', async () => {
      const mail = await mailTo();

      const res = await app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        ...requestOf([bounce(mail)]),
      });

      expect(res.statusCode).toBe(200);
      expect(await statusOf(mail)).toBe('bounced');
    });

    it('is outside the request rate limit, the other routes are inside it', async () => {
      const webhook = await deliverEvents(app, []);
      const counted = await app.inject({ method: 'GET', url: '/api/auth/csrf' });

      expect(counted.headers['x-ratelimit-limit']).toBeDefined();
      expect(webhook.headers['x-ratelimit-limit']).toBeUndefined();
      expect(webhook.headers['x-ratelimit-remaining']).toBeUndefined();
    });

    it('is not a route of the GET method', async () => {
      const res = await app.inject({ method: 'GET', url: WEBHOOK_URL });

      expect(res.statusCode).toBe(404);
    });

    it('lives only at the address the Event Webhook is set to', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/newsletters/webhook',
        ...requestOf([]),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('the logs', () => {
    // the events hold the address of the reader, and the request holds the signature: none of them
    // is written to a log, at any level
    it('hold no address, no signature and no key, and tell how many events were taken', async () => {
      const mail = await mailTo();
      const level = app.log.level;
      app.log.level = 'debug';

      try {
        const request = requestOf([
          bounce(mail, { email: 'private.reader@example.org' }),
          { email: 'order.buyer@example.org', event: 'bounce' },
          mailEvent('delivered', mail, { email: 'third.reader@example.org' }),
        ]);
        const res = await app.inject({ method: 'POST', url: WEBHOOK_URL, ...request });
        expect(res.statusCode).toBe(200);

        const lines = takeLogs({});
        const text = JSON.stringify(lines);

        expect(text).not.toContain('example.org');
        expect(text).not.toContain(request.headers[SIGNATURE_HEADER]);
        expect(text).not.toContain(env.SENDGRID_NEWSLETTER_WEBHOOK_KEY);
        expect(lines.filter((line) => line.msg === 'newsletter events were handled')).toEqual([
          expect.objectContaining({ received: 3, applied: 1, ignored: 1, skipped: 1, unknown: 0 }),
        ]);
      } finally {
        app.log.level = level;
      }
    });

    it('write nothing worse than debug for events that belong to other mails', async () => {
      const level = app.log.level;
      app.log.level = 'debug';

      try {
        await deliverEvents(app, [
          { email: 'order.buyer@example.org', event: 'bounce' },
          bounce({ campaignId: 1, recipientId: 2_000_000_000 }),
          bounce({ campaignId: 1, recipientId: 1 }, { environment: 'prod' }),
        ]);

        const lines = takeLogs({});
        const handled = lines.filter((line) => line.msg === 'newsletter events were handled');

        expect(lines.filter((line) => line.level >= 40)).toEqual([]);
        expect(handled).toEqual([
          expect.objectContaining({ level: 20, received: 3, applied: 0, skipped: 2, unknown: 1 }),
        ]);
      } finally {
        app.log.level = level;
      }
    });

    it('tell, as an info line, that events were applied', async () => {
      const mail = await mailTo();
      const level = app.log.level;
      app.log.level = 'info';

      try {
        await deliverEvents(app, [bounce(mail)]);

        const handled = takeLogs({ msg: 'newsletter events were handled' });
        expect(handled).toHaveLength(1);
        expect(handled[0]!.level).toBe(30);
        takeLogs({});
      } finally {
        app.log.level = level;
      }
    });

    it('tell why a signature was refused, without the signature', async () => {
      const level = app.log.level;
      app.log.level = 'info';

      try {
        await deliverEvents(app, [], { signature: 'AAAA' });

        const refused = takeLogs({ msg: 'newsletter webhook signature was refused' });
        expect(refused).toEqual([expect.objectContaining({ reason: 'signature_invalid' })]);
        expect(JSON.stringify(refused)).not.toContain('AAAA');
        takeLogs({});
      } finally {
        app.log.level = level;
      }
    });
  });
});
