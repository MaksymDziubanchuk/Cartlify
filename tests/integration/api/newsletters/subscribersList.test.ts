import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { createUser } from '../../../helpers/factories.js';
import { arrange, forget, rowsOf, type Arranged } from '../../../helpers/newsletterApi.js';
import type { SubscriptionOpts } from '../../../helpers/newsletterDb.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// The list of subscribers for the people who run the newsletters, GET /api/newsletters/subscribers:
// every state, with the filters, the search by a part of the address, the cursor, and fields chosen
// one by one (no hash, no salt, no token of a subscription is ever in an answer). The tests find their
// own rows by a tag in the address, the table holds the rows of the other files too

let app: FastifyInstance;
let staff: NewsletterStaff;
const emails: string[] = [];

// a tag no other row of the table has, in lower case as the addresses are kept
const newTag = () => randomBytes(5).toString('hex');

const LIST = '/api/newsletters/subscribers';

type Item = {
  id: number;
  email: string;
  source: string;
  locale: string | null;
  status: string;
  userId: number | null;
  createdAt: string;
  confirmedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
};

type Page = { items: Item[]; limit: number; nextCursor: string | null; total: number };

const list = (query: Record<string, string | number> = {}, cookie = accessCookie(staff.manager)) =>
  app.inject({
    method: 'GET',
    url: `${LIST}?${new URLSearchParams(
      Object.entries(query).map(([name, value]) => [name, String(value)]),
    ).toString()}`,
    headers: { cookie },
  });

const pageOf = async (query: Record<string, string | number>): Promise<Page> => {
  const res = await list(query);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
};

async function made(email: string, opts: SubscriptionOpts = {}): Promise<Arranged> {
  emails.push(email);
  return arrange({ ...opts, email });
}

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

describe('GET /api/newsletters/subscribers', () => {
  describe('the rows and the fields', () => {
    const tag = newTag();
    const at = (name: string) => `${tag}-${name}@example.com`;
    const byName = new Map<string, Arranged>();
    let accountUserId: number;

    beforeAll(async () => {
      const accountUser = await createUser();
      accountUserId = accountUser.id;
      const secondUser = await createUser();

      const plan: [string, SubscriptionOpts][] = [
        ['a', { source: 'form', status: 'active', locale: 'uk' }],
        ['b', { source: 'form', status: 'pending', locale: 'es' }],
        ['c', { source: 'form', status: 'paused_complaint', locale: null }],
        ['d', { source: 'form', status: 'stopped_bounce', locale: 'uk' }],
        ['e', { source: 'form', status: 'ended', locale: 'es' }],
        ['f', { source: 'account', status: 'active', locale: 'uk', userId: accountUser.id }],
        ['g', { source: 'account', status: 'active', locale: null, userId: secondUser.id }],
        ['h', { source: 'account', status: 'ended', locale: 'es', userId: accountUser.id }],
      ];

      for (const [name, opts] of plan) byName.set(name, await made(at(name), opts));
    });

    const idsOf = (names: string[]) => names.map((name) => byName.get(name)!.id);

    it('lists every state, the newest first, with the number of rows the filters find', async () => {
      const page = await pageOf({ email: tag });

      expect(page.items.map((item) => item.id)).toEqual(
        idsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).sort((x, y) => y - x),
      );
      expect(page).toMatchObject({ limit: 20, nextCursor: null, total: 8 });
    });

    it('gives the fields of a row and nothing else', async () => {
      const page = await pageOf({ email: tag });
      const item = page.items.find((row) => row.id === byName.get('f')!.id)!;
      const [row] = await rowsOf(at('f'));

      expect(Object.keys(item).sort()).toEqual([
        'confirmedAt',
        'createdAt',
        'email',
        'endReason',
        'endedAt',
        'id',
        'locale',
        'source',
        'status',
        'userId',
      ]);
      expect(item).toEqual({
        id: row!.id,
        email: at('f'),
        source: 'account',
        locale: 'uk',
        status: 'active',
        userId: accountUserId,
        createdAt: expect.stringMatching(/Z$/),
        // a subscription in force was confirmed (the arranged row says so, as the routes would)
        confirmedAt: expect.stringMatching(/Z$/),
        endedAt: null,
        endReason: null,
      });
      expect(Math.abs(Date.parse(item.createdAt) - Date.now())).toBeLessThan(120_000);
    });

    it('has no user for a subscription of the form and shows how an ended one ended', async () => {
      const page = await pageOf({ email: tag });
      const byId = new Map(page.items.map((item) => [item.id, item]));

      expect(byId.get(byName.get('a')!.id)).toMatchObject({ source: 'form', userId: null });
      expect(byId.get(byName.get('b')!.id)).toMatchObject({ status: 'pending', endedAt: null });
      expect(byId.get(byName.get('d')!.id)).toMatchObject({
        status: 'stopped_bounce',
        endReason: 'bounced',
      });
      expect(byId.get(byName.get('e')!.id)).toMatchObject({
        status: 'ended',
        endReason: 'unsubscribed',
        endedAt: expect.stringMatching(/Z$/),
      });
    });

    it('keeps every secret of a subscription out of the answer', async () => {
      const res = await list({ email: tag });
      expect(res.statusCode).toBe(200);

      const secrets: string[] = [];
      for (const name of byName.keys()) {
        const [row] = await rowsOf(at(name));
        secrets.push(row!.manageSalt, row!.manageHash);
        if (row!.confirmHash) secrets.push(row!.confirmHash);
        if (row!.emailHmac) secrets.push(row!.emailHmac);
        secrets.push(byName.get(name)!.manageToken);
      }
      expect(secrets.length).toBeGreaterThan(8);
      for (const secret of secrets) expect(res.body).not.toContain(secret);

      for (const field of ['manageSalt', 'manageHash', 'confirmHash', 'emailHmac']) {
        expect(res.body).not.toContain(`"${field}"`);
      }
    });

    it('gives root and an admin whom root allowed the same list', async () => {
      const asAdmin = await pageOf({ email: tag });
      const asRoot = await list({ email: tag }, accessCookie(staff.root));

      expect(asRoot.statusCode).toBe(200);
      expect(asRoot.json()).toEqual(asAdmin);
    });

    describe('the filters', () => {
      // each case: the query and the rows (by name) it finds
      it.each<[string, Record<string, string>, string[]]>([
        ['one state', { status: 'active' }, ['a', 'f', 'g']],
        ['several states', { status: 'pending,paused_complaint' }, ['b', 'c']],
        ['the ended', { status: 'ended' }, ['e', 'h']],
        ['the stopped by a bounce', { status: 'stopped_bounce' }, ['d']],
        ['the form', { source: 'form' }, ['a', 'b', 'c', 'd', 'e']],
        ['the accounts', { source: 'account' }, ['f', 'g', 'h']],
        ['both sources', { source: 'form,account' }, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
        ['a language', { locale: 'uk' }, ['a', 'd', 'f']],
        ['no language', { locale: 'none' }, ['c', 'g']],
        ['a language or none', { locale: 'es,none' }, ['b', 'c', 'e', 'g', 'h']],
        [
          'a state, a source and a language',
          { status: 'active', source: 'account', locale: 'uk' },
          ['f'],
        ],
        ['two states in one language', { status: 'active,ended', locale: 'es' }, ['e', 'h']],
        ['a state nobody has with a source', { status: 'pending', source: 'account' }, []],
      ])('finds %s', async (_name, query, names) => {
        const page = await pageOf({ email: tag, ...query });

        expect(page.items.map((item) => item.id)).toEqual(idsOf(names).sort((x, y) => y - x));
        expect(page.total).toBe(names.length);
        expect(page.nextCursor).toBeNull();
      });

      it.each<[string, Record<string, string | number>]>([
        ['a state that does not exist', { status: 'gone' }],
        ['one state good and one not', { status: 'active,gone' }],
        ['a state twice with a space', { status: 'active, ended' }],
        ['a source that does not exist', { source: 'import' }],
        ['a language in capitals', { locale: 'UK' }],
        ['a language of three letters', { locale: 'ukr' }],
        ['a limit of zero', { limit: 0 }],
        ['a limit over a hundred', { limit: 101 }],
        ['a limit that is no number', { limit: 'many' }],
        ['a cursor of signs the list never gives', { cursor: 'not a cursor!' }],
      ])('refuses %s', async (_name, query) => {
        const res = await list({ email: tag, ...query });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      });

      it('refuses a cursor the list did not give', async () => {
        for (const cursor of ['abc', Buffer.from('{"id":"x"}').toString('base64url')]) {
          const res = await list({ email: tag, cursor });

          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
        }
      });
    });

    describe('the pages', () => {
      it('goes through the rows by the cursor, every row once, with the same total', async () => {
        const seen: number[] = [];
        let cursor: string | null = null;
        let pages = 0;

        do {
          const page: Page = await pageOf({ email: tag, limit: 3, ...(cursor ? { cursor } : {}) });
          pages += 1;

          expect(page.limit).toBe(3);
          expect(page.total).toBe(8);
          expect(page.items.length).toBeLessThanOrEqual(3);
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
          if (cursor) expect(page.items).toHaveLength(3);
        } while (cursor);

        expect(pages).toBe(3);
        expect(seen).toEqual(idsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).sort((x, y) => y - x));
      });

      it('has no next page when the rows end exactly on the page', async () => {
        const page = await pageOf({ email: tag, limit: 8 });

        expect(page.items).toHaveLength(8);
        expect(page.nextCursor).toBeNull();
      });

      it('applies the filters to the pages that follow the cursor', async () => {
        const first = await pageOf({ email: tag, status: 'active', limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toBeTruthy();

        const second = await pageOf({
          email: tag,
          status: 'active',
          limit: 2,
          cursor: first.nextCursor!,
        });

        expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
          idsOf(['a', 'f', 'g']).sort((x, y) => y - x),
        );
        expect(second.nextCursor).toBeNull();
        expect(second.total).toBe(3);
      });

      it('takes a page of 20 rows unless told, and no more than a hundred', async () => {
        expect((await pageOf({ email: tag })).limit).toBe(20);
        expect((await pageOf({ email: tag, limit: 100 })).limit).toBe(100);
      });
    });

    describe('the list that is empty', () => {
      it('answers an empty page when no address has the part', async () => {
        const page = await pageOf({ email: `${tag}-nobody` });

        expect(page).toEqual({ items: [], limit: 20, nextCursor: null, total: 0 });
      });

      it('answers an empty page when the filters meet no row', async () => {
        const page = await pageOf({ email: tag, status: 'active', locale: 'zz' });

        expect(page).toEqual({ items: [], limit: 20, nextCursor: null, total: 0 });
      });
    });
  });

  describe('the search by the address', () => {
    const tag = newTag();
    const at = (name: string) => `${tag}${name}@example.com`;
    const ids = new Map<string, number>();

    beforeAll(async () => {
      // addresses that differ in one sign, the sign that means "any" to a pattern of like
      for (const name of ['-plain', '_under', 'xunder', '%percent', 'zzpercent', '\\slash']) {
        ids.set(name, (await made(at(name))).id);
      }
    });

    const found = async (query: string) =>
      (await pageOf({ email: query })).items.map((item) => item.id).sort((x, y) => x - y);

    it('finds a part of the address in any case', async () => {
      const wanted = [ids.get('-plain')!];

      expect(await found(`${tag}-plain`)).toEqual(wanted);
      expect(await found(`${tag.toUpperCase()}-PLAIN`)).toEqual(wanted);
      expect(await found(`${tag.slice(3)}-pla`)).toEqual(wanted);
    });

    it('cuts the spaces around the part', async () => {
      expect(await found(`   ${tag}-plain  `)).toEqual([ids.get('-plain')]);
    });

    it('reads _ as the sign itself and not as any sign', async () => {
      expect(await found(`${tag}_under`)).toEqual([ids.get('_under')]);
    });

    it('reads % as the sign itself and not as anything', async () => {
      expect(await found(`${tag}%percent`)).toEqual([ids.get('%percent')]);
    });

    it('reads a backslash as the sign itself', async () => {
      expect(await found(`${tag}\\slash`)).toEqual([ids.get('\\slash')]);
    });

    it('finds nothing for a sign that no address of the tag has', async () => {
      expect(await found(`${tag}%under`)).toEqual([]);
      expect(await found(`${tag}_percent`)).toEqual([]);
    });

    it('lists every row for an empty search, the rows of the filters only', async () => {
      const spaces = await list({ email: '   ' });

      expect(spaces.statusCode).toBe(200);
      expect((spaces.json() as Page).total).toBeGreaterThanOrEqual(ids.size);
    });
  });
});
