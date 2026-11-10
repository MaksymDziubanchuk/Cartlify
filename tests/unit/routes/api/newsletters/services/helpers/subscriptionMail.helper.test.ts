import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { InternalError } from '@utils/errors.js';

// The mails of the form of the public page. What the database, the provider of the mail and the list
// of spam reports are asked is recorded; the integration tests (api/newsletters/subscribe) hold the
// same rules against a real database. Here the failures that cannot be made in a real one: a step that
// fails in the middle of another failure.

type Query = { sql: string; values: unknown[] };

const queries: Query[] = [];
const order: string[] = [];
let manageRow: Record<string, unknown> | 'fail' | 'missing' = 'missing';
let liftFails = false;

const txMock = jest.fn(async (fn: (db: unknown) => Promise<unknown>) =>
  fn({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      queries.push({ sql, values });

      if (sql.includes('newsletter_manage_get')) {
        if (manageRow === 'fail') throw new Error('database down for the address a@b.c');
        return manageRow === 'missing' ? [] : [manageRow];
      }
      if (liftFails) throw new Error('the lift failed for the address a@b.c');
      return [{ lifted: true }];
    },
  }),
);
const sendMock = jest.fn<(input: { to: string; subject: string }) => Promise<unknown>>();
const clearMock = jest.fn<(email: string, log: unknown) => Promise<boolean>>();

jest.unstable_mockModule('@db/client.js', () => ({
  tx: txMock,
  getPgMessage: (err: unknown) => (err instanceof Error ? 'DB_FAILED' : null),
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({
  setGuestNullContext: async () => undefined,
}));
jest.unstable_mockModule('@services/email/sendNewsletterEmail.js', () => ({
  sendNewsletterEmail: sendMock,
}));
jest.unstable_mockModule('@services/email/clearSpamReport.js', () => ({
  clearSpamReport: clearMock,
}));

const { sendSubscriptionAlreadyMail, sendSubscriptionConfirmMail } =
  await import('@routes/api/newsletters/services/helpers/subscriptionMail.helper.js');

const EMAIL = 'reader@example.com';

const logger = () => ({ warn: jest.fn(), error: jest.fn() });

const refused = () =>
  new InternalError(
    { reason: 'SENDGRID_SEND_FAILED' },
    { status: 400, body: 'for reader@example.com' },
  );

const liftsOf = () =>
  queries.filter((query) => query.sql.includes('newsletter_request_mail_failed'));

beforeEach(() => {
  queries.length = 0;
  order.length = 0;
  manageRow = 'missing';
  liftFails = false;
  txMock.mockClear();
  sendMock.mockReset();
  sendMock.mockImplementation(async () => {
    order.push('send');
    return { status: 202 };
  });
  clearMock.mockReset();
  clearMock.mockImplementation(async () => {
    order.push('clear');
    return true;
  });
});

describe('the mark of the day of a mail of the form', () => {
  it('stays when the provider takes the mail: the database is not asked to take it back', async () => {
    await sendSubscriptionConfirmMail({ to: EMAIL, token: 'tok', locale: 'en' }, logger());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(liftsOf()).toEqual([]);
  });

  it.each([
    ['a confirmation', 'confirm'],
    ['"you are already subscribed"', 'already'],
  ] as const)(
    'is taken back for %s that the provider refused, naming the address and the kind',
    async (_what, kind) => {
      sendMock.mockRejectedValue(refused());
      const log = logger();

      if (kind === 'confirm') {
        await sendSubscriptionConfirmMail({ to: EMAIL, token: 'tok', locale: 'en' }, log);
      } else {
        await sendSubscriptionAlreadyMail({ to: EMAIL, manageToken: 'tok', locale: 'en' }, log);
      }

      const [lift, ...more] = liftsOf();
      expect(more).toEqual([]);
      expect(lift!.values).toEqual([EMAIL, kind]);
      expect(log.warn).toHaveBeenCalledWith(
        { reason: 'SENDGRID_SEND_FAILED', status: 400 },
        'newsletter subscription mail was not sent',
      );
    },
  );

  it('is taken back also for a fault of the server itself, which sent nothing either', async () => {
    sendMock.mockRejectedValue(new InternalError({ reason: 'NEWSLETTER_EMAIL_FROM_REQUIRED' }));
    const log = logger();

    await sendSubscriptionConfirmMail({ to: EMAIL, token: 'tok', locale: 'en' }, log);

    expect(liftsOf()).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      { err: expect.anything() },
      'newsletter subscription mail could not be built or sent',
    );
  });

  // the answer of the form went already: a lift that fails must not throw out of the mail, which
  // nobody awaits, and must not put the address or the text of the error in the log
  it('is only logged when taking it back fails, without the address or the text of the error', async () => {
    sendMock.mockRejectedValue(refused());
    liftFails = true;
    const log = logger();

    await expect(
      sendSubscriptionConfirmMail({ to: EMAIL, token: 'tok', locale: 'en' }, log),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      { kind: 'confirm', code: 'DB_FAILED' },
      'newsletter subscription mail mark could not be lifted',
    );
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain(EMAIL);
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain('a@b.c');
  });
});

describe('the mail of a subscription a spam mark paused', () => {
  const paused = {
    email: EMAIL,
    source: 'form',
    locale: 'en',
    status: 'paused_complaint',
    can_change_locale: true,
  };

  it('takes the address off the list of spam reports and only then sends the mail of the pause', async () => {
    manageRow = paused;

    await sendSubscriptionAlreadyMail({ to: EMAIL, manageToken: 'tok', locale: 'en' }, logger());

    expect(order).toEqual(['clear', 'send']);
    expect(clearMock).toHaveBeenCalledWith(EMAIL, expect.anything());
    expect(sendMock.mock.calls[0]![0].subject.toLowerCase()).toContain('paused');
  });

  it.each(['active', 'stopped_bounce'])(
    'does not touch the list for a subscription that is %s',
    async (status) => {
      manageRow = { ...paused, status };

      await sendSubscriptionAlreadyMail({ to: EMAIL, manageToken: 'tok', locale: 'en' }, logger());

      expect(clearMock).not.toHaveBeenCalled();
      expect(sendMock.mock.calls[0]![0].subject.toLowerCase()).toContain('already subscribed');
    },
  );

  it.each([
    ['cannot be read', 'fail' as const],
    ['is gone by then', 'missing' as const],
  ])(
    'sends the usual mail and logs a warning without the address when the subscription %s',
    async (_what, row) => {
      manageRow = row;
      const log = logger();

      await sendSubscriptionAlreadyMail({ to: EMAIL, manageToken: 'tok', locale: 'en' }, log);

      expect(clearMock).not.toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0]![0].subject.toLowerCase()).toContain('already subscribed');
      expect(log.warn).toHaveBeenCalledWith(
        { code: 'DB_FAILED' },
        'newsletter subscription state could not be read before its mail',
      );
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(EMAIL);
    },
  );
});
