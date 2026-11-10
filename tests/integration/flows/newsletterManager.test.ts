import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn, refreshWith, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// Who may run the newsletters, each step with what its actor sees. Root makes a person an admin and
// finds them in the list of admins with no right to run the newsletters; the person logs in and the
// page of the profile tells the same. Root gives the right, and the admin, in the session already
// open, sees it in the profile with no new login; root takes it away and the profile says so at once.
// Root gives it once more and then takes the role of admin away: the right goes with the role, and
// when root makes the person an admin again it does not come back. Root reads each change in the
// admin log. The refusals (a user, an admin, the same value twice, a deleted admin) are the tests of
// the route (api/root/newsletterManager).
let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let person: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Newsletter Root' });
  person = await createUser({ name: 'Olena Newsletter' });
});

afterAll(async () => {
  try {
    await closeSessions([root.id, person.id]);
  } finally {
    await stopApp();
  }
});

const get = (session: Session, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: sessionCookie(session) } });
const send = (
  session: Session,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, sessionCookie(session)),
    ...(payload ? { payload } : {}),
  });

const loggedIn = async (user: TestUser): Promise<{ session: Session; profile: any }> => {
  const res = await logIn(app, csrf, { email: user.email, password: user.password });
  expect(res.statusCode).toBe(200);
  const jar = cookieJar(res);
  return {
    session: { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! },
    profile: res.json(),
  };
};

describe('who may run the newsletters', () => {
  it('root gives an admin the right and takes it away, the profile follows in an open session, and a new role does not bring it back', async () => {
    const rootSession = await signIn(app, csrf, root);

    // root finds the person in the list of users and makes them an admin
    const found = await get(rootSession, `/api/users?email=${encodeURIComponent(person.email)}`);
    expect(found.statusCode).toBe(200);
    const personId = (found.json().items as { id: number }[])[0]!.id;
    const promoted = await send(rootSession, 'POST', '/api/root/admins', { userId: personId });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });

    // the list of admins shows the person without the right
    const listedWith = async (search: string) => {
      const res = await get(rootSession, `/api/root/admins?search=${encodeURIComponent(search)}`);
      expect(res.statusCode).toBe(200);
      return (res.json().items as { id: number; canManageNewsletters: boolean }[]).find(
        (admin) => admin.id === personId,
      )!;
    };
    expect(await listedWith(person.email)).toMatchObject({ canManageNewsletters: false });

    // the person logs in: an admin with no right to run the newsletters
    const admin = await loggedIn(person);
    expect(admin.profile).toMatchObject({
      id: personId,
      role: 'ADMIN',
      canManageNewsletters: false,
    });
    const myRight = async () => {
      const me = await get(admin.session, '/api/users/me');
      expect(me.statusCode).toBe(200);
      return me.json().canManageNewsletters as boolean;
    };
    expect(await myRight()).toBe(false);

    // root gives the right; the list shows it, and the admin sees it in the session already open
    const given = await send(rootSession, 'PATCH', `/api/root/admins/${personId}`, {
      canManageNewsletters: true,
    });
    expect(given.statusCode).toBe(200);
    expect(given.json()).toMatchObject({ id: personId, role: 'ADMIN', canManageNewsletters: true });
    expect(await listedWith(person.email)).toMatchObject({ canManageNewsletters: true });
    expect(await myRight()).toBe(true);

    // root takes the right away; the admin sees it at once, the session is the same
    const taken = await send(rootSession, 'PATCH', `/api/root/admins/${personId}`, {
      canManageNewsletters: false,
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toMatchObject({ canManageNewsletters: false });
    expect(await myRight()).toBe(false);

    // root gives it again, then takes the role of admin away: the session ends and the person is a
    // user without the right
    const givenAgain = await send(rootSession, 'PATCH', `/api/root/admins/${personId}`, {
      canManageNewsletters: true,
    });
    expect(givenAgain.statusCode).toBe(200);
    expect(await myRight()).toBe(true);

    const demoted = await send(rootSession, 'DELETE', `/api/root/admins/${personId}`);
    expect(demoted.statusCode).toBe(200);
    // the session of the admin ends with the role: it cannot be renewed
    const renewed = await refreshWith(app, csrf, admin.session.refreshToken);
    expect(renewed.statusCode).toBe(401);

    const user = await loggedIn(person);
    expect(user.profile).toMatchObject({ role: 'USER', canManageNewsletters: false });

    // root makes the person an admin again: the right did not stay
    const promotedAgain = await send(rootSession, 'POST', '/api/root/admins', { userId: personId });
    expect(promotedAgain.statusCode).toBe(201);
    expect(promotedAgain.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });
    expect(await listedWith(person.email)).toMatchObject({ canManageNewsletters: false });
    const again = await loggedIn(person);
    expect(again.profile).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });
    const meAgain = await get(again.session, '/api/users/me');
    expect(meAgain.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });

    // root reads what was done in the admin log, the oldest first
    const log = await get(
      rootSession,
      `/api/admin/audit-log?entityType=user&entityId=${personId}&actions=NEWSLETTER_MANAGER_CHANGE&sortBy=id&sortOrder=asc`,
    );
    expect(log.statusCode).toBe(200);
    const lines = log.json().items as {
      event: string;
      action: string;
      actorId: number;
      changes: { field: string; old: unknown; new: unknown }[];
    }[];
    expect(lines.map((line) => line.event)).toEqual([
      'newsletter.manager_granted',
      'newsletter.manager_revoked',
      'newsletter.manager_granted',
    ]);
    expect(lines.every((line) => line.actorId === root.id)).toBe(true);
    expect(lines[0]!.changes).toEqual([{ field: 'canManageNewsletters', old: false, new: true }]);
    expect(lines[1]!.changes).toEqual([{ field: 'canManageNewsletters', old: true, new: false }]);
  });
});
