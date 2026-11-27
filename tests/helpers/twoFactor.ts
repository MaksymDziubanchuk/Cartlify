import type { FastifyInstance } from 'fastify';

import { setUserContext } from '@db/dbContext.service.js';
import { encryptTwoFactorSecret } from '@helpers/twoFactor/twoFactorKeys.js';
import { newRecoveryCodes, recoveryCodeHash } from '@helpers/twoFactor/recoveryCodes.js';
import { newTotpSecret, totpCode, totpStepAt } from '@helpers/twoFactor/totp.js';

import { cookieHeader, cookieJar } from './cookies.js';
import { withCsrf, type Csrf } from './csrf.js';
import { testTx } from './db.js';

// The authenticator app of a test admin or root: the secret it scanned, and the last step it gave a
// code for. A code works once, so the next code is of a later step: the app of a person shows a new
// code every 30 seconds, a test takes the code of the next step (the server takes one step ahead).
export type TestApp = { secret: string; lastStep: number };

export const newTestApp = (secret: string): TestApp => ({ secret, lastStep: 0 });

// the code the app shows now, one the server has not taken yet; three logins of an account in one
// step of 30 seconds are all a test may do
export function codeOf(app: TestApp): string {
  const now = totpStepAt(Date.now());
  const step = Math.max(now - 1, app.lastStep + 1);
  if (step > now + 1) throw new Error('the test app gave every code of this step already');

  app.lastStep = step;
  return totpCode(app.secret, step);
}

// the code the app shows now, the way a person reads it off the phone: when the code of now was
// used, the person waits for the next one (up to 30 seconds)
export async function freshCodeOf(app: TestApp): Promise<string> {
  for (;;) {
    const now = totpStepAt(Date.now());
    if (app.lastStep < now) {
      app.lastStep = now;
      return totpCode(app.secret, now);
    }
    await new Promise((resolve) => setTimeout(resolve, (now + 1) * 30_000 - Date.now() + 50));
  }
}

// a code of a step the server takes no longer
export const staleCodeOf = (app: TestApp) => totpCode(app.secret, totpStepAt(Date.now()) - 3);

// the cookies the first step of a login left: the ticket, and the guest of the browser
export const ticketCookieOf = (res: { headers: Record<string, unknown> }, extra = '') =>
  [cookieHeader({ twoFactorTicket: cookieJar(res).twoFactorTicket }), extra]
    .filter(Boolean)
    .join('; ');

export const postTwoFactor = (
  app: FastifyInstance,
  csrf: Csrf,
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
  userAgent?: string,
) =>
  app.inject({
    method: 'POST',
    url: `/api/auth/two-factor${url}`,
    headers: { ...withCsrf(csrf, cookie), ...(userAgent ? { 'user-agent': userAgent } : {}) },
    ...(payload ? { payload } : {}),
  });

// An admin or root with the second step set up already, written the way the setup writes it, for
// the tests of a route that only needs it there (the setup itself is tested by its routes and flows)
export async function enrollTwoFactor(user: {
  id: number;
  role: 'ADMIN' | 'ROOT';
}): Promise<{ app: TestApp; recoveryCodes: string[] }> {
  const secret = newTotpSecret();
  const recoveryCodes = newRecoveryCodes();

  await testTx(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: user.role });
    await tx.userTwoFactor.create({
      data: {
        userId: user.id,
        secretEnc: encryptTwoFactorSecret(secret),
        recoveryCodes: recoveryCodes.map(recoveryCodeHash),
      },
    });
  });

  return { app: newTestApp(secret), recoveryCodes };
}
