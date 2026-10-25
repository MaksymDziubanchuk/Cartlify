import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { signAccessToken } from '@utils/jwt.js';
import { InternalError, UnauthorizedError } from '@utils/errors.js';

import { fakeReply, fakeRequest } from '../../helpers/fakeHttp.js';
import { rejectedBy } from '../../helpers/errors.js';

// the refresh flow reads the database, so only it is replaced; token checks and cookies are real
const refreshMock = jest.fn<(args: { refreshToken: string }) => Promise<unknown>>();

jest.unstable_mockModule('@routes/api/auth/services/helpers/resignAccessToken.helper.js', () => ({
  refreshAccessTokenByRefreshToken: refreshMock,
}));

const { default: authGuard } = await import('@middlewares/auth.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const run = (req: FastifyRequest, reply: FastifyReply) => authGuard(req, reply);

const refreshed = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  refreshMaxAgeSec: 86400,
  user: { id: 9, role: 'USER' },
  rememberMe: false,
};

beforeEach(() => {
  refreshMock.mockReset();
});

describe('authGuard', () => {
  // the guard hangs only on api routes; a raw address the router still matches to one of them
  // (/%61pi/..., an absolute form) used to leave the request without a user
  it.each(['/%61pi/products', 'http://shop.example.com/api/products', '/api/products'])(
    'gives the request a user whatever its raw address looks like (%s)',
    async (url) => {
      const req = fakeRequest({ url, cookies: {} });

      await run(req, fakeReply().reply);

      expect(req.user).toEqual({ id: expect.stringMatching(UUID), role: 'GUEST' });
    },
  );

  it('takes the user from a valid access token', async () => {
    const token = signAccessToken({ userId: 5, role: 'ADMIN', type: 'access' }, false);
    const req = fakeRequest({ cookies: { accessToken: token } });

    await run(req, fakeReply().reply);

    expect(req.user).toEqual({ id: 5, role: 'ADMIN' });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  describe('without login cookies', () => {
    it('makes a new guest with a uuid cookie', async () => {
      const req = fakeRequest({ cookies: {} });
      const http = fakeReply();

      await run(req, http.reply);

      const guestId = http.cookies.guestId?.value;

      expect(guestId).toMatch(UUID);
      // default guest lifetime is five years
      expect(http.cookies.guestId?.options.maxAge).toBe(157680000);
      expect(req.user).toEqual({ id: guestId, role: 'GUEST' });
    });

    it('keeps an existing guest id', async () => {
      const guestId = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c';
      const req = fakeRequest({ cookies: { guestId } });
      const http = fakeReply();

      await run(req, http.reply);

      expect(req.user).toEqual({ id: guestId, role: 'GUEST' });
      expect(http.cookies.guestId).toBeUndefined();
    });

    // guest ids are uuid columns in the database, any other value breaks guest queries
    it('replaces a guest id that is not a uuid', async () => {
      const req = fakeRequest({ cookies: { guestId: "x' or 1=1 --" } });
      const http = fakeReply();

      await run(req, http.reply);

      expect(http.cookies.guestId?.value ?? 'no new guestId cookie').toMatch(UUID);
      expect(String((req.user as { id: unknown }).id)).toMatch(UUID);
    });
  });

  describe('with a bad access token', () => {
    it('drops the cookie and asks to log in when there is no refresh token', async () => {
      const req = fakeRequest({ cookies: { accessToken: 'garbage' } });
      const http = fakeReply();

      const err = await rejectedBy(() => run(req, http.reply));

      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err).toMatchObject({ statusCode: 401, errorCode: 'LOGIN_REQUIRED' });
      expect(http.cleared).toContain('accessToken');
    });

    it('logs in silently with the refresh token and sets new cookies', async () => {
      refreshMock.mockResolvedValue(refreshed);
      const req = fakeRequest({ cookies: { accessToken: 'expired', refreshToken: 'old-refresh' } });
      const http = fakeReply();

      await run(req, http.reply);

      expect(refreshMock).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
      expect(req.user).toEqual({ id: 9, role: 'USER' });
      expect(http.cookies.accessToken).toMatchObject({
        value: 'new-access',
        options: { maxAge: 1200 },
      });
      expect(http.cookies.refreshToken).toMatchObject({
        value: 'new-refresh',
        options: { maxAge: 86400 },
      });
    });
  });

  describe('with only a refresh token', () => {
    it('logs in silently', async () => {
      refreshMock.mockResolvedValue({ ...refreshed, rememberMe: true });
      const req = fakeRequest({ cookies: { refreshToken: 'old-refresh' } });
      const http = fakeReply();

      await run(req, http.reply);

      expect(req.user).toEqual({ id: 9, role: 'USER' });
      // remember me keeps the long access lifetime
      expect(http.cookies.accessToken?.options.maxAge).toBe(3600);
    });

    // a dead refresh cookie must log the user out, not break every request
    it('clears both cookies and asks to log in when the refresh token is rejected', async () => {
      refreshMock.mockRejectedValue(new UnauthorizedError('REFRESH_TOKEN_INVALID'));
      const req = fakeRequest({ cookies: { refreshToken: 'dead' } });
      const http = fakeReply();

      const err = await rejectedBy(() => run(req, http.reply));

      expect(err).toMatchObject({ statusCode: 401, errorCode: 'LOGIN_REQUIRED' });
      expect(http.cleared).toEqual(expect.arrayContaining(['accessToken', 'refreshToken']));
    });

    it('answers 503 and keeps the cookies when the server cannot check the token', async () => {
      refreshMock.mockRejectedValue(new InternalError());
      const req = fakeRequest({ cookies: { refreshToken: 'maybe-fine' } });
      const http = fakeReply();

      const err = await rejectedBy(() => run(req, http.reply));

      expect(err).toMatchObject({ statusCode: 503, errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE' });
      expect(http.cleared).not.toContain('refreshToken');
    });
  });
});
