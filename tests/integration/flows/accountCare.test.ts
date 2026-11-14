import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn, sessionCookie, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { imageField, pngImage } from '../../helpers/cloudinary.js';
import { cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import { mailedToken, watchMail } from '../../helpers/mail.js';
import { forget, rowsOf } from '../../helpers/newsletterApi.js';
import { multipartBody } from '../../helpers/multipart.js';
import { journeyOf } from '../../helpers/returnJourney.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// The care of an account, each step with what its actor sees: a person whose mail of confirmation
// got lost asks for another one; a buyer who forgot the password sets a new one by the link of the
// mail, changes the profile and the avatar (an admin takes the avatar away), takes the data and
// deletes the account (a subscription to the newsletter is in the data and ends with the account,
// the mail of the deletion says so); root takes the data of another account and deletes it. The refusals of each
// step are the tests of the routes (api/auth, api/users).
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const addresses: string[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
    await forget(addresses);
  } finally {
    await stopApp();
  }
});

const loggedIn = async (email: string, password: string): Promise<Session> => {
  const res = await logIn(app, csrf, { email, password });
  expect(res.statusCode).toBe(200);
  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
};
const getAs = (session: Session, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: sessionCookie(session) } });

describe('the care of an account', () => {
  it('sends the confirmation again when the first mail got lost, and the second link lets the person in', async () => {
    const email = uniqueEmail('flow-care-resend');
    const password = 'flow-care-password-1';
    const mails = watchMail();

    const registered = await j.post(
      null,
      '/api/auth/register',
      withCaptcha({ email, password, name: 'Lost Mail' }),
    );
    expect(registered.statusCode).toBe(201);
    userIds.push(registered.json().id);

    // the first mail never reached the person: they ask for another one and open its link
    expect((await j.post(null, '/api/auth/verify/resend', withCaptcha({ email }))).statusCode).toBe(
      200,
    );
    expect(mails.filter((mail) => mail.to.includes(email))).toHaveLength(2);
    const token = mailedToken(mails, '/web/login');
    // the page of the link reads the token after the # and posts it
    expect((await j.post(null, '/api/auth/verify', { token })).statusCode).toBe(200);

    const session = await loggedIn(email, password);
    expect((await getAs(session, '/api/users/me')).json()).toMatchObject({
      email,
      isVerified: true,
    });
  });

  it('sets a new password by the link of the mail, changes the profile, takes the data and deletes the account', async () => {
    const buyer = await createUser({ name: 'Forgetful Buyer' });
    userIds.push(buyer.id);
    addresses.push(buyer.email);
    const mails = watchMail();

    // the link of the mail sets a new password, the login takes it
    expect(
      (await j.post(null, '/api/auth/password/forgot', withCaptcha({ email: buyer.email })))
        .statusCode,
    ).toBe(200);
    const token = mailedToken(mails, '/web/auth/reset');
    const newPassword = 'flow-care-new-password-1';
    // the page of the link reads the token after the # and posts it with the new password
    const reset = await j.post(null, '/api/auth/password/reset', { token, newPassword });
    expect(reset.statusCode).toBe(200);
    const session = await loggedIn(buyer.email, newPassword);

    // the buyer signs in on the phone too, sees both sessions and closes the one of the phone
    await loggedIn(buyer.email, newPassword);
    const sessions = (await getAs(session, '/api/auth/sessions')).json().items as {
      id: string;
      current: boolean;
    }[];
    expect(sessions).toHaveLength(2);
    const phone = sessions.find(({ current }) => !current)!;
    const closed = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${phone.id}`,
      headers: withCsrf(csrf, sessionCookie(session)),
    });
    expect(closed.statusCode).toBe(204);
    expect((await getAs(session, '/api/auth/sessions')).json().items).toEqual([
      expect.objectContaining({ current: true }),
    ]);

    // and changes the password while signed in: the session goes on, the mail tells of it
    const ownPassword = 'flow-care-own-password-2';
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: withCsrf(csrf, sessionCookie(session)),
      payload: { currentPassword: newPassword, newPassword: ownPassword },
    });
    expect(changed.statusCode).toBe(204);
    expect(mails.at(-1)!.to).toEqual([buyer.email]);
    expect((await getAs(session, '/api/users/me')).statusCode).toBe(200);

    // the profile: a name, a phone and a picture of their own
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: withCsrf(csrf, sessionCookie(session)),
      payload: { name: 'Careful Buyer', phone: '+380501112233' },
    });
    expect(renamed.statusCode).toBe(200);
    const form = multipartBody([imageField('avatar', pngImage(64, 64), { filename: 'me.png' })]);
    const pictured = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { ...withCsrf(csrf, sessionCookie(session)), ...form.headers },
      payload: form.payload,
    });
    expect(pictured.statusCode).toBe(200);
    expect(pictured.json()).toMatchObject({ name: 'Careful Buyer', avatarIsDefault: false });

    // an admin finds the picture unfit and takes it away; the buyer has the drawn one again
    const found = await j.get(admin, `/api/users?email=${encodeURIComponent(buyer.email)}`);
    const buyerId = (found.json().items as { id: number }[])[0]!.id;
    const profile = await j.get(admin, `/api/users/${buyerId}`);
    expect(profile.json()).toMatchObject({ name: 'Careful Buyer', avatarIsDefault: false });
    const removed = await j.del(admin, `/api/users/${buyerId}/avatar`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ removed: true, avatarRemovals: 1 });
    expect((await getAs(session, '/api/users/me')).json().avatarIsDefault).toBe(true);

    // the buyer subscribes to the newsletter from the profile
    const subscribed = await app.inject({
      method: 'POST',
      url: '/api/newsletters/subscriptions',
      headers: withCsrf(csrf, sessionCookie(session)),
      payload: {},
    });
    expect(subscribed.statusCode).toBe(201);

    // the buyer takes the data, the subscription in it, and leaves
    const data = await getAs(session, '/api/users/me/export');
    expect(data.statusCode).toBe(200);
    expect(data.json().profile).toMatchObject({
      email: buyer.email,
      name: 'Careful Buyer',
      phone: '+380501112233',
    });
    expect(data.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({
        source: 'account',
        status: 'active',
        events: [expect.objectContaining({ event: 'subscribed', place: 'profile' })],
      }),
    ]);
    const left = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: withCsrf(csrf, sessionCookie(session)),
      payload: { password: ownPassword },
    });
    expect(left.statusCode).toBe(204);

    // the mail of the deletion tells that the subscription ended with the account
    expect(mails.at(-1)!.to).toEqual([buyer.email]);
    expect(mails.at(-1)!.text).toContain(
      'Your newsletter subscription has been cancelled as well.',
    );
    expect(await rowsOf(buyer.email)).toEqual([
      expect.objectContaining({ status: 'ended', endReason: 'account_deleted' }),
    ]);

    // root sees the account deleted
    const gone = await j.get(root, `/api/users/${buyerId}`);
    expect(gone.json().deletedAt).toEqual(expect.any(String));
  });

  it('root takes the data of an account and deletes it', async () => {
    const buyer = await createUser({ name: 'Leaving Buyer' });
    userIds.push(buyer.id);

    const found = await j.get(root, `/api/users?email=${encodeURIComponent(buyer.email)}`);
    const buyerId = (found.json().items as { id: number }[])[0]!.id;
    const data = await j.get(root, `/api/users/${buyerId}/export`);
    expect(data.statusCode).toBe(200);
    expect(data.json().profile).toMatchObject({ email: buyer.email, name: 'Leaving Buyer' });

    const deleted = await j.del(root, `/api/users/${buyerId}`);
    expect(deleted.statusCode).toBe(200);
    expect((await j.get(root, `/api/users/${buyerId}`)).json().deletedAt).toEqual(
      expect.any(String),
    );
  });
});
