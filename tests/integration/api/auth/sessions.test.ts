import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { cookieJar, setCookies } from '../../../helpers/cookies.js';
import {
  accessCookie,
  logIn,
  refreshWith,
  sessionCookie,
  type Session,
} from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a login from a browser that names itself
async function signInFrom(user: TestUser, userAgent: string): Promise<Session> {
  const res = await logIn(app, csrf, { email: user.email, password: user.password }, { userAgent });
  expect(res.statusCode).toBe(200);

  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
}

const listSessions = (session: Session) =>
  app.inject({
    method: 'GET',
    url: '/api/auth/sessions',
    headers: { cookie: sessionCookie(session) },
  });

const closeSession = (session: Session, sessionId: string) =>
  app.inject({
    method: 'DELETE',
    url: `/api/auth/sessions/${sessionId}`,
    headers: withCsrf(csrf, sessionCookie(session)),
  });

const changePassword = (session: Session, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/password/change',
    headers: withCsrf(csrf, sessionCookie(session)),
    payload: body,
  });

type SessionItem = {
  id: string;
  device: string | null;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
};

const sessionsOf = async (session: Session) =>
  (await listSessions(session)).json().items as SessionItem[];

describe('GET /api/auth/sessions', () => {
  it('lists the open sessions of the user with the browser of each, the one asking marked', async () => {
    const user = await newUser();
    await signInFrom(user, PHONE);
    const laptop = await signInFrom(user, LAPTOP);

    const res = await listSessions(laptop);

    expect(res.statusCode).toBe(200);
    const items = res.json().items as SessionItem[];
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.device === LAPTOP)).toMatchObject({ current: true });
    expect(items.find((item) => item.device === PHONE)).toMatchObject({ current: false });
    expect(items[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      device: expect.any(String),
      lastUsedAt: expect.any(String),
      expiresAt: expect.any(String),
      current: expect.any(Boolean),
    });
  });

  it('keeps the id of a session when the session renews', async () => {
    const user = await newUser();
    const session = await signInFrom(user, PHONE);
    const [before] = await sessionsOf(session);

    const renewed = cookieJar(await refreshWith(app, csrf, session.refreshToken));
    const after = await sessionsOf({
      accessToken: renewed.accessToken!,
      refreshToken: renewed.refreshToken!,
    });

    expect(after).toEqual([expect.objectContaining({ id: before!.id, current: true })]);
  });

  it('leaves out the sessions that ended and the sessions of others', async () => {
    const user = await newUser();
    const other = await newUser();
    const ended = await signInFrom(user, PHONE);
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: withCsrf(csrf, sessionCookie(ended)),
      payload: {},
    });
    await signInFrom(other, PHONE);
    const session = await signInFrom(user, LAPTOP);

    expect((await sessionsOf(session)).map((item) => item.device)).toEqual([LAPTOP]);
  });

  it('refuses a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/sessions' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('DELETE /api/auth/sessions/:sessionId', () => {
  it('ends another session of the user and leaves this one alone', async () => {
    const user = await newUser();
    const phone = await signInFrom(user, PHONE);
    const laptop = await signInFrom(user, LAPTOP);
    const phoneId = (await sessionsOf(laptop)).find((item) => item.device === PHONE)!.id;

    const res = await closeSession(laptop, phoneId);

    expect(res.statusCode).toBe(204);
    const refused = await refreshWith(app, csrf, phone.refreshToken);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
    expect((await refreshWith(app, csrf, laptop.refreshToken)).statusCode).toBe(204);
  });

  it('ends this session and clears its cookies when it is the one named', async () => {
    const user = await newUser();
    const session = await signInFrom(user, PHONE);
    const [own] = await sessionsOf(session);

    const res = await closeSession(session, own!.id);

    expect(res.statusCode).toBe(204);
    expect(setCookies(res).refreshToken?.cleared).toBe(true);
    expect(setCookies(res).accessToken?.cleared).toBe(true);
    expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).toBe(401);
  });

  it('does not end a session of another user', async () => {
    const owner = await newUser();
    const ownerSession = await signInFrom(owner, PHONE);
    const [target] = await sessionsOf(ownerSession);
    const stranger = await signInFrom(await newUser(), LAPTOP);

    const res = await closeSession(stranger, target!.id);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'SESSION_NOT_FOUND' });
    expect((await refreshWith(app, csrf, ownerSession.refreshToken)).statusCode).toBe(204);
  });

  it('answers 404 for a session that already ended', async () => {
    const user = await newUser();
    await signInFrom(user, PHONE);
    const laptop = await signInFrom(user, LAPTOP);
    const phoneId = (await sessionsOf(laptop)).find((item) => item.device === PHONE)!.id;
    await closeSession(laptop, phoneId);

    const res = await closeSession(laptop, phoneId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'SESSION_NOT_FOUND' });
  });

  it('refuses a session id that is not a uuid', async () => {
    const session = await signInFrom(await newUser(), PHONE);

    const res = await closeSession(session, 'not-a-uuid');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/auth/password/change', () => {
  it('changes the password, ends the other sessions, keeps this one and tells the owner', async () => {
    const user = await newUser();
    const phone = await signInFrom(user, PHONE);
    const laptop = await signInFrom(user, LAPTOP);
    const mails = watchMail();

    const res = await changePassword(laptop, {
      currentPassword: user.password,
      newPassword: 'changed-password-1',
    });

    expect(res.statusCode).toBe(204);
    expect(
      (await logIn(app, csrf, { email: user.email, password: user.password })).statusCode,
    ).toBe(401);
    expect(
      (await logIn(app, csrf, { email: user.email, password: 'changed-password-1' })).statusCode,
    ).toBe(200);

    const refused = await refreshWith(app, csrf, phone.refreshToken);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
    expect((await refreshWith(app, csrf, laptop.refreshToken)).statusCode).toBe(204);

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [user.email], accepted: true });
    expect(mails[0]!.subject).toContain('Your password was changed');
    expect(mails[0]!.text).not.toContain('changed-password-1');
  });

  it('changes nothing when the current password is wrong', async () => {
    const user = await newUser();
    const phone = await signInFrom(user, PHONE);
    const laptop = await signInFrom(user, LAPTOP);

    const res = await changePassword(laptop, {
      currentPassword: 'not-the-password',
      newPassword: 'changed-password-2',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_INVALID' });
    expect(
      (await logIn(app, csrf, { email: user.email, password: user.password })).statusCode,
    ).toBe(200);
    expect((await refreshWith(app, csrf, phone.refreshToken)).statusCode).toBe(204);
  });

  it('refuses a new password shorter than 6 signs', async () => {
    const user = await newUser();
    const session = await signInFrom(user, PHONE);

    const res = await changePassword(session, {
      currentPassword: user.password,
      newPassword: ' 12345 ',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_TOO_SHORT' });
  });

  // an account of google, github or linkedin has no password of ours to change
  it('refuses an account that signs in through a provider', async () => {
    const user = await newUser({ authProvider: 'GOOGLE', providerSub: `google-${Date.now()}` });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { currentPassword: 'anything-1', newPassword: 'changed-password-3' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_NOT_SET' });
  });

  it('refuses a guest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: withCsrf(csrf),
      payload: { currentPassword: 'anything-1', newPassword: 'changed-password-4' },
    });

    expect(res.statusCode).toBe(403);
  });
});
