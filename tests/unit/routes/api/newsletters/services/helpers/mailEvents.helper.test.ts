import { describe, expect, it } from '@jest/globals';

import { readSendGridEvents } from '@providers/mail/sendgrid/sendGridEvents.js';
import {
  mailTagsOf,
  readMailEvents,
} from '@routes/api/newsletters/services/helpers/mailEvents.helper.js';

import { importWithEnv } from '../../../../../../helpers/freshImport.js';

// The two ends of what comes back with the events of the mail provider, here SendGrid. A mail of the
// newsletters carries tags (the campaign, the recipient, the environment); SendGrid puts them on the
// same level as its own fields in each event it reports. Both webhooks of the account hear every
// event of the account, the mails of the orders and the mails of the other environments too, so an
// event counts only when it is of the three kinds the app keeps and carries the three tags of this
// environment

// a batch of SendGrid as the app reads it: SendGrid's words made ours, then the tags of this
// environment
const read = (items: unknown[], environment?: string) =>
  readMailEvents(readSendGridEvents(items)!, environment);

const ENV = 'test';
const marked = (over: Record<string, unknown> = {}) => ({
  campaignId: '5',
  recipientId: '9',
  environment: ENV,
  ...over,
});
const event = (kind: unknown, over: Record<string, unknown> = {}) => ({
  email: 'reader@example.com',
  timestamp: 1_788_000_000,
  event: kind,
  ...marked(),
  ...over,
});

describe('mailTagsOf', () => {
  it('names the campaign, the recipient and the environment, as text', () => {
    expect(mailTagsOf(5, 9)).toEqual({ campaignId: '5', recipientId: '9', environment: 'test' });
  });

  it('carries nothing that names a person', () => {
    const text = JSON.stringify(mailTagsOf(5, 9));

    expect(text).not.toMatch(/@/);
    expect(Object.keys(mailTagsOf(5, 9)).sort()).toEqual([
      'campaignId',
      'environment',
      'recipientId',
    ]);
  });

  it.each([
    ['production', 'prod'],
    ['development', 'dev'],
    ['test', 'test'],
  ])(
    'puts the environment of %s as %s (ENVIRONMENT_NAME, as the folders of the files)',
    async (nodeEnv, mark) => {
      const fresh = await importWithEnv<
        typeof import('@routes/api/newsletters/services/helpers/mailEvents.helper.js')
      >('@routes/api/newsletters/services/helpers/mailEvents.helper.js', { NODE_ENV: nodeEnv });

      expect(fresh.mailTagsOf(1, 2).environment).toBe(mark);
    },
  );

  it('is what the reader of the events takes back', () => {
    const args = mailTagsOf(12, 345);

    expect(read([{ event: 'bounce', ...args }], ENV).toApply).toEqual([
      { recipientId: 345, event: 'bounced', dropReason: null },
    ]);
  });
});

describe('the events of a batch', () => {
  describe('the kinds of events', () => {
    it('tells a bounce, a drop and a spam report in our words, each with the recipient', () => {
      const got = read(
        [
          event('bounce', { recipientId: '1' }),
          event('dropped', { recipientId: '2' }),
          event('spamreport', { recipientId: '3' }),
        ],
        ENV,
      );

      expect(got).toEqual({
        toApply: [
          { recipientId: 1, event: 'bounced', dropReason: null },
          { recipientId: 2, event: 'dropped', dropReason: null },
          { recipientId: 3, event: 'complained', dropReason: null },
        ],
        ignored: 0,
        skipped: 0,
      });
    });

    it('keeps the order SendGrid sent the events in', () => {
      const got = read(
        [event('dropped', { recipientId: '7' }), event('bounce', { recipientId: '7' })],
        ENV,
      );

      expect(got.toApply.map((item) => item.event)).toEqual(['dropped', 'bounced']);
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
      'something_new',
    ])('leaves out %s', (kind) => {
      expect(read([event(kind)], ENV)).toEqual({ toApply: [], ignored: 1, skipped: 0 });
    });

    // the names are the ones SendGrid writes; a different spelling is another thing
    it.each(['BOUNCE', 'Bounce', ' bounce', 'bounce ', 'bounced', 'spam_report', 'drop'])(
      'does not take %j for a kind of the three',
      (kind) => {
        expect(read([event(kind)], ENV).toApply).toEqual([]);
      },
    );

    it.each([[undefined], [null], [5], [true], [['bounce']], [{ name: 'bounce' }]])(
      'leaves out an event whose kind is %j',
      (kind) => {
        const got = read([event(kind)], ENV);

        expect(got.toApply).toEqual([]);
        expect(got.ignored + got.skipped).toBe(1);
      },
    );
  });

  describe('a bounce', () => {
    it('is a bounce of the address when SendGrid calls it a bounce', () => {
      expect(read([event('bounce', { type: 'bounce' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'bounced', dropReason: null },
      ]);
    });

    it('is a bounce when the event does not say its type', () => {
      expect(read([event('bounce')], ENV).toApply).toEqual([
        { recipientId: 9, event: 'bounced', dropReason: null },
      ]);
    });

    // a block says the receiving server refused the mail for a reason that is not the address (the
    // sender, the content): the address may be fine, so the subscription must not end; the mail did
    // not arrive, which is what the drop reports
    it('is a drop of the mail, not an end of the subscription, when SendGrid calls it a block', () => {
      expect(read([event('bounce', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'dropped', dropReason: null },
      ]);
    });

    it.each([['BLOCKED'], ['Blocked'], [''], [null], [5]])(
      'is a bounce of the address for a type %j that is not "blocked"',
      (type) => {
        expect(read([event('bounce', { type })], ENV).toApply).toEqual([
          { recipientId: 9, event: 'bounced', dropReason: null },
        ]);
      },
    );

    it('does not make a block of any other event', () => {
      expect(read([event('dropped', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'dropped', dropReason: null },
      ]);
      expect(read([event('spamreport', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'complained', dropReason: null },
      ]);
    });
  });

  // SendGrid says why it dropped a mail in the field "reason" ("Bounced Address", "Spam Reporting
  // Address", "Invalid", "Unsubscribed Address", ...); two of the reasons are the address known from
  // before, the rest is none of the shop's. Only the drop carries it: the reason of a bounce is the
  // text of the receiving server
  describe('the reason of a drop', () => {
    it.each([
      ['Bounced Address', 'address_bounced'],
      ['Spam Reporting Address', 'address_complained'],
      ['  spam reporting address \n', 'address_complained'],
      ['BOUNCED ADDRESS', 'address_bounced'],
    ])('tells %j as %s, with the drop', (reason, dropReason) => {
      expect(read([event('dropped', { reason })], ENV).toApply).toStrictEqual([
        { recipientId: 9, event: 'dropped', dropReason },
      ]);
    });

    it.each([
      ['Invalid'],
      ['Unsubscribed Address'],
      ['Bounced Addresses'],
      [undefined],
      [null],
      [5],
      [true],
      [['Bounced Address']],
      [{ text: 'x' }],
      ['  '],
      [''],
    ])('gives no reason for %j, the drop is kept', (reason) => {
      expect(read([event('dropped', { reason })], ENV).toApply).toStrictEqual([
        { recipientId: 9, event: 'dropped', dropReason: null },
      ]);
    });

    it('gives no reason to the drop that has no reason field', () => {
      expect(read([event('dropped')], ENV).toApply).toStrictEqual([
        { recipientId: 9, event: 'dropped', dropReason: null },
      ]);
    });

    it('is not read from a bounce, a block or a spam report, whatever they say', () => {
      const reason = 'Bounced Address';

      expect(
        read(
          [
            event('bounce', { reason, recipientId: '1' }),
            event('bounce', { reason, type: 'blocked', recipientId: '2' }),
            event('spamreport', { reason, recipientId: '3' }),
          ],
          ENV,
        ).toApply,
      ).toStrictEqual([
        { recipientId: 1, event: 'bounced', dropReason: null },
        { recipientId: 2, event: 'dropped', dropReason: null },
        { recipientId: 3, event: 'complained', dropReason: null },
      ]);
    });
  });

  describe('the marks of the mail', () => {
    it.each([
      ['no campaign', { campaignId: undefined }],
      ['no recipient', { recipientId: undefined }],
      ['no environment', { environment: undefined }],
      ['a campaign that is not text', { campaignId: 5 }],
      ['a recipient that is not text', { recipientId: 9 }],
      ['a recipient that is null', { recipientId: null }],
      ['an empty recipient', { recipientId: '' }],
      ['a zero recipient', { recipientId: '0' }],
      ['a negative recipient', { recipientId: '-4' }],
      ['a recipient with a fraction', { recipientId: '1.5' }],
      ['a recipient in the exponent form', { recipientId: '1e3' }],
      ['a recipient with spaces', { recipientId: ' 9' }],
      ['a recipient with a sign', { recipientId: '+9' }],
      ['a recipient with letters', { recipientId: '9a' }],
      ['a recipient with a leading zero', { recipientId: '09' }],
      ['a recipient over the biggest id', { recipientId: '2147483648' }],
      ['a recipient of many digits', { recipientId: '9'.repeat(40) }],
      ['a campaign of zero', { campaignId: '0' }],
      ['a campaign with letters', { campaignId: 'five' }],
      ['a campaign over the biggest id', { campaignId: '2147483648' }],
      ['the environment of the other side', { environment: 'prod' }],
      ['the environment in capitals', { environment: 'TEST' }],
      ['an environment that is not text', { environment: ['test'] }],
      ['an empty environment', { environment: '' }],
    ])('skips an event with %s', (_name, over) => {
      expect(read([event('bounce', over)], ENV)).toEqual({
        toApply: [],
        ignored: 0,
        skipped: 1,
      });
    });

    it('takes the biggest id a column holds', () => {
      expect(read([event('bounce', { recipientId: '2147483647' })], ENV).toApply).toEqual([
        { recipientId: 2147483647, event: 'bounced', dropReason: null },
      ]);
    });

    it('skips a mail of the orders, which carries none of the marks', () => {
      const orderMail = {
        email: 'buyer@example.com',
        event: 'bounce',
        sg_message_id: 'abc.filter0001',
        category: ['order'],
      };

      expect(read([orderMail], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 1 });
    });

    it('skips the mail of another environment, the same ids or not', () => {
      expect(read([event('spamreport', { environment: 'dev' })], 'prod').skipped).toBe(1);
      expect(read([event('spamreport', { environment: 'prod' })], 'prod').skipped).toBe(0);
    });

    it('does not read the marks of an event it does not keep', () => {
      // a delivered mail of another environment is no concern of this one: it is left out, not skipped
      expect(read([event('delivered', { environment: 'prod' })], ENV)).toEqual({
        toApply: [],
        ignored: 1,
        skipped: 0,
      });
    });
  });

  describe('a body that is not a list of events', () => {
    it.each([[null], [5], ['text'], [true], [[]], [['bounce']], [[[]]], [undefined]])(
      'skips the item %j',
      (item) => {
        expect(read([item], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 1 });
      },
    );

    it.each([[null], [{}], ['text'], [5]])('is no batch when the body is %j', (body) => {
      expect(readSendGridEvents(body)).toBeNull();
    });

    it('reads an empty list as nothing', () => {
      expect(read([], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 0 });
    });

    it('counts every item once, as kept, left out or skipped', () => {
      const items = [
        event('bounce'),
        event('delivered'),
        event('bounce', { environment: 'prod' }),
        null,
        event('dropped', { recipientId: '4' }),
        event('open'),
        { event: 'spamreport' },
      ];

      const got = read(items, ENV);

      expect(got.toApply).toHaveLength(2);
      expect(got.ignored).toBe(2);
      expect(got.skipped).toBe(3);
      expect(got.toApply.length + got.ignored + got.skipped).toBe(items.length);
    });
  });

  it('uses the environment of the app when none is given', () => {
    expect(read([event('bounce')]).toApply).toHaveLength(1);
    expect(read([event('bounce', { environment: 'prod' })]).toApply).toHaveLength(0);
  });
});
