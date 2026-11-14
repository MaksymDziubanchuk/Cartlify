import { expect } from '@jest/globals';
import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import type { TestUser } from './factories.js';

// What the tests of the alerts of an admin (GET /api/admin/alerts) do with them: read the alert of
// a kind, the list it names narrowed to the rows of the test, put a case aside or take it back, and
// see that the count of the alert is the total of its list. The alerts of the shop are shared by
// every file that runs at the same time, so a test looks at its own cases: the list narrowed to the
// buyer or the order of the test, and the cases the actor can put aside, which the server lets only
// for a case the alert counts now. The token is signed at each request: a test that runs the clock
// forward gets one of that time

export type AlertList = { path: string; query: Record<string, string> };

export type Alert = {
  kind: string;
  subscribed: boolean;
  count: number;
  dismissed: number;
  threshold: number | null;
  list: AlertList | null;
};

export type ListPage = { items: Array<Record<string, unknown> & { id: number }>; total: number };

export function alertsOf(deps: { app: () => FastifyInstance; csrf: () => Csrf }) {
  const get = (actor: TestUser, url: string) =>
    deps.app().inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

  const change = (actor: TestUser, method: 'PUT' | 'DELETE', url: string, payload?: object) =>
    deps.app().inject({
      method,
      url,
      headers: withCsrf(deps.csrf(), accessCookie(actor)),
      ...(payload ? { payload } : {}),
    });

  const alerts = async (actor: TestUser) => {
    const res = await get(actor, '/api/admin/alerts');
    expect(res.statusCode).toBe(200);
    return res.json().alerts as Alert[];
  };

  // the alert of one kind, counted alone (the alerts of root are many, each read counts them all)
  const alertOf = async (actor: TestUser, kind: string) => {
    const res = await get(actor, `/api/admin/alerts?kinds=${kind}`);
    expect(res.statusCode).toBe(200);
    const found = (res.json().alerts as Alert[]).find((alert) => alert.kind === kind);
    if (!found) throw new Error(`the actor has no alert ${kind}`);
    return found;
  };

  // the list the alert of a kind names, narrowed to the rows of the test
  const listOf = async (
    actor: TestUser,
    kind: string,
    narrow: Record<string, string | number>,
  ): Promise<ListPage> => {
    const { list } = await alertOf(actor, kind);
    const query = new URLSearchParams({
      ...list!.query,
      limit: '100',
      ...Object.fromEntries(Object.entries(narrow).map(([key, value]) => [key, String(value)])),
    });
    const res = await get(actor, `${list!.path}?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json() as ListPage;
  };

  const idsOf = async (actor: TestUser, kind: string, narrow: Record<string, string | number>) =>
    (await listOf(actor, kind, narrow)).items.map((row) => row.id).sort((a, b) => a - b);

  const dismiss = (actor: TestUser, kind: string, id: number | string, on = true) =>
    change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/dismissals/${kind}/${id}`);

  const setThreshold = (actor: TestUser, kind: string, value: unknown) =>
    change(actor, 'PUT', `/api/admin/alerts/subscriptions/${kind}/threshold`, { value });

  const subscriptionOf = async (actor: TestUser, kind: string) => {
    const res = await get(actor, '/api/admin/alerts/subscriptions');
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ kind: string; threshold: unknown }>).find(
      (item) => item.kind === kind,
    );
  };

  // the alert counts the case now: the server lets the actor put it aside, and names it aside
  async function expectCounted(actor: TestUser, kind: string, id: number) {
    const res = await dismiss(actor, kind, id);
    expect(res.statusCode).toBe(200);
    expect((await alertOf(actor, kind)).dismissed).toBe(1);
    expect((await dismiss(actor, kind, id, false)).statusCode).toBe(200);
  }

  async function expectNotCounted(actor: TestUser, kind: string, id: number) {
    const res = await dismiss(actor, kind, id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
  }

  // the count of the alert is the total of its list with its own query, whatever other files add
  // meanwhile: the two are read again, up to ten times, until the count read before the list, the
  // total of the list and the count read after it are one number
  async function expectCountIsTotalOfList(actor: TestUser, kind: string) {
    let last = { before: -1, total: -2, after: -3 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const before = await alertOf(actor, kind);
      const res = await get(
        actor,
        `${before.list!.path}?${new URLSearchParams({ ...before.list!.query, limit: '1' })}`,
      );
      expect(res.statusCode).toBe(200);
      const after = await alertOf(actor, kind);
      last = { before: before.count, total: res.json().total, after: after.count };
      if (last.before === last.total && last.after === last.total) return;
    }
    expect(last.before).toBe(last.total);
    expect(last.after).toBe(last.total);
  }

  // the cases a kind counts among the rows of the test, found in the list it names (narrowed) and
  // by the alert itself (put aside), and the ids that are no case
  async function expectListed(
    actor: TestUser,
    kind: string,
    narrow: Record<string, string | number>,
    counted: number[],
    notCounted: number[] = [],
  ) {
    const page = await listOf(actor, kind, narrow);
    expect(page.items.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [...counted].sort((a, b) => a - b),
    );
    expect(page.total).toBe(counted.length);
    for (const id of counted) await expectCounted(actor, kind, id);
    for (const id of notCounted) await expectNotCounted(actor, kind, id);
  }

  // the same, and the count of the alert as the total of its list. Each read of the alerts counts
  // every kind of the actor: a test checks the count once a kind, where its cases settle
  async function expectCases(
    actor: TestUser,
    kind: string,
    narrow: Record<string, string | number>,
    counted: number[],
    notCounted: number[] = [],
  ) {
    await expectListed(actor, kind, narrow, counted, notCounted);
    await expectCountIsTotalOfList(actor, kind);
  }

  return {
    get,
    change,
    alerts,
    alertOf,
    listOf,
    idsOf,
    dismiss,
    setThreshold,
    subscriptionOf,
    expectCounted,
    expectNotCounted,
    expectCountIsTotalOfList,
    expectListed,
    expectCases,
  };
}
