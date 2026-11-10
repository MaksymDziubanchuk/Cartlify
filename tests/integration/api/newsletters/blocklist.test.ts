import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { emailHmacOf } from '@helpers/newsletterTokens.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';
import { watchNewsletterMail } from '../../../helpers/mail.js';
import {
  REQUEST_ANSWER,
  SUBSCRIPTIONS,
  arrange,
  blockAddress,
  forget,
  isBlocked,
  newsletterApi,
  publicAnswer,
  rowsOf,
} from '../../../helpers/newsletterApi.js';
import {
  auditLinesOf,
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { withCaptcha } from '../../../helpers/turnstile.js';

// The blocklist of the public form for the people who run the newsletters: GET /api/newsletters/blocklist
// finds an address, POST adds it, DELETE /api/newsletters/blocklist/:blockId takes an entry off. The
// list holds HMACs of addresses and no address: an admin finds an entry by typing the address, and sees
// the entry without the HMAC. The server makes the HMAC of the address trimmed and in lower case, the way
// the form does, so one address is one entry whatever its case and spaces. What the block does to a
// request of the form is the test of the form (subscribe) and of the database

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
let staff: NewsletterStaff;
const emails: string[] = [];
const userIds: number[] = [];

const BLOCKLIST = '/api/newsletters/blocklist';
const tag = randomBytes(5).toString('hex');
let counter = 0;

const fresh = () => {
  const email = `${tag}-${++counter}@example.com`;
  emails.push(email);
  return email;
};

type Entry = {
  id: number;
  createdAt: string;
  blockedById: number | null;
  byPerson: boolean;
  reason: string | null;
};

const lookup = (email: string, cookie = accessCookie(staff.manager)) =>
  app.inject({
    method: 'GET',
    url: `${BLOCKLIST}?email=${encodeURIComponent(email)}`,
    headers: { cookie },
  });

const add = (body: Record<string, unknown>, cookie = accessCookie(staff.manager)) =>
  app.inject({ method: 'POST', url: BLOCKLIST, headers: withCsrf(csrf, cookie), payload: body });

const takeOff = (id: number | string, cookie = accessCookie(staff.manager)) =>
  app.inject({
    method: 'DELETE',
    url: `${BLOCKLIST}/${id}`,
    headers: withCsrf(csrf, cookie),
  });

// the rows of the list the way the database keeps them, found by the address
const rowsOfBlock = (email: string) =>
  inOwnerTx((db) =>
    db.rows<{
      id: number;
      emailHmac: string;
      blockedById: number | null;
      byPerson: boolean;
      reason: string | null;
    }>(
      `select id, "emailHmac", "blockedById", "byPerson", reason
       from cartlify.newsletter_form_blocklist where "emailHmac" = $1`,
      emailHmacOf(email),
    ),
  );

const blockedBy = async (email: string, reason = 'asked through support') => {
  const res = await add({ email, reason });
  expect(res.statusCode).toBe(201);
  return res.json().entry as Entry;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = newsletterApi(app, csrf);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeSessions(userIds);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('GET /api/newsletters/blocklist', () => {
  it('says an address is not blocked', async () => {
    const res = await lookup(fresh());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: false, entry: null });
  });

  it('finds the entry of an address an admin blocked: when, by whom and why', async () => {
    const email = fresh();
    const entry = await blockedBy(email, 'the person asked through support');

    const res = await lookup(email);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      blocked: true,
      entry: {
        id: entry.id,
        createdAt: entry.createdAt,
        blockedById: staff.manager.id,
        byPerson: false,
        reason: 'the person asked through support',
      },
    });
    expect(entry.createdAt).toMatch(/Z$/);
  });

  it('finds the entry of an address the person blocked herself, with nobody named', async () => {
    const email = fresh();
    await blockAddress(email);

    const res = await lookup(email);

    expect(res.json()).toEqual({
      blocked: true,
      entry: {
        id: expect.any(Number),
        createdAt: expect.stringMatching(/Z$/),
        blockedById: null,
        byPerson: true,
        reason: null,
      },
    });
  });

  it.each([
    ['capital letters', (email: string) => email.toUpperCase()],
    ['spaces around', (email: string) => `   ${email}  `],
    ['both', (email: string) => `  ${email.toUpperCase()} `],
  ])('finds the same entry for the address with %s', async (_name, written) => {
    const email = fresh();
    const entry = await blockedBy(email);

    const res = await lookup(written(email));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ blocked: true, entry: { id: entry.id } });
  });

  it('shows the entry without the HMAC and answers with nothing but the verdict and the entry', async () => {
    const email = fresh();
    await blockedBy(email);

    const res = await lookup(email);
    const body = res.json() as { blocked: boolean; entry: Entry };

    expect(Object.keys(body).sort()).toEqual(['blocked', 'entry']);
    expect(Object.keys(body.entry).sort()).toEqual([
      'blockedById',
      'byPerson',
      'createdAt',
      'id',
      'reason',
    ]);
    expect(res.body).not.toContain(emailHmacOf(email));
    expect(res.body).not.toContain('emailHmac');
    expect(res.body).not.toContain(email);
  });

  it('does not find another address', async () => {
    await blockedBy(fresh());

    const res = await lookup(fresh());

    expect(res.json()).toEqual({ blocked: false, entry: null });
  });

  it.each([
    ['no @', 'not-an-address'],
    ['no domain', 'name@'],
    ['no dot in the domain', 'name@localhost'],
    ['spaces only', '    '],
    ['an address of two', 'a@b.com, c@d.com'],
    ['a long local part', `${'a'.repeat(260)}@example.com`],
  ])('refuses %s as no address', async (_name, email) => {
    const res = await lookup(email);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_EMAIL' });
  });

  it('refuses a request without the address or with an empty one', async () => {
    for (const url of [BLOCKLIST, `${BLOCKLIST}?email=`, `${BLOCKLIST}?email=${'a'.repeat(400)}`]) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: accessCookie(staff.manager) },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

describe('POST /api/newsletters/blocklist', () => {
  it('blocks an address: 201 with the entry, kept as the HMAC of the address and the admin', async () => {
    const email = fresh();

    const res = await add({ email, reason: 'asked through support' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      created: true,
      entry: {
        id: expect.any(Number),
        createdAt: expect.stringMatching(/Z$/),
        blockedById: staff.manager.id,
        byPerson: false,
        reason: 'asked through support',
      },
    });

    const rows = await rowsOfBlock(email);
    expect(rows).toEqual([
      {
        id: res.json().entry.id,
        emailHmac: emailHmacOf(email),
        blockedById: staff.manager.id,
        byPerson: false,
        reason: 'asked through support',
      },
    ]);
    expect(res.body).not.toContain(emailHmacOf(email));
  });

  it('writes a line of the admin log with the admin and the entry, and no address', async () => {
    const email = fresh();

    const entry = (await add({ email, reason: 'asked through support' })).json().entry as Entry;

    const lines = await auditLinesOf('newsletter_block', entry.id);
    expect(lines).toEqual([
      {
        actorId: staff.manager.id,
        actorRole: 'ADMIN',
        entityType: 'newsletter_block',
        entityId: entry.id,
        action: 'NEWSLETTER_BLOCK_CHANGE',
        event: 'newsletter.block_added',
        meta: [
          { field: 'blocked', old: false, new: true },
          { field: 'reason', old: null, new: 'asked through support' },
        ],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(tag);
    expect(JSON.stringify(lines)).not.toContain(emailHmacOf(email));
  });

  it('names root as the one who blocked when root does it', async () => {
    const email = fresh();

    const res = await add({ email }, accessCookie(staff.root));

    expect(res.statusCode).toBe(201);
    expect(res.json().entry).toMatchObject({ blockedById: staff.root.id, byPerson: false });
    const lines = await auditLinesOf('newsletter_block', res.json().entry.id);
    expect(lines).toMatchObject([{ actorId: staff.root.id, actorRole: 'ROOT' }]);
  });

  it('writes no reason into the line when none is given', async () => {
    const entry = (await add({ email: fresh() })).json().entry as Entry;

    expect(entry.reason).toBeNull();
    expect(await auditLinesOf('newsletter_block', entry.id)).toMatchObject([
      { meta: [{ field: 'blocked', old: false, new: true }] },
    ]);
  });

  describe('the same address again', () => {
    it.each([
      ['the same text', (email: string) => email],
      ['capital letters', (email: string) => email.toUpperCase()],
      ['spaces around', (email: string) => `  ${email} `],
    ])(
      'answers 200 with the first entry for %s, and keeps the first reason',
      async (_name, written) => {
        const email = fresh();
        const first = await blockedBy(email, 'the first reason');

        const again = await add({ email: written(email), reason: 'another reason' });

        expect(again.statusCode).toBe(200);
        expect(again.json()).toEqual({ created: false, entry: first });
        expect(await rowsOfBlock(email)).toHaveLength(1);
      },
    );

    it('makes one entry and writes one line when two admins block the address together', async () => {
      const email = fresh();

      const answers = await Promise.all([
        add({ email }),
        add({ email: email.toUpperCase() }, accessCookie(staff.root)),
      ]);

      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 201]);
      const [first, second] = answers.map((res) => res.json().entry as Entry);
      expect(second!.id).toBe(first!.id);
      expect(await rowsOfBlock(email)).toHaveLength(1);
      expect(await auditLinesOf('newsletter_block', first!.id)).toHaveLength(1);
    });

    it('writes no second line of the log: nothing changed', async () => {
      const email = fresh();
      const first = await blockedBy(email);
      await add({ email: email.toUpperCase() });
      await add({ email: ` ${email}` }, accessCookie(staff.root));

      expect(await auditLinesOf('newsletter_block', first.id)).toHaveLength(1);
    });
  });

  describe('the reason', () => {
    it.each([
      ['left out', undefined, null],
      ['empty', '', null],
      ['spaces only', '   ', null],
      ['with spaces around', '  asked  ', 'asked'],
      ['of exactly 200 characters', 'x'.repeat(200), 'x'.repeat(200)],
    ])('is kept as given when %s', async (_name, sent, kept) => {
      const res = await add({ email: fresh(), ...(sent === undefined ? {} : { reason: sent }) });

      expect(res.statusCode).toBe(201);
      expect(res.json().entry.reason).toBe(kept);
    });

    it('is cut to the 200 characters the list keeps, without a space left at the cut', async () => {
      const long = `${'x'.repeat(199)} ${'y'.repeat(50)}`;

      const res = await add({ email: fresh(), reason: long });

      expect(res.statusCode).toBe(201);
      expect(res.json().entry.reason).toBe('x'.repeat(199));
    });

    it('is refused when it is far past what the list could keep', async () => {
      const res = await add({ email: fresh(), reason: 'x'.repeat(1001) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });
  });

  describe('a request that is wrong', () => {
    it.each([
      ['no address', {}, 'VALIDATION_ERROR'],
      ['an empty address', { email: '' }, 'VALIDATION_ERROR'],
      ['an address that is none', { email: 'not-an-address' }, 'INVALID_EMAIL'],
      ['spaces for an address', { email: '   ' }, 'INVALID_EMAIL'],
      ['a number for an address', { email: 5 }, 'INVALID_EMAIL'],
    ])('is refused for %s, and blocks nothing', async (_name, body, code) => {
      const res = await add(body);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: code });
    });
  });

  describe('what the block does to the requests of that address', () => {
    it('removes the request that waits for its confirmation, and keeps a subscription in force', async () => {
      const waiting = await arrange({ email: fresh(), status: 'pending' });
      const inForce = await arrange({ email: fresh(), status: 'active', locale: 'uk' });
      const ofAccount = await arrange({
        email: fresh(),
        source: 'account',
        status: 'active',
        userId: (await createUser()).id,
      });

      for (const row of [waiting, inForce, ofAccount]) {
        expect((await add({ email: row.email })).statusCode).toBe(201);
      }

      expect(await rowsOf(waiting.email)).toEqual([]);
      expect(await rowsOf(inForce.email)).toMatchObject([{ status: 'active' }]);
      expect(await rowsOf(ofAccount.email)).toMatchObject([{ status: 'active' }]);
    });

    it('removes the waiting request also when the address was blocked already', async () => {
      const email = fresh();
      await blockedBy(email);
      const waiting = await arrange({ email, status: 'pending' });
      expect(await rowsOf(waiting.email)).toHaveLength(1);

      const again = await add({ email });

      expect(again.statusCode).toBe(200);
      expect(await rowsOf(email)).toEqual([]);
    });

    it('is the block the form honors: the address written another way gets the usual answer and no mail', async () => {
      const email = fresh();
      const free = fresh();
      const freeAnswer = publicAnswer(
        await api.post(SUBSCRIPTIONS, withCaptcha({ email: free, locale: 'uk' })),
      );
      await blockedBy(email);
      const mails = watchNewsletterMail();

      const blocked = await api.post(
        SUBSCRIPTIONS,
        withCaptcha({ email: email.toUpperCase(), locale: 'uk' }),
      );

      expect(blocked.statusCode).toBe(202);
      expect(blocked.json()).toEqual(REQUEST_ANSWER);
      expect(publicAnswer(blocked).body).toBe(freeAnswer.body);
      expect(mails).toEqual([]);
      expect(await rowsOf(email)).toEqual([]);
    });

    // A person who is blocked must stay blocked when the address is typed another way: the key of the
    // list is the mailbox (no +tag; for Gmail no dots and googlemail.com is gmail.com)
    describe('the same mailbox written another way', () => {
      const requestAs = async (email: string) => {
        const mails = watchNewsletterMail();
        const res = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));
        return { res, mails };
      };

      it.each([
        [
          'a +tag',
          (name: string) => `${name}+news@example.com`,
          (name: string) => `${name}@example.com`,
        ],
        [
          'another +tag',
          (name: string) => `${name}+1+2@Example.com`,
          (name: string) => `${name}+x@example.com`,
        ],
      ])(
        'blocks the address with %s, whichever of the two was blocked',
        async (_what, one, other) => {
          const name = `${tag}v${++counter}`;
          emails.push(one(name).toLowerCase(), other(name).toLowerCase());
          await blockedBy(one(name));

          const { res, mails } = await requestAs(other(name));

          expect(res.statusCode).toBe(202);
          expect(res.json()).toEqual(REQUEST_ANSWER);
          expect(mails).toEqual([]);
          expect(await rowsOf(other(name).toLowerCase())).toEqual([]);
        },
      );

      it('finds the entry of the mailbox by any of its spellings', async () => {
        const name = `${tag}f${++counter}`;
        emails.push(`${name}@example.com`);
        const entry = await blockedBy(`${name}@example.com`);

        for (const spelling of [`${name}+deal@example.com`, `${name.toUpperCase()}@EXAMPLE.com`]) {
          const res = await lookup(spelling);

          expect(res.json()).toMatchObject({ blocked: true, entry: { id: entry.id } });
        }
      });

      it('makes one entry for the mailbox however it is written', async () => {
        const name = `${tag}o${++counter}`;
        emails.push(`${name}@example.com`);
        const first = await add({ email: `${name}@example.com` });
        const second = await add({ email: `${name}+again@example.com` });

        expect(first.statusCode).toBe(201);
        expect(second.statusCode).toBe(200);
        expect(second.json().entry.id).toBe(first.json().entry.id);
      });

      it('takes the dots out of the name and googlemail.com for gmail.com, and only there', async () => {
        const name = `${tag}g${++counter}`;
        const dotted = name.split('').join('.');
        emails.push(`${name}@gmail.com`, `${dotted}@googlemail.com`, `${dotted}@example.com`);
        await blockedBy(`${name}@gmail.com`);

        const viaGoogleMail = await requestAs(`${dotted}+x@googlemail.com`);

        expect(viaGoogleMail.res.statusCode).toBe(202);
        expect(viaGoogleMail.mails).toEqual([]);
        expect(await rowsOf(`${dotted}+x@googlemail.com`)).toEqual([]);

        // dots are the name of the mailbox on a domain that is not Gmail: it is not blocked
        const viaOther = await requestAs(`${dotted}@example.com`);

        expect(viaOther.res.statusCode).toBe(202);
        expect(viaOther.mails).toHaveLength(1);
        expect(await rowsOf(`${dotted}@example.com`)).toHaveLength(1);
      });

      it('does not make another mailbox the same: a different name stays free', async () => {
        const name = `${tag}d${++counter}`;
        emails.push(`${name}@example.com`, `${name}x+tag@example.com`);
        await blockedBy(`${name}@example.com`);

        const { res, mails } = await requestAs(`${name}x+tag@example.com`);

        expect(res.statusCode).toBe(202);
        expect(mails).toHaveLength(1);
        expect(await rowsOf(`${name}x+tag@example.com`)).toHaveLength(1);
      });

      it('removes the request that waits at any spelling of the mailbox when it is blocked', async () => {
        const name = `${tag}w${++counter}`;
        const waiting = await arrange({ email: `${name}+1@example.com`, status: 'pending' });
        emails.push(waiting.email);
        expect(await rowsOf(waiting.email)).toHaveLength(1);

        expect((await add({ email: `${name}@example.com` })).statusCode).toBe(201);

        expect(await rowsOf(waiting.email)).toEqual([]);
      });

      it('keeps the subscription as it was typed: the address is stored in lower case, the +tag and the dots in it', async () => {
        const name = `${tag}k${++counter}`;
        const typed = `${name.toUpperCase()}+News@Example.com`;
        emails.push(typed.toLowerCase());

        const { res } = await requestAs(typed);

        expect(res.statusCode).toBe(202);
        const [row] = await rowsOf(typed.toLowerCase());
        expect(row).toMatchObject({ email: typed.toLowerCase(), status: 'pending' });
        expect(row!.emailHmac).toBe(emailHmacOf(`${name}@example.com`));
      });
    });

    it('does not stop the owner of the address from subscribing from the account', async () => {
      const email = fresh();
      const owner = await createUser({ email, locale: 'uk' });
      userIds.push(owner.id);
      await blockedBy(email);

      const res = await api.post(SUBSCRIPTIONS, {}, { cookie: accessCookie(owner) });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ subscribed: true, source: 'account', status: 'active' });
      expect(await isBlocked(email)).toBe(true);
    });
  });
});

describe('DELETE /api/newsletters/blocklist/:blockId', () => {
  it('takes the entry off: 200, and the address is not blocked any more', async () => {
    const email = fresh();
    const entry = await blockedBy(email);

    const res = await takeOff(entry.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
    expect(await rowsOfBlock(email)).toEqual([]);
    expect((await lookup(email)).json()).toEqual({ blocked: false, entry: null });
  });

  it('writes a line of the admin log with the admin and the entry, and no address', async () => {
    const email = fresh();
    const entry = await blockedBy(email);

    await takeOff(entry.id, accessCookie(staff.root));

    const lines = await auditLinesOf('newsletter_block', entry.id);
    expect(lines.map((line) => line.event)).toEqual([
      'newsletter.block_added',
      'newsletter.block_removed',
    ]);
    expect(lines[1]).toEqual({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_block',
      entityId: entry.id,
      action: 'NEWSLETTER_BLOCK_CHANGE',
      event: 'newsletter.block_removed',
      meta: [{ field: 'blocked', old: true, new: false }],
    });
    expect(JSON.stringify(lines)).not.toContain(tag);
    expect(JSON.stringify(lines)).not.toContain(emailHmacOf(email));
  });

  it('takes off an entry the person made herself', async () => {
    const email = fresh();
    await blockAddress(email);
    const { entry } = (await lookup(email)).json() as { entry: Entry };

    const res = await takeOff(entry.id);

    expect(res.statusCode).toBe(200);
    expect(await isBlocked(email)).toBe(false);
  });

  it('leaves the other entries and the subscriptions as they are', async () => {
    const kept = fresh();
    await blockedBy(kept);
    const email = fresh();
    const entry = await blockedBy(email);
    const subscription = await arrange({ email: fresh(), status: 'active' });

    expect((await takeOff(entry.id)).statusCode).toBe(200);

    expect(await isBlocked(kept)).toBe(true);
    expect(await rowsOf(subscription.email)).toHaveLength(1);
  });

  it('answers 404 for an entry that is not there, the second time too, and writes no line', async () => {
    const entry = await blockedBy(fresh());
    expect((await takeOff(entry.id)).statusCode).toBe(200);

    const again = await takeOff(entry.id);
    const unknown = await takeOff(2_147_483_000);

    for (const res of [again, unknown]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_BLOCK_NOT_FOUND' });
    }
    expect(await auditLinesOf('newsletter_block', entry.id)).toHaveLength(2);
    expect(await auditLinesOf('newsletter_block', 2_147_483_000)).toEqual([]);
  });

  it('writes one line when two admins take the entry off together: the other finds nothing', async () => {
    const entry = await blockedBy(fresh());

    const answers = await Promise.all([
      takeOff(entry.id),
      takeOff(entry.id, accessCookie(staff.root)),
    ]);

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 404]);
    expect((await auditLinesOf('newsletter_block', entry.id)).map((line) => line.event)).toEqual([
      'newsletter.block_added',
      'newsletter.block_removed',
    ]);
  });

  it.each(['abc', '0', '-1', '01', '1.5'])('refuses the id %s', async (id) => {
    const res = await takeOff(id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses an id past the numbers the database keeps', async () => {
    const res = await takeOff('2147483648');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
  });

  it('is not for an admin without the right: the entry stays', async () => {
    const email = fresh();
    const entry = await blockedBy(email);

    const res = await takeOff(entry.id, accessCookie(staff.plainAdmin));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
    expect(await isBlocked(email)).toBe(true);
  });
});

describe('who may block', () => {
  it('does not let an admin without the right add an entry', async () => {
    const email = fresh();

    const res = await add({ email }, accessCookie(staff.plainAdmin));

    expect(res.statusCode).toBe(403);
    expect(await isBlocked(email)).toBe(false);
  });

  it('does not let an admin without the right look an address up', async () => {
    const email = fresh();
    await blockedBy(email);

    const res = await lookup(email, accessCookie(staff.plainAdmin));

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('"blocked"');
  });
});
