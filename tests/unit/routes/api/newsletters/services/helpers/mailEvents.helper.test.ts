import { describe, expect, it } from '@jest/globals';

import {
  customArgsOf,
  readMailEvents,
} from '@routes/api/newsletters/services/helpers/mailEvents.helper.js';

import { importWithEnv } from '../../../../../../helpers/freshImport.js';

// The two ends of what comes back with the events of SendGrid. A mail of the newsletters carries
// custom arguments (the campaign, the recipient, the environment); SendGrid puts them on the same level
// as its own fields in each event it reports. Both Event Webhooks of the account hear every event of
// the account, the mails of the orders and the mails of the other environments too, so an event counts
// only when it is of the three kinds the app keeps and carries the three arguments of this environment

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

describe('customArgsOf', () => {
  it('names the campaign, the recipient and the environment, as text', () => {
    expect(customArgsOf(5, 9)).toEqual({ campaignId: '5', recipientId: '9', environment: 'test' });
  });

  it('carries nothing that names a person', () => {
    const text = JSON.stringify(customArgsOf(5, 9));

    expect(text).not.toMatch(/@/);
    expect(Object.keys(customArgsOf(5, 9)).sort()).toEqual([
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
    'puts the environment of %s as %s (the folder of the files of Cloudinary)',
    async (nodeEnv, mark) => {
      const fresh = await importWithEnv<
        typeof import('@routes/api/newsletters/services/helpers/mailEvents.helper.js')
      >('@routes/api/newsletters/services/helpers/mailEvents.helper.js', { NODE_ENV: nodeEnv });

      expect(fresh.customArgsOf(1, 2).environment).toBe(mark);
    },
  );

  it('is what the reader of the events takes back', () => {
    const args = customArgsOf(12, 345);

    expect(readMailEvents([{ event: 'bounce', ...args }], ENV).toApply).toEqual([
      { recipientId: 345, event: 'bounce' },
    ]);
  });
});

describe('readMailEvents', () => {
  describe('the kinds of events', () => {
    it('keeps a bounce, a drop and a spam report, each with the recipient', () => {
      const read = readMailEvents(
        [
          event('bounce', { recipientId: '1' }),
          event('dropped', { recipientId: '2' }),
          event('spamreport', { recipientId: '3' }),
        ],
        ENV,
      );

      expect(read).toEqual({
        toApply: [
          { recipientId: 1, event: 'bounce' },
          { recipientId: 2, event: 'dropped' },
          { recipientId: 3, event: 'spamreport' },
        ],
        ignored: 0,
        skipped: 0,
      });
    });

    it('keeps the order SendGrid sent the events in', () => {
      const read = readMailEvents(
        [event('dropped', { recipientId: '7' }), event('bounce', { recipientId: '7' })],
        ENV,
      );

      expect(read.toApply.map((item) => item.event)).toEqual(['dropped', 'bounce']);
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
      expect(readMailEvents([event(kind)], ENV)).toEqual({ toApply: [], ignored: 1, skipped: 0 });
    });

    // the names are the ones SendGrid writes; a different spelling is another thing
    it.each(['BOUNCE', 'Bounce', ' bounce', 'bounce ', 'bounced', 'spam_report', 'drop'])(
      'does not take %j for a kind of the three',
      (kind) => {
        expect(readMailEvents([event(kind)], ENV).toApply).toEqual([]);
      },
    );

    it.each([[undefined], [null], [5], [true], [['bounce']], [{ name: 'bounce' }]])(
      'leaves out an event whose kind is %j',
      (kind) => {
        const read = readMailEvents([event(kind)], ENV);

        expect(read.toApply).toEqual([]);
        expect(read.ignored + read.skipped).toBe(1);
      },
    );
  });

  describe('a bounce', () => {
    it('is a bounce of the address when SendGrid calls it a bounce', () => {
      expect(readMailEvents([event('bounce', { type: 'bounce' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'bounce' },
      ]);
    });

    it('is a bounce when the event does not say its type', () => {
      expect(readMailEvents([event('bounce')], ENV).toApply).toEqual([
        { recipientId: 9, event: 'bounce' },
      ]);
    });

    // a block says the receiving server refused the mail for a reason that is not the address (the
    // sender, the content): the address may be fine, so the subscription must not end; the mail did
    // not arrive, which is what the drop reports
    it('is a drop of the mail, not an end of the subscription, when SendGrid calls it a block', () => {
      expect(readMailEvents([event('bounce', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'dropped' },
      ]);
    });

    it.each([['BLOCKED'], ['Blocked'], [''], [null], [5]])(
      'is a bounce of the address for a type %j that is not "blocked"',
      (type) => {
        expect(readMailEvents([event('bounce', { type })], ENV).toApply).toEqual([
          { recipientId: 9, event: 'bounce' },
        ]);
      },
    );

    it('does not make a block of any other event', () => {
      expect(readMailEvents([event('dropped', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'dropped' },
      ]);
      expect(readMailEvents([event('spamreport', { type: 'blocked' })], ENV).toApply).toEqual([
        { recipientId: 9, event: 'spamreport' },
      ]);
    });
  });

  // SendGrid says why it dropped a mail in the field "reason" ("Bounced Address", "Spam Reporting
  // Address", "Invalid", "Unsubscribed Address", ...); the database decides what a reason means. Only
  // the drop carries it: the reason of a bounce is the text of the receiving server
  describe('the reason of a drop', () => {
    it('is kept as text, with the drop', () => {
      expect(
        readMailEvents([event('dropped', { reason: 'Bounced Address' })], ENV).toApply,
      ).toStrictEqual([{ recipientId: 9, event: 'dropped', reason: 'Bounced Address' }]);
    });

    it('is cut of the spaces around it and to 200 characters', () => {
      const long = 'x'.repeat(5000);

      expect(
        readMailEvents([event('dropped', { reason: '  Spam Reporting Address \n' })], ENV).toApply,
      ).toStrictEqual([{ recipientId: 9, event: 'dropped', reason: 'Spam Reporting Address' }]);
      expect(
        readMailEvents([event('dropped', { reason: long })], ENV).toApply[0]!.reason,
      ).toHaveLength(200);
    });

    it.each([
      [undefined],
      [null],
      [5],
      [true],
      [['Bounced Address']],
      [{ text: 'x' }],
      ['  '],
      [''],
    ])('is left out when it is %j, the drop is kept', (reason) => {
      expect(readMailEvents([event('dropped', { reason })], ENV).toApply).toStrictEqual([
        { recipientId: 9, event: 'dropped' },
      ]);
    });

    it('is left out of the drop that has no reason field', () => {
      expect(readMailEvents([event('dropped')], ENV).toApply).toStrictEqual([
        { recipientId: 9, event: 'dropped' },
      ]);
    });

    it('is not read from a bounce, a block or a spam report, whatever they say', () => {
      const reason = 'Bounced Address';

      expect(
        readMailEvents(
          [
            event('bounce', { reason, recipientId: '1' }),
            event('bounce', { reason, type: 'blocked', recipientId: '2' }),
            event('spamreport', { reason, recipientId: '3' }),
          ],
          ENV,
        ).toApply,
      ).toStrictEqual([
        { recipientId: 1, event: 'bounce' },
        { recipientId: 2, event: 'dropped' },
        { recipientId: 3, event: 'spamreport' },
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
      expect(readMailEvents([event('bounce', over)], ENV)).toEqual({
        toApply: [],
        ignored: 0,
        skipped: 1,
      });
    });

    it('takes the biggest id a column holds', () => {
      expect(readMailEvents([event('bounce', { recipientId: '2147483647' })], ENV).toApply).toEqual(
        [{ recipientId: 2147483647, event: 'bounce' }],
      );
    });

    it('skips a mail of the orders, which carries none of the marks', () => {
      const orderMail = {
        email: 'buyer@example.com',
        event: 'bounce',
        sg_message_id: 'abc.filter0001',
        category: ['order'],
      };

      expect(readMailEvents([orderMail], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 1 });
    });

    it('skips the mail of another environment, the same ids or not', () => {
      expect(readMailEvents([event('spamreport', { environment: 'dev' })], 'prod').skipped).toBe(1);
      expect(readMailEvents([event('spamreport', { environment: 'prod' })], 'prod').skipped).toBe(
        0,
      );
    });

    it('does not read the marks of an event it does not keep', () => {
      // a delivered mail of another environment is no concern of this one: it is left out, not skipped
      expect(readMailEvents([event('delivered', { environment: 'prod' })], ENV)).toEqual({
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
        expect(readMailEvents([item], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 1 });
      },
    );

    it('reads an empty list as nothing', () => {
      expect(readMailEvents([], ENV)).toEqual({ toApply: [], ignored: 0, skipped: 0 });
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

      const read = readMailEvents(items, ENV);

      expect(read.toApply).toHaveLength(2);
      expect(read.ignored).toBe(2);
      expect(read.skipped).toBe(3);
      expect(read.toApply.length + read.ignored + read.skipped).toBe(items.length);
    });
  });

  it('uses the environment of the app when none is given', () => {
    expect(readMailEvents([event('bounce')]).toApply).toHaveLength(1);
    expect(readMailEvents([event('bounce', { environment: 'prod' })]).toApply).toHaveLength(0);
  });
});
