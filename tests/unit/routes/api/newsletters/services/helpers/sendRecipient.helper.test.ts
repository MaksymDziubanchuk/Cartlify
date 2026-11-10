import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { InternalError } from '@utils/errors.js';

// The sending of one mail of a campaign and what the pass does with the mails SendGrid did not take.
// The database and SendGrid are replaced; the pass as a whole is checked in
// tests/integration/worker/newsletterPass.shopwide.test.ts
//
// A mail SendGrid refused is held until the pass learns whose fault it is, the mail's or the stream's:
// a mail taken after it says the mail's, ten refused in a row say the stream's and halt the pass. A mail
// that was tried before and is refused again, when a mail of its campaign has been taken since that
// try, is the mail's fault at once: it is rejected and is no part of the run. When the pass halts, the
// mails that were refused keep their try and wait out their lease (they come back behind the mails with
// fewer tries); the mails that found SendGrid busy, and the ones not tried, are given back free.

const recordSent = jest.fn<(args: unknown) => Promise<void>>(async () => undefined);
const recordRejected = jest.fn<(args: unknown) => Promise<void>>(async () => undefined);
const recordSkipped = jest.fn<(recipientId: number) => Promise<void>>(async () => undefined);
const releaseRecipients = jest.fn<(ids: number[]) => Promise<number>>(async (ids) => ids.length);
const acceptedSince = jest.fn<(campaignId: number, since: Date) => Promise<boolean>>(
  async () => false,
);
const deliveryStateOf = jest.fn<
  (recipientId: number) => Promise<{ mail: 'queued'; campaign: 'sending'; subscription: 'active' }>
>(async () => ({ mail: 'queued', campaign: 'sending', subscription: 'active' }));
const send = jest.fn<(mail: { to: string }) => Promise<{ messageId?: string }>>(async () => ({
  messageId: 'id-1',
}));

jest.unstable_mockModule('@routes/api/newsletters/services/helpers/sendingStore.helper.js', () => ({
  recordSent,
  recordRejected,
  recordSkipped,
  releaseRecipients,
  acceptedSince,
  deliveryStateOf,
  campaignMaterialOf: jest.fn(async () => ({ content: {}, snapshot: {} })),
}));
jest.unstable_mockModule('@services/email/sendNewsletterEmail.js', () => ({
  sendNewsletterEmail: send,
}));
jest.unstable_mockModule(
  '@routes/api/newsletters/services/helpers/newsletterMail.helper.js',
  () => ({
    newsletterMailFor: jest.fn(() => ({
      subject: 'Sale',
      text: 'text',
      html: '<p>text</p>',
      headers: {},
      warnings: [],
    })),
  }),
);
jest.unstable_mockModule('@helpers/newsletterTokens.js', () => ({
  manageTokenOf: (salt: string) => `manage-${salt}`,
  unsubscribeTokenOf: (salt: string) => `unsubscribe-${salt}`,
}));

const { FAILURE_STREAK_LIMIT, PassHalt, deliverRecipient, judgeHeld, releaseHeld } =
  await import('@routes/api/newsletters/services/helpers/sendRecipient.helper.js');
type Ctx =
  import('@routes/api/newsletters/services/helpers/sendRecipient.helper.js').DeliveryContext;
type Row =
  import('@routes/api/newsletters/services/helpers/sendingStore.helper.js').ClaimedRecipient;

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const ctxOf = (): Ctx => ({
  log,
  clock: () => new Date('2100-06-15T10:00:00Z'),
  material: async () => ({ content: {} as never, snapshot: {} as never }),
  held: { refused: [], unavailable: [] },
  tally: { rejected: 0, retried: 0, released: 0, deferred: 0 },
  halted: null,
  accepted: new Set(),
  failures: new Map(),
});

const PREVIOUS = new Date('2100-06-15T09:00:00Z');

let nextId = 1;
const rowOf = (over: Partial<Row> = {}): Row => ({
  recipientId: nextId++,
  campaignId: 5,
  locale: 'en',
  email: 'reader@example.com',
  manageSalt: 'salt',
  lastAttempt: false,
  previousTry: null,
  ...over,
});

// the error postToSendGrid throws when SendGrid answers with a status
const answer = (status: number) =>
  new InternalError({ reason: 'SENDGRID_SEND_FAILED' }, { status, body: { errors: [] } });

const refuseNext = () => send.mockRejectedValueOnce(answer(400));
const busyNext = () => send.mockRejectedValueOnce(answer(503));

beforeEach(() => {
  nextId = 1;
  for (const fn of [recordSent, recordRejected, recordSkipped, releaseRecipients, acceptedSince]) {
    fn.mockClear();
  }
  acceptedSince.mockResolvedValue(false);
  releaseRecipients.mockImplementation(async (ids: number[]) => ids.length);
  send.mockReset();
  send.mockResolvedValue({ messageId: 'id-1' });
});

describe('a mail that was tried before and is refused again', () => {
  it('is rejected at once when a mail of its campaign was taken since its previous try', async () => {
    const ctx = ctxOf();
    const row = rowOf({ previousTry: PREVIOUS });
    acceptedSince.mockResolvedValueOnce(true);
    refuseNext();

    const result = await deliverRecipient(row, ctx);

    expect(result).toBe('rejected');
    expect(acceptedSince).toHaveBeenCalledWith(5, PREVIOUS);
    expect(recordRejected).toHaveBeenCalledWith({ recipientId: row.recipientId, campaignId: 5 });
    // it is no part of the run of refusals: nothing is held for it
    expect(ctx.held.refused).toEqual([]);
    expect(ctx.halted).toBeNull();
  });

  it('is held in the run of refusals when no mail of its campaign was taken since', async () => {
    const ctx = ctxOf();
    const row = rowOf({ previousTry: PREVIOUS });
    refuseNext();

    const result = await deliverRecipient(row, ctx);

    expect(result).toBe('held');
    expect(acceptedSince).toHaveBeenCalledWith(5, PREVIOUS);
    expect(recordRejected).not.toHaveBeenCalled();
    expect(ctx.held.refused).toEqual([
      { recipientId: row.recipientId, campaignId: 5, reject: true },
    ]);
  });

  it('does not count toward the ten that halt the pass', async () => {
    const ctx = ctxOf();

    // a hundred of them, each with a mail of its campaign taken since: none is held, none halts
    acceptedSince.mockResolvedValue(true);
    for (let i = 0; i < 100; i += 1) {
      refuseNext();
      expect(await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx)).toBe('rejected');
    }

    expect(ctx.halted).toBeNull();
    expect(ctx.held.refused).toEqual([]);
    expect(recordRejected).toHaveBeenCalledTimes(100);

    // and the ten after them still halt it, no more and no less
    acceptedSince.mockResolvedValue(false);
    for (let i = 0; i < FAILURE_STREAK_LIMIT - 1; i += 1) {
      refuseNext();
      await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx);
    }
    expect(ctx.halted).toBeNull();

    refuseNext();
    await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx);
    expect(ctx.halted).toMatchObject({ why: 'every_mail_refused' });
  });

  it('counts with the mails refused for the first time in the run of refusals', async () => {
    const ctx = ctxOf();

    for (let i = 0; i < 5; i += 1) {
      refuseNext();
      await deliverRecipient(rowOf(), ctx);
    }
    for (let i = 0; i < 4; i += 1) {
      refuseNext();
      await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx);
    }
    expect(ctx.halted).toBeNull();

    refuseNext();
    await deliverRecipient(rowOf(), ctx);
    expect(ctx.halted).toMatchObject({ why: 'every_mail_refused' });
  });

  it('is not asked about when the pass has halted: it is held with the rest', async () => {
    const ctx = ctxOf();
    // a mail that began before the halt and is answered after it
    const row = rowOf({ previousTry: PREVIOUS });
    send.mockImplementationOnce(async () => {
      ctx.halted = new PassHalt('every_mail_refused');
      throw answer(400);
    });
    acceptedSince.mockResolvedValue(true);

    const result = await deliverRecipient(row, ctx);

    expect(result).toBe('held');
    expect(acceptedSince).not.toHaveBeenCalled();
    expect(recordRejected).not.toHaveBeenCalled();
    expect(ctx.held.refused).toHaveLength(1);
  });

  it('is rejected at once on its last try as well, when a mail was taken since', async () => {
    const ctx = ctxOf();
    acceptedSince.mockResolvedValueOnce(true);
    refuseNext();

    const result = await deliverRecipient(rowOf({ previousTry: PREVIOUS, lastAttempt: true }), ctx);

    expect(result).toBe('rejected');
    expect(ctx.held.refused).toEqual([]);
  });

  it('is not asked about when it is the first try of the mail', async () => {
    const ctx = ctxOf();
    refuseNext();

    await deliverRecipient(rowOf(), ctx);

    expect(acceptedSince).not.toHaveBeenCalled();
    expect(ctx.held.refused).toHaveLength(1);
  });

  it('is not asked about when SendGrid was busy, not refusing: the mail waits out its lease', async () => {
    const ctx = ctxOf();
    busyNext();

    const result = await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx);

    expect(result).toBe('held');
    expect(acceptedSince).not.toHaveBeenCalled();
    expect(ctx.held.refused).toEqual([]);
    expect(ctx.held.unavailable).toHaveLength(1);
  });

  it('is taken when SendGrid takes it: nothing to ask', async () => {
    const ctx = ctxOf();

    const result = await deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx);

    expect(result).toBe('sent');
    expect(acceptedSince).not.toHaveBeenCalled();
    expect(recordSent).toHaveBeenCalledTimes(1);
  });

  it('stops the pass with the failure of the database when the question cannot be answered', async () => {
    const ctx = ctxOf();
    acceptedSince.mockRejectedValueOnce(new Error('connection lost'));
    refuseNext();

    await expect(deliverRecipient(rowOf({ previousTry: PREVIOUS }), ctx)).rejects.toThrow(
      'connection lost',
    );
  });
});

describe('the mails held when the pass halts', () => {
  it('keeps the refused mails with their try and gives back the busy ones', async () => {
    const ctx = ctxOf();
    ctx.held.refused.push(
      { recipientId: 1, campaignId: 5, reject: true },
      { recipientId: 2, campaignId: 5, reject: true },
    );
    ctx.held.unavailable.push(
      { recipientId: 3, campaignId: 5, reject: false },
      { recipientId: 4, campaignId: 5, reject: true },
    );

    const given = await releaseHeld(ctx);

    // only the busy ones go back to the queue, free at once; the refused wait out their lease
    expect(releaseRecipients).toHaveBeenCalledTimes(1);
    expect(releaseRecipients).toHaveBeenCalledWith([3, 4]);
    expect(given).toBe(2);
    expect(ctx.tally).toEqual({ rejected: 0, retried: 0, released: 2, deferred: 2 });
    expect(ctx.held).toEqual({ refused: [], unavailable: [] });
  });

  it('asks the database for nothing when only refused mails are held', async () => {
    const ctx = ctxOf();
    ctx.held.refused.push({ recipientId: 1, campaignId: 5, reject: true });

    expect(await releaseHeld(ctx)).toBe(0);

    expect(releaseRecipients).not.toHaveBeenCalled();
    expect(ctx.tally).toEqual({ rejected: 0, retried: 0, released: 0, deferred: 1 });
    expect(ctx.held.refused).toEqual([]);
  });

  it('keeps the refused mails even when giving the busy ones back fails', async () => {
    const ctx = ctxOf();
    ctx.held.refused.push({ recipientId: 1, campaignId: 5, reject: true });
    ctx.held.unavailable.push({ recipientId: 3, campaignId: 5, reject: false });
    releaseRecipients.mockRejectedValueOnce(new Error('connection lost'));

    await expect(releaseHeld(ctx)).rejects.toThrow('connection lost');

    expect(ctx.tally.deferred).toBe(1);
    expect(ctx.held.refused).toEqual([]);
    // the busy one stays held: it is free when its lease runs out
    expect(ctx.held.unavailable).toHaveLength(1);
  });

  it('does nothing when nothing is held', async () => {
    const ctx = ctxOf();

    expect(await releaseHeld(ctx)).toBe(0);

    expect(releaseRecipients).not.toHaveBeenCalled();
    expect(ctx.tally).toEqual({ rejected: 0, retried: 0, released: 0, deferred: 0 });
  });
});

describe('the mails held when the pass does not halt', () => {
  it('rejects the refused ones and leaves the busy ones to their lease', async () => {
    const ctx = ctxOf();
    ctx.held.refused.push({ recipientId: 1, campaignId: 5, reject: true });
    ctx.held.unavailable.push({ recipientId: 2, campaignId: 5, reject: false });

    await judgeHeld(ctx);

    expect(recordRejected).toHaveBeenCalledTimes(1);
    expect(recordRejected).toHaveBeenCalledWith({ recipientId: 1, campaignId: 5 });
    expect(ctx.tally).toEqual({ rejected: 1, retried: 1, released: 0, deferred: 0 });
  });

  it('judges nothing once the pass has halted', async () => {
    const ctx = ctxOf();
    ctx.halted = new PassHalt('every_mail_refused');
    ctx.held.refused.push({ recipientId: 1, campaignId: 5, reject: true });

    await judgeHeld(ctx);

    expect(recordRejected).not.toHaveBeenCalled();
    expect(ctx.held.refused).toHaveLength(1);
  });
});
