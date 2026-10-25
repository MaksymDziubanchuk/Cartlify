import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';

import { sessionCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { pngImage, removeUploads, storedImage } from '../../../helpers/cloudinary.js';
import { cookieHeader, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import type { FetchCall } from '../../../helpers/fetchStub.js';
import { closeSessions, createUser, uniqueEmail, uniqueTag } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  answerAsGithub,
  callback,
  landing,
  oidcProvider,
  startLogin,
  type Pictures,
  type Provider,
} from '../../../helpers/oauth.js';

// the picture of the account at Google, GitHub or LinkedIn becomes the avatar of a new account:
// the server downloads it from the provider and keeps it at Cloudinary (its mock, or the real
// account with service:cloudinary) under the path of the avatar. Only the login that creates the
// account takes it; a later login and a login that links an account we have take nothing. The
// server asks the provider for a picture of 256 px, takes only the hosts of the provider, and
// waits for it at most 4 seconds: whatever goes wrong, the login goes on and the avatar is the
// drawn letter, the failure goes to the log

let app: FastifyInstance;
let csrf: Csrf;
const userEmails: string[] = [];
const google = oidcProvider('google');
const linkedin = oidcProvider('linkedin');
let nextGithubId = Number(`${Date.now()}`.slice(-8)) + 3_000_000;

const png = (width: number, height: number) => (): Response =>
  new Response(new Uint8Array(pngImage(width, height)), {
    headers: { 'content-type': 'image/png' },
  });

type Login = {
  // the picture the provider names for the account, and the address the server asks for it
  picture: string;
  asked: string;
  email: string;
  login: (
    pictures: Pictures,
    picture?: string | null,
  ) => Promise<{
    res: Awaited<ReturnType<typeof callback>>;
    calls: FetchCall[];
  }>;
};

// a new account at one provider, the same account on every login
function accountAt(provider: Provider, email = uniqueEmail(`avatar-${provider}`)): Login {
  userEmails.push(email);
  const tag = uniqueTag();

  const browserLogin = async (calls: FetchCall[]) => {
    const { guestId, state } = await startLogin(app, provider);
    const res = await callback(
      app,
      provider,
      { code: 'test-code', state },
      cookieHeader({ guestId }),
    );
    return { res, calls };
  };

  if (provider === 'github') {
    const id = ++nextGithubId;
    const picture = `https://avatars.githubusercontent.com/u/${id}?v=4`;
    return {
      picture,
      asked: `${picture}&s=256`,
      email,
      login: (pictures, named = picture) =>
        browserLogin(
          answerAsGithub(
            {
              id,
              name: 'Octo',
              avatar_url: named,
              emails: [{ email, primary: true, verified: true }],
            },
            pictures,
          ),
        ),
    };
  }

  const oidc = provider === 'google' ? google : linkedin;
  const picture =
    provider === 'google'
      ? `https://lh3.googleusercontent.com/a/test-${tag}=s96-c`
      : `https://media.licdn.com/dms/image/test-${tag}/profile-displayphoto`;
  const sub = `${provider}-${tag}`;

  return {
    picture,
    asked: provider === 'google' ? picture.replace('=s96-c', '=s256-c') : picture,
    email,
    login: (pictures, named = picture) =>
      browserLogin(
        oidc.answer(
          oidc.idToken({
            sub,
            email,
            email_verified: true,
            name: 'Pic Test',
            ...(named ? { picture: named } : {}),
          }),
          pictures,
        ),
      ),
  };
}

const rowOf = (email: string) =>
  asAdmin((tx) =>
    tx.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, avatarUrl: true, publicId: true },
    }),
  );

const signedIn = (res: Awaited<ReturnType<typeof callback>>) => {
  expect(landing(res)).toMatchObject({ status: 302, error: null });
  return setCookies(res).accessToken?.value;
};

const picturesAsked = (calls: FetchCall[], account: Login) =>
  calls.filter((call) => call.url === account.asked || call.url === account.picture);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await removeUploads();
  } finally {
    try {
      const ids = await asAdmin((tx) =>
        tx.user.findMany({ where: { email: { in: userEmails } }, select: { id: true } }),
      );
      await closeSessions(ids.map((row) => row.id));
    } finally {
      await stopApp();
    }
  }
}, 120_000);

describe('the picture of a new oauth account', () => {
  it.each(['google', 'github', 'linkedin'] as const)(
    'keeps the %s picture of a new account as its avatar, asked at 256 px',
    async (provider) => {
      const account = accountAt(provider);

      const { res, calls } = await account.login({ [account.asked]: png(48, 32) });

      expect(signedIn(res)).toEqual(expect.any(String));
      expect(picturesAsked(calls, account).map((call) => call.url)).toEqual([account.asked]);
      // no redirect is followed: a picture is at the address of the provider or nowhere
      expect(calls.find((call) => call.url === account.asked)?.redirect).toBe('error');
      const row = await rowOf(account.email);
      expect(row.publicId).toBe(`test/users/${row.id}/avatar`);
      expect(row.avatarUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
      expect(await storedImage(`test/users/${row.id}/avatar`)).toMatchObject({
        width: 48,
        height: 32,
        format: 'png',
      });
    },
  );

  // the copy is ours: a picture the person removed does not come back with the next login
  it('takes nothing on a later login, also after the person removed the avatar', async () => {
    const account = accountAt('google');
    const first = await account.login({ [account.asked]: png(48, 32) });
    const accessToken = signedIn(first.res)!;
    const removed = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: withCsrf(csrf, sessionCookie({ accessToken })),
      payload: { avatar: '' },
    });
    expect(removed.statusCode).toBe(200);

    const again = await account.login({ [account.asked]: png(60, 20) });

    expect(signedIn(again.res)).toEqual(expect.any(String));
    expect(picturesAsked(again.calls, account)).toEqual([]);
    expect(await rowOf(account.email)).toMatchObject({ avatarUrl: null, publicId: null });
  });

  it('takes nothing when the login links an account we already have', async () => {
    const email = uniqueEmail('avatar-link');
    await createUser({ email, isVerified: false });
    const account = accountAt('google', email);

    const { res, calls } = await account.login({ [account.asked]: png(48, 32) });

    expect(signedIn(res)).toEqual(expect.any(String));
    expect(picturesAsked(calls, account)).toEqual([]);
    expect(await rowOf(email)).toMatchObject({ avatarUrl: null });
  });

  it('draws the letter for a new account the provider gives no picture', async () => {
    const account = accountAt('google');

    const { res, calls } = await account.login({}, null);

    expect(signedIn(res)).toEqual(expect.any(String));
    expect(picturesAsked(calls, account)).toEqual([]);
    expect(await rowOf(account.email)).toMatchObject({ avatarUrl: null });
  });

  describe('a picture it cannot take', () => {
    const aborted = (call: FetchCall) =>
      new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });

    it.each([
      [
        'the provider has no such picture',
        () => new Response('not found', { status: 404 }),
        'status_404',
      ],
      ['the picture is not an image', () => new Response('<html>a page</html>'), 'not_an_image'],
      [
        'the picture is over the size limit',
        () => new Response(new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1)),
        'too_big',
      ],
      ['the provider answers after 4 seconds', aborted, 'timeout'],
    ] as const)(
      'signs the person in with the drawn letter when %s, and logs it',
      async (_case, answer, reason) => {
        const account = accountAt('google');

        const { res } = await account.login({ [account.asked]: answer });

        expect(signedIn(res)).toEqual(expect.any(String));
        const row = await rowOf(account.email);
        expect(row).toMatchObject({ avatarUrl: null, publicId: null });
        const [logged] = takeLogs({ msg: 'provider avatar was not copied' });
        expect(logged).toMatchObject({ userId: row.id, provider: 'GOOGLE', reason });
        // the log names no address of the person
        expect(JSON.stringify(logged)).not.toContain(account.picture);
      },
      10_000,
    );

    // our server opens only the addresses of the provider
    it('does not open an address that is not of the provider', async () => {
      const account = accountAt('google');
      const elsewhere = 'https://images.example.com/me.png';

      const { res, calls } = await account.login({ [elsewhere]: png(48, 32) }, elsewhere);

      expect(signedIn(res)).toEqual(expect.any(String));
      expect(calls.filter((call) => call.url.startsWith('https://images.example.com'))).toEqual([]);
      const row = await rowOf(account.email);
      expect(row.avatarUrl).toBeNull();
      expect(takeLogs({ msg: 'provider avatar was not copied' })[0]).toMatchObject({
        userId: row.id,
        reason: 'host_not_allowed',
      });
    });
  });
});
