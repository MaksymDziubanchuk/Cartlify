import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import {
  accessCookie,
  logIn,
  refreshWith,
  sessionCookie,
  signIn,
} from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, cookieJar, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { answerAsGithub, callback, startLogin } from '../../../helpers/oauth.js';
import {
  codeOf,
  enrollTwoFactor,
  newTestApp,
  postTwoFactor,
  staleCodeOf,
  ticketCookieOf,
  type TestApp,
} from '../../../helpers/twoFactor.js';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
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

// an admin or root with the app set up already
async function enrolled(role: 'ADMIN' | 'ROOT' = 'ADMIN') {
  const user = await newUser({ role });
  const { app: testApp, recoveryCodes } = await enrollTwoFactor({ id: user.id, role });
  user.twoFactorApp = testApp;
  return { user, testApp, recoveryCodes };
}

const firstStep = (user: TestUser, cookie = '', userAgent?: string) =>
  logIn(
    app,
    csrf,
    { email: user.email, password: user.password },
    { cookie, ...(userAgent ? { userAgent } : {}) },
  );

const loginLines = (userId: number) => asAdmin((tx) => tx.loginLog.count({ where: { userId } }));

const auditEvents = (userId: number) =>
  asAdmin(async (tx) =>
    (
      await tx.adminAuditLog.findMany({
        where: { entityType: 'user', entityId: userId, event: { startsWith: 'two_factor.' } },
        orderBy: { id: 'asc' },
        select: { event: true, actorId: true },
      })
    ).map((line) => line.event),
  );

// the row of the second step as its own account reads it (only the account and root see it)
const rowOf = (user: TestUser) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: user.role });
    const rows = await tx.$queryRaw<{ failedCodes: number; trustedDevices: unknown[] }[]>`
      select "failedCodes", "trustedDevices" from cartlify.user_two_factor where "userId" = ${user.id}
    `;
    return rows[0];
  });

const sessionOf = (res: { headers: Record<string, unknown> }) => {
  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
};

const get = (cookie: string, url = '/api/auth/two-factor') =>
  app.inject({ method: 'GET', url, headers: { cookie } });

const signedIn = (
  method: 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url: `/api/auth/two-factor${url}`,
    headers: withCsrf(csrf, cookie),
    ...(payload ? { payload } : {}),
  });

describe('the first step of a login', () => {
  it('opens the session of a customer at once, with no ticket', async () => {
    const buyer = await newUser();
    const res = await firstStep(buyer);

    expect(res.statusCode).toBe(200);
    expect(setCookies(res).twoFactorTicket).toBeUndefined();
  });

  it('sends an admin without an app to the setup: a ticket, no session, no line of the journal', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const res = await firstStep(admin);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ twoFactor: 'setup', canTrustDevice: true });
    const cookies = setCookies(res);
    expect(cookies.twoFactorTicket!.attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
    expect(cookies.twoFactorTicket!.maxAge).toBe(600);
    expect(cookies.accessToken).toBeUndefined();
    expect(cookies.refreshToken).toBeUndefined();
    expect(await loginLines(admin.id)).toBe(0);
  });

  it('asks an admin with an app for the code, root too, who may not trust a browser', async () => {
    const { user: admin } = await enrolled('ADMIN');
    const { user: root } = await enrolled('ROOT');

    expect((await firstStep(admin)).json()).toEqual({ twoFactor: 'code', canTrustDevice: true });
    expect((await firstStep(root)).json()).toEqual({ twoFactor: 'code', canTrustDevice: false });
  });
});

describe('the setup of the app', () => {
  it('gives a secret for the email of the account, then the first code opens the session with ten recovery codes', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const first = await firstStep(admin);

    const started = await postTwoFactor(app, csrf, '/setup', ticketCookieOf(first));
    expect(started.statusCode).toBe(200);
    const { otpauthUrl, secret } = started.json();
    expect(otpauthUrl).toContain(encodeURIComponent(admin.email));
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const testApp = newTestApp(secret);

    const wrong = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(started), {
      code: staleCodeOf(testApp),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });

    const done = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(started), {
      code: codeOf(testApp),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: admin.id, role: 'ADMIN' });
    expect(done.json().recoveryCodes).toHaveLength(10);
    const cookies = setCookies(done);
    expect(cookies.accessToken!.cleared).toBe(false);
    expect(cookies.twoFactorTicket!.cleared).toBe(true);
    expect(await loginLines(admin.id)).toBe(1);
    expect(await auditEvents(admin.id)).toEqual(['two_factor.enable']);

    // the same ticket once more: the app is set up already
    const again = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(started), {
      code: codeOf(testApp),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'TWO_FACTOR_ALREADY_ENABLED' });
  });

  it('refuses without a ticket, with a broken one, and with a ticket of the code', async () => {
    const { user } = await enrolled();
    const codeTicket = ticketCookieOf(await firstStep(user));

    for (const cookie of ['', cookieHeader({ twoFactorTicket: 'not-a-ticket' }), codeTicket]) {
      const res = await postTwoFactor(app, csrf, '/setup', cookie);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
    }
  });

  it('refuses the confirmation of a ticket the setup did not start', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const res = await postTwoFactor(
      app,
      csrf,
      '/setup/confirm',
      ticketCookieOf(await firstStep(admin)),
      {
        code: '123456',
      },
    );

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
  });
});

describe('the code of a login', () => {
  const verify = async (user: TestUser, payload: Record<string, unknown>, userAgent?: string) =>
    postTwoFactor(app, csrf, '/verify', ticketCookieOf(await firstStep(user)), payload, userAgent);

  it('opens the session for a code of the app, once: the same code does not open another', async () => {
    const { user, testApp } = await enrolled();
    const code = codeOf(testApp);

    const res = await verify(user, { code });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });
    expect(setCookies(res).refreshToken!.cleared).toBe(false);
    expect(await loginLines(user.id)).toBe(1);

    const again = await verify(user, { code });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });
  });

  it('opens the session for a recovery code, mails the owner and writes the journal; the code works once', async () => {
    const { user, recoveryCodes } = await enrolled();
    const mails = watchMail();

    const res = await verify(user, { recoveryCode: recoveryCodes[0]!.toLowerCase() });
    expect(res.statusCode).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [user.email] });
    expect(mails[0]!.text).toContain('Recovery codes left: 9');
    expect(await auditEvents(user.id)).toEqual(['two_factor.recovery_login']);

    const again = await verify(user, { recoveryCode: recoveryCodes[0] });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ errorCode: 'TWO_FACTOR_RECOVERY_CODE_USED' });
    // a used code is no guess
    expect((await rowOf(user))!.failedCodes).toBe(0);
  });

  it('wants a code or a recovery code, not both', async () => {
    const { user, testApp, recoveryCodes } = await enrolled();

    for (const payload of [{}, { code: codeOf(testApp), recoveryCode: recoveryCodes[0] }]) {
      const res = await verify(user, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_PROOF_REQUIRED' });
    }
  });

  it('pauses the second step for 15 minutes after five wrong codes, the right code too', async () => {
    const { user, testApp } = await enrolled();

    for (let i = 0; i < 5; i += 1) {
      const res = await verify(user, { code: i % 2 ? staleCodeOf(testApp) : 'ABCDE-FGHJK' });
      expect(res.statusCode).toBe(401);
    }

    const paused = await verify(user, { code: codeOf(testApp) });
    expect(paused.statusCode).toBe(429);
    expect(paused.json()).toMatchObject({ errorCode: 'TWO_FACTOR_PAUSED' });
    const wait = Number(paused.headers['retry-after']);
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  });

  it('starts the count over with a right code', async () => {
    const { user, testApp } = await enrolled();

    for (let i = 0; i < 4; i += 1) await verify(user, { code: staleCodeOf(testApp) });
    expect((await verify(user, { code: codeOf(testApp) })).statusCode).toBe(200);
    expect((await rowOf(user))!.failedCodes).toBe(0);
  });

  it('refuses the ticket of a setup', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const res = await verify(admin, { code: '123456' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
  });
});

describe('a ticket the account no longer fits', () => {
  // root changes the role while the ticket of the first step is out
  const setRole = async (userId: number, role: 'USER' | 'ADMIN') => {
    const root = await newUser({ role: 'ROOT' });
    await testTx(async (tx) => {
      await setUserContext(tx, { userId: root.id, role: 'ROOT' });
      await tx.user.update({ where: { id: userId }, data: { role } });
    });
  };

  it('sets nothing up for an admin made a buyer meanwhile', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const started = await postTwoFactor(
      app,
      csrf,
      '/setup',
      ticketCookieOf(await firstStep(admin)),
    );
    await setRole(admin.id, 'USER');

    const res = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(started), {
      code: codeOf(newTestApp(started.json().secret)),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
    expect(await rowOf({ ...admin, role: 'ADMIN' })).toBeUndefined();
  });

  it('opens no session of a root made an admin meanwhile', async () => {
    const { user, testApp } = await enrolled('ROOT');
    const ticket = ticketCookieOf(await firstStep(user));
    await setRole(user.id, 'ADMIN');

    const res = await postTwoFactor(app, csrf, '/verify', ticket, { code: codeOf(testApp) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
    expect(setCookies(res).accessToken).toBeUndefined();
  });
});

describe('a trusted browser', () => {
  async function trustedLogin(user: TestUser, testApp: TestApp) {
    const res = await postTwoFactor(
      app,
      csrf,
      '/verify',
      ticketCookieOf(await firstStep(user, '', CHROME)),
      { code: codeOf(testApp), trustDevice: true },
      CHROME,
    );
    expect(res.statusCode).toBe(200);
    return { res, device: setCookies(res).trustedDevice };
  }

  it('lets an admin in without a code for 30 days, and shows in the list as this browser', async () => {
    const { user, testApp } = await enrolled();
    const { device } = await trustedLogin(user, testApp);

    expect(device!.maxAge).toBe(30 * 24 * 60 * 60);
    expect(device!.attributes).toEqual(expect.arrayContaining(['HttpOnly']));

    const deviceCookie = cookieHeader({ trustedDevice: device!.value });
    const res = await firstStep(user, deviceCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });

    const status = await get(`${sessionCookie(sessionOf(res))}; ${deviceCookie}`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ recoveryCodesLeft: 10 });
    expect(status.json().devices).toEqual([
      expect.objectContaining({ label: 'Chrome, Windows', current: true }),
    ]);
  });

  it('is never kept for root', async () => {
    const { user, testApp } = await enrolled('ROOT');
    const { device } = await trustedLogin(user, testApp);

    expect(device).toBeUndefined();
    expect((await rowOf(user))!.trustedDevices).toEqual([]);
  });

  it('asks for the code again once the admin forgets it, and its cookie goes', async () => {
    const { user, testApp } = await enrolled();
    const { res, device } = await trustedLogin(user, testApp);
    const deviceCookie = cookieHeader({ trustedDevice: device!.value });
    const cookie = `${sessionCookie(sessionOf(res))}; ${deviceCookie}`;
    const [{ id }] = (await get(cookie)).json().devices;

    const forgot = await signedIn('DELETE', `/devices/${id}`, cookie);
    expect(forgot.statusCode).toBe(204);
    expect(setCookies(forgot).trustedDevice!.cleared).toBe(true);
    expect(await auditEvents(user.id)).toEqual(['two_factor.device_forget']);

    expect((await firstStep(user, deviceCookie)).statusCode).toBe(202);
    const missing = await signedIn('DELETE', `/devices/${id}`, cookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'TRUSTED_DEVICE_NOT_FOUND' });
  });

  it('is forgotten with every session: a logout everywhere asks for the code on it again', async () => {
    const { user, testApp } = await enrolled();
    const { res, device } = await trustedLogin(user, testApp);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: withCsrf(csrf, sessionCookie(sessionOf(res))),
      payload: { allDevices: true },
    });
    expect(out.statusCode).toBe(204);

    expect((await firstStep(user, cookieHeader({ trustedDevice: device!.value }))).statusCode).toBe(
      202,
    );
  });
});

describe('the second step of a signed-in account', () => {
  it('is for an admin or root only', async () => {
    const buyer = await newUser();
    const res = await get(accessCookie(buyer));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('is not there for a session from before it', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const res = await get(accessCookie(admin));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_NOT_FOUND' });
  });

  it('gives a new set of recovery codes for a code of the app; the old ones stop working', async () => {
    const { user, testApp, recoveryCodes } = await enrolled();
    const cookie = accessCookie(user);

    const wrong = await signedIn('POST', '/recovery-codes', cookie, { code: staleCodeOf(testApp) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });

    const res = await signedIn('POST', '/recovery-codes', cookie, { code: codeOf(testApp) });
    expect(res.statusCode).toBe(200);
    const fresh: string[] = res.json().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);
    expect(await auditEvents(user.id)).toEqual(['two_factor.recovery_renew']);

    const old = await postTwoFactor(app, csrf, '/verify', ticketCookieOf(await firstStep(user)), {
      recoveryCode: recoveryCodes[0],
    });
    expect(old.statusCode).toBe(401);
    expect(old.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });
  });

  it('moves to a new app for a code of the old one; the old app stops working', async () => {
    const { user, testApp } = await enrolled();
    const cookie = accessCookie(user);

    const none = await signedIn('POST', '/replace', cookie, {});
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ errorCode: 'TWO_FACTOR_PROOF_REQUIRED' });

    const started = await signedIn('POST', '/replace', cookie, { code: codeOf(testApp) });
    expect(started.statusCode).toBe(200);
    const newApp = newTestApp(started.json().secret);
    const withTicket = `${cookie}; ${ticketCookieOf(started)}`;

    const wrong = await signedIn('POST', '/replace/confirm', withTicket, { code: codeOf(testApp) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });

    const done = await signedIn('POST', '/replace/confirm', withTicket, { code: codeOf(newApp) });
    expect(done.statusCode).toBe(204);
    expect(await auditEvents(user.id)).toEqual(['two_factor.replace']);

    const oldCode = await postTwoFactor(
      app,
      csrf,
      '/verify',
      ticketCookieOf(await firstStep(user)),
      {
        code: codeOf(testApp),
      },
    );
    expect(oldCode.statusCode).toBe(401);
    const newCode = await postTwoFactor(
      app,
      csrf,
      '/verify',
      ticketCookieOf(await firstStep(user)),
      {
        code: codeOf(newApp),
      },
    );
    expect(newCode.statusCode).toBe(200);
  });

  it('moves to a new app without a proof right after a login with a recovery code', async () => {
    const { user, recoveryCodes } = await enrolled();
    const login = await postTwoFactor(app, csrf, '/verify', ticketCookieOf(await firstStep(user)), {
      recoveryCode: recoveryCodes[3],
    });
    expect(login.statusCode).toBe(200);

    const started = await signedIn('POST', '/replace', sessionCookie(sessionOf(login)), {});
    expect(started.statusCode).toBe(200);
    expect(started.json().secret).toEqual(expect.any(String));
  });

  // a session the recovery code did not open (a stolen one) gets no such way
  it('asks a proof of another session of the account in those minutes', async () => {
    const { user, recoveryCodes } = await enrolled();
    const other = await signIn(app, csrf, user);
    const login = await postTwoFactor(app, csrf, '/verify', ticketCookieOf(await firstStep(user)), {
      recoveryCode: recoveryCodes[4],
    });
    expect(login.statusCode).toBe(200);

    for (const cookie of [sessionCookie(other), accessCookie(user)]) {
      const res = await signedIn('POST', '/replace', cookie, {});
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_PROOF_REQUIRED' });
    }
  });

  it('forgets the trusted browsers with the old app', async () => {
    const { user, testApp } = await enrolled();
    const trusted = await postTwoFactor(
      app,
      csrf,
      '/verify',
      ticketCookieOf(await firstStep(user)),
      { code: codeOf(testApp), trustDevice: true },
    );
    const deviceCookie = cookieHeader({ trustedDevice: setCookies(trusted).trustedDevice!.value });
    const cookie = `${sessionCookie(sessionOf(trusted))}; ${deviceCookie}`;

    const started = await signedIn('POST', '/replace', cookie, { code: codeOf(testApp) });
    const done = await signedIn(
      'POST',
      '/replace/confirm',
      `${cookie}; ${ticketCookieOf(started)}`,
      {
        code: codeOf(newTestApp(started.json().secret)),
      },
    );
    expect(done.statusCode).toBe(204);
    expect(setCookies(done).trustedDevice!.cleared).toBe(true);
    expect((await rowOf(user))!.trustedDevices).toEqual([]);
    expect((await firstStep(user, deviceCookie)).statusCode).toBe(202);
  });

  it('refuses the confirmation of a move with the ticket of another account', async () => {
    const { user: one, testApp } = await enrolled();
    const { user: other } = await enrolled();
    const started = await signedIn('POST', '/replace', accessCookie(one), {
      code: codeOf(testApp),
    });

    const res = await signedIn(
      'POST',
      '/replace/confirm',
      `${accessCookie(other)}; ${ticketCookieOf(started)}`,
      { code: codeOf(newTestApp(started.json().secret)) },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_TICKET_INVALID' });
  });
});

describe('the refresh of an admin or root', () => {
  it('ends the session of an account without the second step', async () => {
    const { user } = await enrolled();
    const root = await newUser({ role: 'ROOT' });
    const session = await signIn(app, csrf, user);
    // the second step goes and the sessions stay open: a session from before the second step
    await testTx(async (tx) => {
      await setUserContext(tx, { userId: root.id, role: 'ROOT' });
      await tx.$executeRaw`delete from cartlify.user_two_factor where "userId" = ${user.id}`;
    });

    const res = await refreshWith(app, csrf, session.refreshToken);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'REFRESH_TWO_FACTOR_REQUIRED' });
    expect(setCookies(res).refreshToken!.cleared).toBe(true);

    // the session is closed: its refresh cookie works no more
    const again = await refreshWith(app, csrf, session.refreshToken);
    expect(again.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
  });
});

describe('a login with a provider', () => {
  it('sends an admin on to the second step: the ticket, ?twoFactor, no session', async () => {
    const githubId = Number(`${Date.now()}`.slice(-9));
    const admin = await newUser({
      role: 'ADMIN',
      authProvider: 'GITHUB',
      providerSub: String(githubId),
    });
    answerAsGithub({
      id: githubId,
      name: 'Octo Admin',
      emails: [{ email: admin.email, primary: true, verified: true }],
    });
    const { guestId, state } = await startLogin(app, 'github');

    const res = await callback(
      app,
      'github',
      { code: 'test-code', state },
      cookieHeader({ guestId }),
    );
    expect(res.statusCode).toBe(302);
    expect(new URL(String(res.headers.location)).searchParams.get('twoFactor')).toBe('setup');
    const cookies = setCookies(res);
    expect(cookies.accessToken).toBeUndefined();
    expect(cookies.twoFactorTicket!.cleared).toBe(false);

    const started = await postTwoFactor(app, csrf, '/setup', ticketCookieOf(res));
    const done = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(started), {
      code: codeOf(newTestApp(started.json().secret)),
    });
    expect(done.statusCode).toBe(200);
    const line = await asAdmin((tx) =>
      tx.loginLog.findFirst({ where: { userId: admin.id }, select: { event: true } }),
    );
    expect(line).toEqual({ event: 'login.github' });
  });
});
