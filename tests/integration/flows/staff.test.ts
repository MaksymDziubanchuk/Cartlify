import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// The staff of the shop, each step with what its actor sees: root finds a buyer in the list of
// users and makes them an admin, the person logs in again and works as an admin, closes the session
// of another device, changes the password and logs out; root takes the role away and the person is
// a buyer again; root closes its own sessions. The refusals of each step (an old session after the
// change of the role, a wrong password, a closed session) are the tests of the routes.
let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let person: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  person = await createUser({ name: 'Olena Staff' });
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
  method: 'POST' | 'DELETE',
  url: string,
  payload: Record<string, unknown> = {},
) => app.inject({ method, url, headers: withCsrf(csrf, sessionCookie(session)), payload });

const loggedIn = async (email: string, password: string, userAgent: string): Promise<Session> => {
  const res = await logIn(app, csrf, { email, password }, { userAgent });
  expect(res.statusCode).toBe(200);
  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
};

describe('the staff of the shop', () => {
  it('root makes a buyer an admin, who works, keeps the sessions, changes the password, logs out and is a buyer again', async () => {
    const rootSession = await signIn(app, csrf, root);

    // root finds the person by the email in the list of users
    const found = await get(rootSession, `/api/users?email=${encodeURIComponent(person.email)}`);
    expect(found.statusCode).toBe(200);
    const listed = found.json().items as { id: number; email: string; role: string }[];
    expect(listed.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: person.email, role: 'USER' },
    ]);
    const personId = listed[0]!.id;

    const profile = await get(rootSession, `/api/users/${personId}`);
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ email: person.email, role: 'USER' });

    const promoted = await send(rootSession, 'POST', '/api/root/admins', { userId: personId });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({ id: personId, role: 'ADMIN' });

    const admins = await get(
      rootSession,
      `/api/root/admins?search=${encodeURIComponent(person.email)}`,
    );
    expect(admins.statusCode).toBe(200);
    expect((admins.json().items as { id: number }[]).map(({ id }) => id)).toEqual([personId]);

    // the person logs in again on two devices and is an admin now
    const laptop = await loggedIn(person.email, person.password, 'flow-staff-laptop');
    await loggedIn(person.email, person.password, 'flow-staff-phone');
    const me = await get(laptop, '/api/users/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('ADMIN');
    expect((await get(laptop, '/api/admin/stats')).statusCode).toBe(200);

    // the admin sees both sessions and closes the one of the phone
    const sessions = await get(laptop, '/api/auth/sessions');
    expect(sessions.statusCode).toBe(200);
    const items = sessions.json().items as { id: string; device: string; current: boolean }[];
    expect(
      items
        .map(({ device, current }) => ({ device, current }))
        .sort((a, b) => a.device.localeCompare(b.device)),
    ).toEqual([
      { device: 'flow-staff-laptop', current: true },
      { device: 'flow-staff-phone', current: false },
    ]);
    const phoneSession = items.find(({ current }) => !current)!;
    expect((await send(laptop, 'DELETE', `/api/auth/sessions/${phoneSession.id}`)).statusCode).toBe(
      204,
    );
    const left = await get(laptop, '/api/auth/sessions');
    expect((left.json().items as { device: string }[]).map(({ device }) => device)).toEqual([
      'flow-staff-laptop',
    ]);

    // a new password, the next login takes it; then the admin logs out
    const newPassword = 'flow-staff-new-password-1';
    const changed = await send(laptop, 'POST', '/api/auth/password/change', {
      currentPassword: person.password,
      newPassword,
    });
    expect(changed.statusCode).toBe(204);
    const office = await loggedIn(person.email, newPassword, 'flow-staff-office');
    expect((await send(office, 'POST', '/api/auth/logout', { allDevices: true })).statusCode).toBe(
      204,
    );

    // root takes the role away: the next login is a buyer's
    const demoted = await send(rootSession, 'DELETE', `/api/root/admins/${personId}`);
    expect(demoted.statusCode).toBe(200);
    const again = await loggedIn(person.email, newPassword, 'flow-staff-home');
    expect((await get(again, '/api/users/me')).json().role).toBe('USER');
    const noAdmins = await get(
      rootSession,
      `/api/root/admins?search=${encodeURIComponent(person.email)}`,
    );
    expect(noAdmins.json().items).toEqual([]);

    // root keeps its own sessions the same way and logs out of every device
    await loggedIn(root.email, root.password, 'flow-staff-root-phone');
    const rootSessions = await get(rootSession, '/api/auth/sessions');
    expect(rootSessions.statusCode).toBe(200);
    expect(rootSessions.json().items).toHaveLength(2);
    const rootPassword = 'flow-staff-root-password-1';
    expect(
      (
        await send(rootSession, 'POST', '/api/auth/password/change', {
          currentPassword: root.password,
          newPassword: rootPassword,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await send(rootSession, 'POST', '/api/auth/logout', { allDevices: true })).statusCode,
    ).toBe(204);
  });
});
