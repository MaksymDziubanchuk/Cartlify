import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { sessionCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieHeader, cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { closeSessions, createProduct, uniqueEmail, uniqueTag } from '../../helpers/factories.js';
import {
  answerAsGithub,
  callback,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  startLogin,
} from '../../helpers/oauth.js';

// A login with an account of Google, GitHub or LinkedIn, each step with what the browser sees: a
// guest likes a product and signs in with GitHub, lands on the page of the frontend signed in, with
// the favorite of the guest now the account's, and comes back later with GitHub to the same
// account; other people come with Google and LinkedIn. An account stays with the provider it was
// made by. The refusals of each
// provider are the tests of api/auth (oauth*).
let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];
const google = oidcProvider('google');
const linkedin = oidcProvider('linkedin');

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions(users.map(({ id }) => id));
  } finally {
    await stopApp();
  }
});

// the profile of the browser the callback signed in, and the cookies of its session
const signedIn = async (res: Awaited<ReturnType<typeof callback>>) => {
  expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
  const session = sessionCookie(cookieJar(res));
  const me = await app.inject({
    method: 'GET',
    url: '/api/users/me',
    headers: { cookie: session },
  });
  expect(me.statusCode).toBe(200);
  return { me: me.json() as { id: number; email: string }, session };
};

describe('a login with an account of a provider', () => {
  it('a guest signs in with GitHub and keeps the favorite, then comes back with GitHub to the same account', async () => {
    const product = await createProduct();
    const email = uniqueEmail('flow-provider');
    emails.push(email);

    // the guest likes a product, then signs in with GitHub in the same browser
    const liked = await app.inject({
      method: 'POST',
      url: `/api/favorites/${product.variantId}`,
      headers: withCsrf(csrf),
    });
    const guest = cookieHeader({ guestId: cookieJar(liked).guestId });
    answerAsGithub({
      id: Date.now() % 1_000_000_000,
      name: 'Octo Flow',
      emails: [{ email, primary: true, verified: true }],
    });
    const started = await startLogin(app, 'github', guest);
    const { me, session } = await signedIn(
      await callback(app, 'github', { code: 'flow-code', state: started.state }, guest),
    );
    expect(me.email).toBe(email);
    const favorites = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: session },
    });
    expect(
      (favorites.json().items as { variant: { id: number } }[]).map(({ variant }) => variant.id),
    ).toEqual([product.variantId]);

    // later, in another browser, GitHub again: the same account
    const again = await startLogin(app, 'github');
    const back = await signedIn(
      await callback(
        app,
        'github',
        { code: 'flow-code', state: again.state },
        cookieHeader({ guestId: again.guestId }),
      ),
    );
    expect(back.me.id).toBe(me.id);
  });

  it('a person signs in with Google, another with LinkedIn, each a new account', async () => {
    const email = uniqueEmail('flow-google');
    emails.push(email);
    google.answer(
      google.idToken({
        sub: `google-${uniqueTag()}`,
        email,
        email_verified: true,
        name: 'Goo Flow',
      }),
    );
    const started = await startLogin(app, 'google');
    const { me } = await signedIn(
      await callback(
        app,
        'google',
        { code: 'flow-code', state: started.state },
        cookieHeader({ guestId: started.guestId }),
      ),
    );
    expect(me).toMatchObject({ email, name: 'Goo Flow' });
    jest.restoreAllMocks();
    const other = uniqueEmail('flow-linkedin');
    emails.push(other);
    linkedin.answer(
      linkedin.idToken({
        sub: `linkedin-${uniqueTag()}`,
        email: other,
        email_verified: true,
        name: 'Link Flow',
      }),
    );
    const linked = await startLogin(app, 'linkedin');
    const { me: person } = await signedIn(
      await callback(
        app,
        'linkedin',
        { code: 'flow-code', state: linked.state },
        cookieHeader({ guestId: linked.guestId }),
      ),
    );
    expect(person).toMatchObject({ email: other, name: 'Link Flow' });
    expect(person.id).not.toBe(me.id);
  });
});
