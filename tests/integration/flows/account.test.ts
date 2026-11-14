import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { logIn, refreshWith, sessionCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieHeader, cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { closeSessions, createProduct, uniqueEmail } from '../../helpers/factories.js';
import { linkParams, watchMail } from '../../helpers/mail.js';
import { forget } from '../../helpers/newsletterApi.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// an account from the first visit to the logout, through the routes of auth, favorites, chat and
// users: a guest likes a product and talks to the bot, registers (the data of the guest stay its
// own until the email is confirmed), confirms the email in the same browser (the favorite and the
// chat become the account's), logs in, renews the session, loses every session to a stolen
// refresh token, logs in again and out. The box of the newsletter ticked at the registration rides
// to the page of the confirmation as a hint in the link and subscribes the account when the person
// keeps it there
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const addresses: string[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
    await forget(addresses);
  } finally {
    await stopApp();
  }
});

const favoritesOf = (where: { userId?: number; guestId?: string }) =>
  asAdmin((tx) => tx.favorite.findMany({ where, select: { productId: true, variantId: true } }));

describe('an account from the first visit to the logout', () => {
  it('goes through registration, confirmation, login, renewal, theft and logout', async () => {
    const product = await createProduct();
    const likedVariant = { productId: product.id, variantId: product.variantId };
    const email = uniqueEmail('flow-account');
    addresses.push(email);
    const password = 'flow-password-1';
    const mails = watchMail();

    // a guest likes a product and opens a chat with the bot
    const liked = await app.inject({
      method: 'POST',
      url: `/api/favorites/${product.variantId}`,
      headers: withCsrf(csrf),
    });
    expect(liked.statusCode).toBe(200);
    const guestId = cookieJar(liked).guestId!;
    const guest = cookieHeader({ guestId });

    // the guest likes another product too, finds both among the favorites and takes it out again
    const other = await createProduct();
    const likedToo = await app.inject({
      method: 'POST',
      url: `/api/favorites/${other.variantId}`,
      headers: withCsrf(csrf, guest),
    });
    expect(likedToo.statusCode).toBe(200);
    const guestFavorites = async () =>
      (
        (
          await app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie: guest } })
        ).json().items as { variant: { id: number } }[]
      )
        .map((item) => item.variant.id)
        .sort((a, b) => a - b);
    expect(await guestFavorites()).toEqual(
      [product.variantId, other.variantId].sort((a, b) => a - b),
    );
    const unliked = await app.inject({
      method: 'DELETE',
      url: `/api/favorites/${other.variantId}`,
      headers: withCsrf(csrf, guest),
    });
    expect(unliked.json()).toEqual({ variantId: other.variantId, isFavorite: false });
    expect(await guestFavorites()).toEqual([product.variantId]);
    const guestChat = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie: guest },
    });
    expect(guestChat.statusCode).toBe(200);
    const chatId = guestChat.json().thread.id as string;

    // the registration proves no address: the data of the guest stay the guest's
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: withCsrf(csrf, guest),
      payload: withCaptcha({ email, password, name: 'Flow Buyer', newsletter: true }),
    });
    expect(registered.statusCode).toBe(201);
    userIds.push(registered.json().id);
    expect(await favoritesOf({ guestId })).toEqual([likedVariant]);

    // the link of the mail, opened in the browser of the guest, shows the box ticked; the person
    // keeps it and presses the button: the email is confirmed, the account gets the favorite and the
    // chat, and the subscription
    const link = linkParams(mails.at(-1)!, '/web/login')!;
    expect(link.get('newsletter')).toBe('1');
    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf, guest),
      payload: { token: link.get('token')!, newsletter: true },
    });
    expect(verified.statusCode).toBe(200);
    const userId = registered.json().id as number;
    expect(await favoritesOf({ userId })).toEqual([likedVariant]);
    expect(await favoritesOf({ guestId })).toEqual([]);

    // the login: the profile, the favorite and the chat of the account
    const login = await logIn(app, csrf, { email, password });
    expect(login.statusCode).toBe(200);
    const first = cookieJar(login);
    const cookie = sessionCookie({
      accessToken: first.accessToken!,
      refreshToken: first.refreshToken!,
    });

    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ id: userId, email, isVerified: true, name: 'Flow Buyer' });
    const subscription = await app.inject({
      method: 'GET',
      url: '/api/newsletters/me',
      headers: { cookie },
    });
    expect(subscription.json()).toMatchObject({
      subscribed: true,
      source: 'account',
      status: 'active',
    });
    const favorites = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie },
    });
    expect(
      favorites
        .json()
        .items.map((i: { product: { id: number }; variant: { id: number } }) => [
          i.product.id,
          i.variant.id,
        ]),
    ).toEqual([[product.id, product.variantId]]);
    const chat = await app.inject({
      method: 'GET',
      url: '/api/chat/thread/current',
      headers: { cookie },
    });
    expect(chat.json().thread.id).toBe(chatId);

    // the session renews with the refresh token, which is spent then
    const renewed = await refreshWith(app, csrf, first.refreshToken!);
    expect(renewed.statusCode).toBe(204);
    const second = cookieJar(renewed);
    expect(second.refreshToken).toEqual(expect.any(String));
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // the spent token again is a stolen one: every session of the account closes
    const stolen = await refreshWith(app, csrf, first.refreshToken!);
    expect({ status: stolen.statusCode, code: stolen.json().errorCode }).toEqual({
      status: 403,
      code: 'REFRESH_TOKEN_REUSE_DETECTED',
    });
    const closed = await refreshWith(app, csrf, second.refreshToken!);
    expect({ status: closed.statusCode, code: closed.json().errorCode }).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_REVOKED',
    });

    // a new login opens a session of its own, the logout closes it
    const again = cookieJar(await logIn(app, csrf, { email, password }));
    const againCookie = sessionCookie({
      accessToken: again.accessToken!,
      refreshToken: again.refreshToken!,
    });
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: againCookie },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().items).toHaveLength(1);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: withCsrf(csrf, againCookie),
      payload: {},
    });
    expect(out.statusCode).toBe(204);
    expect((await refreshWith(app, csrf, again.refreshToken!)).statusCode).toBe(401);
  });
});
