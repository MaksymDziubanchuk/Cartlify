import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import {
  campaignIn,
  eventRow,
  insertRow,
  insertSubscription,
  recipientIn,
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  type CampaignState,
  type NewsletterFixtures,
  type RecipientState,
  type SubscriptionStatus,
} from '../../helpers/newsletterDb.js';
import {
  GUEST,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  journalOf,
  near,
  subscriptionById,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// what SendGrid tells about a mail of a campaign, as the database takes it
// (cartlify.newsletter_apply_event): a bounce stops the subscription, a spam report pauses it, a
// drop only counts. Only the system reports. The mail of a campaign is a recipient row; a campaign
// that was started cannot be left in the database (only a draft is deleted), so every case makes
// its rows in a session of the owner of the database that rolls back, and the actor is set
// by hand the way the functions find it

let fx: NewsletterFixtures;

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });

type EventName = 'bounce' | 'dropped' | 'spamreport';

// what each event does to the mail and which total of the campaign it counts in
const EVENTS: Record<
  EventName,
  { recipient: RecipientState; total: 'undeliveredCount' | 'complaintCount' }
> = {
  bounce: { recipient: 'bounced', total: 'undeliveredCount' },
  dropped: { recipient: 'dropped', total: 'undeliveredCount' },
  spamreport: { recipient: 'complained', total: 'complaintCount' },
};
const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

type Scene = {
  campaign: number;
  subscription: number;
  recipient: number;
  email: string;
  locale: string | null;
};

// a subscription with a line of its journal, a campaign and the mail of the campaign to it
async function sceneIn(
  db: OwnerSession,
  opts: {
    subscription?: SubscriptionStatus;
    source?: 'form' | 'account';
    recipient?: RecipientState;
    campaign?: CampaignState;
    locale?: string | null;
  } = {},
): Promise<Scene> {
  const locale = opts.locale === undefined ? 'es' : opts.locale;
  const account = opts.source === 'account';
  const email = account
    ? fx.stranger.email
    : `scene-${Math.random().toString(16).slice(2)}@example.com`;

  const subscription = await insertSubscription(db, {
    email,
    source: opts.source ?? 'form',
    userId: account ? fx.stranger.id : undefined,
    status: opts.subscription ?? 'active',
    locale,
  });
  await insertRow(
    db,
    'newsletter_subscription_events',
    eventRow(subscription, { event: 'confirmed' }),
  );

  const campaign = await campaignIn(db, MANAGER(), opts.campaign ?? 'sending');
  const recipient = await recipientIn(db, campaign, subscription, opts.recipient ?? 'sent');

  return { campaign, subscription, recipient, email, locale };
}

const apply = (
  db: OwnerSession,
  actor: Actor | null,
  recipient: number | null,
  event: string | null,
) => attemptAs<{ result: string }>(db, actor, SQL.applyEvent, recipient, event);

type Totals = { undeliveredCount: number; complaintCount: number; unsubscribedCount: number };

async function stateOf(db: OwnerSession, scene: Scene) {
  const [recipient] = await callAs<{ status: string }>(
    db,
    SYSTEM,
    'select status::text as status from cartlify.newsletter_recipients where id = $1',
    scene.recipient,
  );
  const [totals] = await callAs<Totals>(
    db,
    SYSTEM,
    `select "undeliveredCount", "complaintCount", "unsubscribedCount"
     from cartlify.newsletter_campaigns where id = $1`,
    scene.campaign,
  );

  return {
    recipient: recipient!.status,
    totals: totals!,
    subscription: (await subscriptionById(db, scene.subscription))!,
    journal: await journalOf(db, scene.subscription),
  };
}

const NO_TOTALS: Totals = { undeliveredCount: 0, complaintCount: 0, unsubscribedCount: 0 };
const totalsOf = (event: EventName): Totals => ({ ...NO_TOTALS, [EVENTS[event].total]: 1 });

// what a subscription becomes on an event, and the line of the journal that says so (none when the
// subscription does not change)
const SUBSCRIPTION_AFTER: Record<
  Exclude<SubscriptionStatus, 'pending'>,
  Record<EventName, { status: SubscriptionStatus; line: 'bounced' | 'complaint' | null }>
> = {
  active: {
    bounce: { status: 'stopped_bounce', line: 'bounced' },
    dropped: { status: 'active', line: null },
    spamreport: { status: 'paused_complaint', line: 'complaint' },
  },
  paused_complaint: {
    bounce: { status: 'stopped_bounce', line: 'bounced' },
    dropped: { status: 'paused_complaint', line: null },
    spamreport: { status: 'paused_complaint', line: null },
  },
  stopped_bounce: {
    bounce: { status: 'stopped_bounce', line: null },
    dropped: { status: 'stopped_bounce', line: null },
    spamreport: { status: 'stopped_bounce', line: null },
  },
  ended: {
    bounce: { status: 'ended', line: null },
    dropped: { status: 'ended', line: null },
    spamreport: { status: 'ended', line: null },
  },
};

const CASES = (Object.keys(SUBSCRIPTION_AFTER) as (keyof typeof SUBSCRIPTION_AFTER)[]).flatMap(
  (from) => EVENT_NAMES.map((event) => [from, event] as const),
);

describe('cartlify.newsletter_apply_event, the system reports an event', () => {
  it.each(CASES)(
    'a subscription %s takes %s: the mail, the totals of the campaign and the subscription',
    async (from, event) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { subscription: from });
        const before = await stateOf(db, scene);
        const now = await dbNow(db);

        const outcome = await apply(db, SYSTEM, scene.recipient, event);
        expect(outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });

        const after = await stateOf(db, scene);
        const expected = SUBSCRIPTION_AFTER[from][event];

        // the mail and the totals of the campaign: the event counted once
        expect(after.recipient).toBe(EVENTS[event].recipient);
        expect(after.totals).toEqual(totalsOf(event));

        // the subscription: what the row of the state says, nothing else of it moves
        expect(after.subscription.status).toBe(expected.status);
        expect(after.subscription).toMatchObject({
          email: before.subscription.email,
          locale: scene.locale,
          manageHash: before.subscription.manageHash,
        });

        if (expected.status === 'stopped_bounce' && from !== 'stopped_bounce') {
          expect(after.subscription).toMatchObject({ endReason: 'bounced', confirmHash: null });
          expect(near(after.subscription.endedAt, now)).toBe(true);
        } else {
          expect(after.subscription.endedAt).toEqual(before.subscription.endedAt);
          expect(after.subscription.endReason).toBe(before.subscription.endReason);
        }

        // the journal: one line, from the webhook, naming the campaign whose mail did it
        expect(after.journal.slice(0, 1)).toEqual(before.journal);
        expect(after.journal.slice(1)).toEqual(
          expected.line === null
            ? []
            : [
                expect.objectContaining({
                  event: expected.line,
                  place: 'webhook',
                  ip: null,
                  userAgent: null,
                  locale: scene.locale,
                  campaignId: scene.campaign,
                  privacyVersion: null,
                  actorId: null,
                }),
              ],
        );
      });
    },
  );

  it('stops the subscription of an account the same way, and keeps its account', async () => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db, { source: 'account' });

      expect(await apply(db, SYSTEM, scene.recipient, 'bounce')).toEqual({
        ok: true,
        rows: [{ result: 'applied' }],
      });

      expect((await subscriptionById(db, scene.subscription))!).toMatchObject({
        source: 'account',
        userId: fx.stranger.id,
        status: 'stopped_bounce',
        endReason: 'bounced',
      });
    });
  });

  it.each(['sending', 'finished', 'stopped'] as CampaignState[])(
    'counts in a campaign that is %s',
    async (campaign) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { campaign });

        await apply(db, SYSTEM, scene.recipient, 'spamreport');

        expect((await stateOf(db, scene)).totals).toEqual({ ...NO_TOTALS, complaintCount: 1 });
      });
    },
  );

  it.each(EVENT_NAMES)(
    'counts a repeated %s once: SendGrid may send an event again',
    async (event) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db);

        const first = await apply(db, SYSTEM, scene.recipient, event);
        const afterFirst = await stateOf(db, scene);
        const second = await apply(db, SYSTEM, scene.recipient, event);
        const third = await apply(db, SYSTEM, scene.recipient, event);

        expect(first).toEqual({ ok: true, rows: [{ result: 'applied' }] });
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(await stateOf(db, scene)).toEqual(afterFirst);
        expect(afterFirst.totals).toEqual(totalsOf(event));
      });
    },
  );

  // the first outcome of a mail is its outcome: a later event for the same mail changes nothing
  it.each(
    EVENT_NAMES.flatMap((first) =>
      EVENT_NAMES.filter((later) => later !== first).map((later) => [first, later] as const),
    ),
  )('keeps what %s said of a mail when %s comes after it', async (first, later) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);

      await apply(db, SYSTEM, scene.recipient, first);
      const afterFirst = await stateOf(db, scene);
      const outcome = await apply(db, SYSTEM, scene.recipient, later);

      expect(outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });
      expect(await stateOf(db, scene)).toEqual(afterFirst);
    });
  });

  it.each(['bounced', 'dropped', 'complained'] as RecipientState[])(
    'does nothing for a mail that is already %s, whatever the event',
    async (recipient) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { recipient });
        const before = await stateOf(db, scene);

        for (const event of EVENT_NAMES) {
          expect(await apply(db, SYSTEM, scene.recipient, event)).toEqual({
            ok: true,
            rows: [{ result: 'applied' }],
          });
        }

        expect(await stateOf(db, scene)).toEqual(before);
      });
    },
  );

  // a mail SendGrid refused has no outcome to report: an event for it belongs to some other mail,
  // e.g. of another environment on the same account of SendGrid
  it.each(EVENT_NAMES)('knows no mail that was rejected: %s changes nothing', async (event) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db, { recipient: 'rejected' });
      const before = await stateOf(db, scene);

      expect(await apply(db, SYSTEM, scene.recipient, event)).toEqual({
        ok: true,
        rows: [{ result: 'unknown' }],
      });
      expect(await stateOf(db, scene)).toEqual(before);
    });
  });

  // SendGrid tells of a mail only after it accepted the mail, and it can tell before the sending
  // has written down that it did (a bounce comes within a second): an event for a mail that still
  // waits is the event of a mail that left, and it is not lost
  describe('for a mail the sending has not written down as sent yet', () => {
    it.each(EVENT_NAMES)('takes %s as it takes it for a sent mail', async (event) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { recipient: 'queued' });
        const before = await stateOf(db, scene);
        const now = await dbNow(db);

        expect(await apply(db, SYSTEM, scene.recipient, event)).toEqual({
          ok: true,
          rows: [{ result: 'applied' }],
        });

        const after = await stateOf(db, scene);
        const expected = SUBSCRIPTION_AFTER.active[event];

        // the outcome, the total of the campaign and the subscription: as for a mail that was sent
        expect(after.recipient).toBe(EVENTS[event].recipient);
        expect(after.totals).toEqual(totalsOf(event));
        expect(after.subscription.status).toBe(expected.status);
        expect(after.journal.slice(1)).toEqual(
          expected.line === null
            ? []
            : [expect.objectContaining({ event: expected.line, place: 'webhook' })],
        );

        // the mail left, so the row says when it was told of: the check of the table wants a time
        const [row] = await callAs<{ sentAt: Date | null; providerMessageId: string | null }>(
          db,
          SYSTEM,
          'select "sentAt", "providerMessageId" from cartlify.newsletter_recipients where id = $1',
          scene.recipient,
        );
        expect(near(row!.sentAt, now)).toBe(true);
        expect(row!.providerMessageId).toBeNull();
        expect(before.recipient).toBe('queued');
      });
    });

    it.each(EVENT_NAMES)('counts a repeated %s once', async (event) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { recipient: 'queued' });

        const first = await apply(db, SYSTEM, scene.recipient, event);
        const afterFirst = await stateOf(db, scene);
        const second = await apply(db, SYSTEM, scene.recipient, event);

        expect(first).toEqual({ ok: true, rows: [{ result: 'applied' }] });
        expect(second).toEqual(first);
        expect(await stateOf(db, scene)).toEqual(afterFirst);
        expect(afterFirst.totals).toEqual(totalsOf(event));
      });
    });

    it('keeps what the first event said when another comes', async () => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { recipient: 'queued' });

        await apply(db, SYSTEM, scene.recipient, 'bounce');
        const afterFirst = await stateOf(db, scene);
        await apply(db, SYSTEM, scene.recipient, 'spamreport');

        expect(await stateOf(db, scene)).toEqual(afterFirst);
      });
    });
  });

  it('keeps to the mail it was told of: the other mails and campaigns stay as they were', async () => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);
      const otherCampaign = await campaignIn(db, MANAGER(), 'finished');
      const earlier = await recipientIn(db, otherCampaign, scene.subscription, 'sent');
      const neighbour = await sceneIn(db);

      await apply(db, SYSTEM, scene.recipient, 'bounce');

      const status = (id: number) =>
        callAs<{ status: string }>(
          db,
          SYSTEM,
          'select status::text as status from cartlify.newsletter_recipients where id = $1',
          id,
        );
      expect(await status(earlier)).toEqual([{ status: 'sent' }]);
      expect(await status(neighbour.recipient)).toEqual([{ status: 'sent' }]);
      expect((await stateOf(db, neighbour)).totals).toEqual(NO_TOTALS);
      expect((await stateOf(db, neighbour)).subscription.status).toBe('active');
      const [other] = await callAs<Totals>(
        db,
        SYSTEM,
        `select "undeliveredCount", "complaintCount", "unsubscribedCount"
         from cartlify.newsletter_campaigns where id = $1`,
        otherCampaign,
      );
      expect(other).toEqual(NO_TOTALS);
    });
  });

  it.each([
    ['one this database does not have', 2147483647],
    ['zero', 0],
    ['a negative one', -5],
    ['none', null],
  ])('is not an error for a recipient id that is %s: the answer is unknown', async (_what, id) => {
    await inOwnerTx(async (db) => {
      for (const event of EVENT_NAMES) {
        expect(await apply(db, SYSTEM, id, event)).toEqual({
          ok: true,
          rows: [{ result: 'unknown' }],
        });
      }
    });
  });

  it.each([
    'delivered',
    'open',
    'click',
    'processed',
    'deferred',
    'unsubscribe',
    'BOUNCE',
    ' bounce',
    '',
    null,
  ])('refuses the event %j and changes nothing', async (event) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);
      const before = await stateOf(db, scene);

      expect(codeOf(await apply(db, SYSTEM, scene.recipient, event))).toBe(
        'NEWSLETTER_EVENT_INVALID',
      );
      expect(codeOf(await apply(db, SYSTEM, 2147483647, event))).toBe('NEWSLETTER_EVENT_INVALID');
      expect(await stateOf(db, scene)).toEqual(before);
    });
  });
});

describe('cartlify.newsletter_apply_event, for anybody but the system', () => {
  const OUTSIDERS: [string, () => Actor | null][] = [
    ['a guest', GUEST],
    ['no context', () => null],
    ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
    [
      'an admin without the right to run the newsletters',
      () => ({ role: 'ADMIN', userId: fx.plainAdmin.id }),
    ],
    ['an admin with the right to run them', MANAGER],
    ['root', () => ({ role: 'ROOT', userId: fx.root.id })],
    ['root without an account', () => ({ role: 'ROOT' })],
  ];

  it.each(OUTSIDERS)('refuses %s and changes nothing', async (_who, actor) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);
      const before = await stateOf(db, scene);

      for (const event of [...EVENT_NAMES, 'delivered']) {
        expect(codeOf(await apply(db, actor(), scene.recipient, event))).toBe(
          'NEWSLETTER_FORBIDDEN',
        );
      }
      expect(codeOf(await apply(db, actor(), 2147483647, 'bounce'))).toBe('NEWSLETTER_FORBIDDEN');
      expect(await stateOf(db, scene)).toEqual(before);
    });
  });

  // the app connects as cartlify_app: the function has to be one it may run
  it('is run by the role of the app for the system, and refuses the others', async () => {
    const answers = await inRolledBackTx(async (db) => {
      const system = await attemptAs<{ result: string }>(
        db,
        SYSTEM,
        SQL.applyEvent,
        2147483647,
        'bounce',
      );
      const wrongEvent = await attemptAs(db, SYSTEM, SQL.applyEvent, 2147483647, 'open');
      const guest = await attemptAs(db, GUEST(), SQL.applyEvent, 2147483647, 'bounce');
      const root = await attemptAs(
        db,
        { role: 'ROOT', userId: fx.root.id },
        SQL.applyEvent,
        2147483647,
        'bounce',
      );
      return { system, wrongEvent: codeOf(wrongEvent), guest: codeOf(guest), root: codeOf(root) };
    });

    expect(answers).toEqual({
      system: { ok: true, rows: [{ result: 'unknown' }] },
      wrongEvent: 'NEWSLETTER_EVENT_INVALID',
      guest: 'NEWSLETTER_FORBIDDEN',
      root: 'NEWSLETTER_FORBIDDEN',
    });
  });
});

// SendGrid drops a mail it will not deliver and says why. Two reasons are the news of a bounce and
// of a complaint that SendGrid knew of already (its own lists): the mail is dropped and counts as
// undelivered, and the subscription is dealt with as the real event would deal with it
// (cartlify.newsletter_apply_event, the third argument)
describe('the reason of a dropped mail', () => {
  const applyWithReason = (
    db: OwnerSession,
    actor: Actor | null,
    recipient: number | null,
    event: string | null,
    reason: string | null,
  ) => attemptAs<{ result: string }>(db, actor, SQL.applyEventWithReason, recipient, event, reason);

  const BOUNCED = 'Bounced Address';
  const SPAM = 'Spam Reporting Address';

  it.each([
    ['active', 'stopped_bounce'],
    ['paused_complaint', 'stopped_bounce'],
    ['stopped_bounce', 'stopped_bounce'],
    ['ended', 'ended'],
  ] as const)(
    'stops a subscription that is %s when the reason is a bounced address, like a bounce (%s)',
    async (from, to) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { subscription: from });
        const before = await stateOf(db, scene);
        const now = await dbNow(db);

        const outcome = await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', BOUNCED);
        expect(outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });

        const after = await stateOf(db, scene);
        // the mail is dropped and counted as undelivered, never as a complaint
        expect(after.recipient).toBe('dropped');
        expect(after.totals).toEqual({ ...NO_TOTALS, undeliveredCount: 1 });
        expect(after.subscription.status).toBe(to);

        if (from === 'active' || from === 'paused_complaint') {
          expect(after.subscription).toMatchObject({ endReason: 'bounced', confirmHash: null });
          expect(near(after.subscription.endedAt, now)).toBe(true);
          expect(after.journal.slice(before.journal.length)).toEqual([
            expect.objectContaining({
              event: 'bounced',
              place: 'webhook',
              ip: null,
              userAgent: null,
              locale: scene.locale,
              campaignId: scene.campaign,
              actorId: null,
            }),
          ]);
        } else {
          expect(after.subscription.endReason).toBe(before.subscription.endReason);
          expect(after.journal).toEqual(before.journal);
        }
      });
    },
  );

  it.each([
    ['active', 'paused_complaint', 'complaint'],
    ['paused_complaint', 'paused_complaint', null],
    ['stopped_bounce', 'stopped_bounce', null],
    ['ended', 'ended', null],
  ] as const)(
    'pauses a subscription that is %s when the reason is a spam-reporting address, like a complaint (%s)',
    async (from, to, line) => {
      await inOwnerTx(async (db) => {
        const scene = await sceneIn(db, { subscription: from });
        const before = await stateOf(db, scene);

        const outcome = await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', SPAM);
        expect(outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });

        const after = await stateOf(db, scene);
        expect(after.recipient).toBe('dropped');
        // it is the mail that was dropped: undelivered, and not a complaint of this campaign
        expect(after.totals).toEqual({ ...NO_TOTALS, undeliveredCount: 1 });
        expect(after.subscription.status).toBe(to);
        expect(after.subscription.endReason).toBe(before.subscription.endReason);

        expect(after.journal.slice(before.journal.length)).toEqual(
          line === null
            ? []
            : [
                expect.objectContaining({
                  event: line,
                  place: 'webhook',
                  campaignId: scene.campaign,
                }),
              ],
        );
      });
    },
  );

  it.each([
    ['another reason', 'Invalid'],
    ['the reason of an unsubscribed address', 'Unsubscribed Address'],
    ['a reason in other words', 'Bounced Addresses'],
    ['an empty reason', ''],
    ['no reason', null],
  ])('only counts a dropped mail when the reason is %s', async (_what, reason) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);
      const before = await stateOf(db, scene);

      expect(await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', reason)).toEqual({
        ok: true,
        rows: [{ result: 'applied' }],
      });

      const after = await stateOf(db, scene);
      expect(after.recipient).toBe('dropped');
      expect(after.totals).toEqual({ ...NO_TOTALS, undeliveredCount: 1 });
      expect(after.subscription.status).toBe('active');
      expect(after.subscription.endReason).toBeNull();
      expect(after.journal).toEqual(before.journal);
    });
  });

  it('takes the reason however SendGrid cases it', async () => {
    await inOwnerTx(async (db) => {
      const bounced = await sceneIn(db);
      const spam = await sceneIn(db);

      await applyWithReason(db, SYSTEM, bounced.recipient, 'dropped', ' bounced address ');
      await applyWithReason(db, SYSTEM, spam.recipient, 'dropped', 'SPAM REPORTING ADDRESS');

      expect((await stateOf(db, bounced)).subscription.status).toBe('stopped_bounce');
      expect((await stateOf(db, spam)).subscription.status).toBe('paused_complaint');
    });
  });

  it.each(['bounce', 'spamreport'] as const)(
    'ignores a reason on the event %s: the event decides',
    async (event) => {
      await inOwnerTx(async (db) => {
        const withReason = await sceneIn(db);
        const without = await sceneIn(db);

        await applyWithReason(db, SYSTEM, withReason.recipient, event, 'Invalid');
        await apply(db, SYSTEM, without.recipient, event);

        const a = await stateOf(db, withReason);
        const b = await stateOf(db, without);
        expect(a.recipient).toBe(b.recipient);
        expect(a.totals).toEqual(b.totals);
        expect(a.subscription.status).toBe(b.subscription.status);
      });
    },
  );

  it('counts the first outcome of a mail only: a repeated drop with a reason changes nothing', async () => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);

      await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', BOUNCED);
      const afterFirst = await stateOf(db, scene);

      for (const reason of [BOUNCED, SPAM, null]) {
        expect(await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', reason)).toEqual({
          ok: true,
          rows: [{ result: 'applied' }],
        });
      }
      expect(await applyWithReason(db, SYSTEM, scene.recipient, 'bounce', null)).toEqual({
        ok: true,
        rows: [{ result: 'applied' }],
      });

      expect(await stateOf(db, scene)).toEqual(afterFirst);
    });
  });

  it('serves a mail that still waits (queued) the same way', async () => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db, { recipient: 'queued' });

      await applyWithReason(db, SYSTEM, scene.recipient, 'dropped', BOUNCED);

      const after = await stateOf(db, scene);
      expect(after.recipient).toBe('dropped');
      expect(after.subscription.status).toBe('stopped_bounce');
    });
  });

  it.each([
    ['a guest', GUEST],
    ['root', () => ({ role: 'ROOT', userId: fx.root.id }) as Actor],
    ['a manager', MANAGER],
    ['no context', () => null],
  ])('is refused to %s as ever, with a reason too', async (_who, actor) => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);
      const before = await stateOf(db, scene);

      expect(codeOf(await applyWithReason(db, actor(), scene.recipient, 'dropped', BOUNCED))).toBe(
        'NEWSLETTER_FORBIDDEN',
      );
      expect(await stateOf(db, scene)).toEqual(before);
    });
  });

  it('refuses an event that SendGrid does not send, with or without a reason', async () => {
    await inOwnerTx(async (db) => {
      const scene = await sceneIn(db);

      expect(codeOf(await applyWithReason(db, SYSTEM, scene.recipient, 'open', BOUNCED))).toBe(
        'NEWSLETTER_EVENT_INVALID',
      );
      expect(codeOf(await applyWithReason(db, SYSTEM, scene.recipient, null, SPAM))).toBe(
        'NEWSLETTER_EVENT_INVALID',
      );
    });
  });
});
