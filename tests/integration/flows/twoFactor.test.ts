import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieHeader, cookieJar, setCookies } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import {
  codeOf,
  newTestApp,
  postTwoFactor,
  ticketCookieOf,
  type TestApp,
} from '../../helpers/twoFactor.js';

// The second step of the login of an admin, each step with what its actor sees: root makes a buyer
// an admin; the first login of the admin sets the app up and keeps the recovery codes the answer
// shows; the admin trusts the laptop, which then lets the password alone in; the phone is lost: a
// recovery code lets the admin in, the mail tells how many are left, and the admin moves to a new
// app at once; the new phone and the codes are lost too: root resets the second step, the admin
// sets it up again; root takes the role away and the person logs in as a buyer, with no second
// step. The refusals of each step are the tests of the routes.
let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let person: TestUser;

const LAPTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  person = await createUser({ name: 'Ivan Second' });
});

afterAll(async () => {
  try {
    await closeSessions([root.id, person.id]);
  } finally {
    await stopApp();
  }
});

const get = (cookie: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });
const send = (
  cookie: string,
  method: 'POST' | 'DELETE',
  url: string,
  payload: Record<string, unknown> = {},
) => app.inject({ method, url, headers: withCsrf(csrf, cookie), payload });

const sessionOf = (res: { headers: Record<string, unknown> }): Session => {
  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
};

const firstStep = (cookie = '') =>
  logIn(
    app,
    csrf,
    { email: person.email, password: person.password },
    { cookie, userAgent: LAPTOP },
  );

describe('the second step of the login of an admin', () => {
  it('is set up at the first login, trusted on a laptop, recovered with a code, moved to a new app, reset by root and gone with the role', async () => {
    const rootCookie = sessionCookie(await signIn(app, csrf, root));

    // root makes the buyer an admin
    const promoted = await send(rootCookie, 'POST', '/api/root/admins', { userId: person.id });
    expect(promoted.statusCode).toBe(201);

    // the first login asks for the setup: the admin scans the code and types the first code of it
    const first = await firstStep();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ twoFactor: 'setup', canTrustDevice: true });
    const started = await postTwoFactor(app, csrf, '/setup', ticketCookieOf(first));
    let phone: TestApp = newTestApp(started.json().secret);
    const setUp = await postTwoFactor(
      app,
      csrf,
      '/setup/confirm',
      ticketCookieOf(started),
      { code: codeOf(phone), trustDevice: true },
      LAPTOP,
    );
    expect(setUp.statusCode).toBe(200);
    const recoveryCodes: string[] = setUp.json().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    const laptop = cookieHeader({ trustedDevice: setCookies(setUp).trustedDevice!.value });

    // the admin works, and the profile shows the second step and the laptop
    const session = sessionCookie(sessionOf(setUp));
    expect((await get(session, '/api/admin/stats')).statusCode).toBe(200);
    const status = await get(`${session}; ${laptop}`, '/api/auth/two-factor');
    expect(status.json()).toMatchObject({ recoveryCodesLeft: 10 });
    expect(status.json().devices).toEqual([
      expect.objectContaining({ label: 'Chrome, Windows', current: true }),
    ]);

    // the laptop lets the password alone in
    const onLaptop = await firstStep(laptop);
    expect(onLaptop.statusCode).toBe(200);
    expect(onLaptop.json()).toMatchObject({ id: person.id, role: 'ADMIN' });

    // the phone is lost: another browser, a recovery code; the mail tells how many are left
    const mails = watchMail();
    const lost = await firstStep();
    expect(lost.json()).toMatchObject({ twoFactor: 'code' });
    const recovered = await postTwoFactor(app, csrf, '/verify', ticketCookieOf(lost), {
      recoveryCode: recoveryCodes[0],
    });
    expect(recovered.statusCode).toBe(200);
    expect(mails.map((mail) => mail.to)).toEqual([[person.email]]);
    expect(mails[0]!.text).toContain('Recovery codes left: 9');

    // right after it the admin moves to a new phone with no other proof; the old app stops working
    const recoveredSession = sessionCookie(sessionOf(recovered));
    const moving = await send(recoveredSession, 'POST', '/api/auth/two-factor/replace');
    expect(moving.statusCode).toBe(200);
    const oldPhone = phone;
    phone = newTestApp(moving.json().secret);
    const moved = await send(
      `${recoveredSession}; ${ticketCookieOf(moving)}`,
      'POST',
      '/api/auth/two-factor/replace/confirm',
      { code: codeOf(phone) },
    );
    expect(moved.statusCode).toBe(204);
    const withOld = await postTwoFactor(app, csrf, '/verify', ticketCookieOf(await firstStep()), {
      code: codeOf(oldPhone),
    });
    expect(withOld.json()).toMatchObject({ errorCode: 'TWO_FACTOR_CODE_INVALID' });

    // the new phone and the codes are lost as well: root resets the second step, the admin gets a
    // mail, and the next login sets the app up again; the laptop is trusted no more
    const resetMails = watchMail();
    const reset = await send(rootCookie, 'DELETE', `/api/root/admins/${person.id}/two-factor`);
    expect(reset.statusCode).toBe(204);
    expect(resetMails.map((mail) => mail.to)).toEqual([[person.email]]);
    const afterReset = await firstStep(laptop);
    expect(afterReset.json()).toEqual({ twoFactor: 'setup', canTrustDevice: true });
    const restarted = await postTwoFactor(app, csrf, '/setup', ticketCookieOf(afterReset));
    phone = newTestApp(restarted.json().secret);
    const again = await postTwoFactor(app, csrf, '/setup/confirm', ticketCookieOf(restarted), {
      code: codeOf(phone),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().recoveryCodes).toHaveLength(10);

    // root takes the role away: the person logs in as a buyer, with no second step
    const demoted = await send(rootCookie, 'DELETE', `/api/root/admins/${person.id}`);
    expect(demoted.statusCode).toBe(200);
    const asBuyer = await firstStep();
    expect(asBuyer.statusCode).toBe(200);
    expect(asBuyer.json()).toMatchObject({ role: 'USER' });

    // made an admin once more, the person sets the app up from the start
    expect(
      (await send(rootCookie, 'POST', '/api/root/admins', { userId: person.id })).statusCode,
    ).toBe(201);
    expect((await firstStep()).json()).toMatchObject({ twoFactor: 'setup' });
  });
});
