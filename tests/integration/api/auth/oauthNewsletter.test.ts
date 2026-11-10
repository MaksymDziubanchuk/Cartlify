import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { b64urlJson } from '@helpers/b64Payload.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, setCookies } from '../../../helpers/cookies.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueEmail, uniqueTag } from '../../../helpers/factories.js';
import { arrange, forget, journalOf, rowsOf } from '../../../helpers/newsletterApi.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import {
  answerAsGithub,
  callback,
  craftState,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  startLogin,
  type Provider,
} from '../../../helpers/oauth.js';

// The newsletter at the first login through Google, GitHub or LinkedIn: the page adds
// newsletter=true to the start of the login, the signed state carries it to the callback, and a login
// that makes a NEW account subscribes it (place registration). A login to an account the shop has
// ignores it. The callback reads the choice only from the state it verified. The subscription
// itself and its refusals are in tests/integration/api/newsletters and tests/integration/db

const PROVIDERS: Provider[] = ['google', 'github', 'linkedin'];

let app: FastifyInstance;
const emails: string[] = [];
const google = oidcProvider('google');
const linkedin = oidcProvider('linkedin');

type Person = { provider: Provider; email: string; sub: string; locale?: string };

const newPerson = (provider: Provider, locale?: string): Person => {
  const email = uniqueEmail(`news-${provider}`);
  emails.push(email);

  return {
    provider,
    email,
    // GitHub names an account by a number
    sub:
      provider === 'github'
        ? String(Math.floor(Math.random() * 1e9) + 1e9)
        : `${provider}-${uniqueTag()}`,
    ...(locale ? { locale } : {}),
  };
};

// the provider answers the server as this person's account
function answerAs(person: Person) {
  const claims = {
    sub: person.sub,
    email: person.email,
    email_verified: true,
    name: 'News Test',
    ...(person.locale ? { locale: person.locale } : {}),
  };

  if (person.provider === 'google') google.answer(google.idToken(claims));
  else if (person.provider === 'linkedin') linkedin.answer(linkedin.idToken(claims));
  else {
    answerAsGithub({
      id: Number(person.sub),
      name: 'News Test',
      emails: [{ email: person.email, primary: true, verified: true }],
    });
  }
}

// the whole login: the start with the query of the page, the provider's answer, the callback of the
// browser that started it. A state can be swapped on the way
async function signInAs(
  person: Person,
  query: Record<string, string> = {},
  state?: (started: string, guestId: string) => string | undefined,
) {
  answerAs(person);
  const started = await startLogin(app, person.provider, '', query);
  const sent = state ? state(started.state, started.guestId) : started.state;
  const res = await callback(
    app,
    person.provider,
    { code: 'test-code', ...(sent === undefined ? {} : { state: sent }) },
    cookieHeader({ guestId: started.guestId }),
  );

  return { res, started };
}

const userByEmail = (email: string) =>
  asAdmin((tx) => tx.user.findUnique({ where: { email }, select: { id: true } }));

// what the state carries, read the way the callback does
const payloadOf = (state: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8'));

const signedNow = (guestId: string, extra: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return { guestId, nonce: 'test-nonce', iat: now, exp: now + 600, ...extra };
};

const policyVersion = () =>
  inOwnerTx(async (db) => {
    const [row] = await db.rows<{ version: number | null }>(
      'select cartlify.current_privacy_version() as version',
    );
    return row!.version;
  });

beforeAll(async () => {
  app = await startApp();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions(users.map((u) => u.id));
    await forget(emails);
  } finally {
    await stopApp();
  }
});

describe.each(PROVIDERS)('the start of a login with %s', (provider) => {
  it('puts the choice in the signed state when the query says yes', async () => {
    const { state } = await startLogin(app, provider, '', { newsletter: 'true' });

    expect(payloadOf(state)).toMatchObject({ newsletter: true });
  });

  it.each([
    ['no', { newsletter: 'false' }],
    ['not given', {}],
  ])('puts nothing in the state when the choice is %s', async (_case, query) => {
    const { state } = await startLogin(app, provider, '', query);

    expect(payloadOf(state)).not.toHaveProperty('newsletter');
  });

  it('carries the versions of the terms and the choice side by side', async () => {
    const { state } = await startLogin(app, provider, '', {
      newsletter: 'true',
      acceptedDocumentIds: '17,12',
    });

    expect(payloadOf(state)).toMatchObject({ newsletter: true, accepted: [17, 12] });
  });

  it('refuses a choice that is not a boolean', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/${provider}?newsletter=maybe`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe.each(PROVIDERS)('a login with %s that makes a new account', (provider) => {
  it('subscribes the account when the page asked for it', async () => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, { newsletter: 'true' });

    expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    const user = await userByEmail(person.email);
    const [row, ...more] = await rowsOf(person.email);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ source: 'account', status: 'active', userId: user!.id });
    const journal = await journalOf(person.email);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      event: 'subscribed',
      place: 'registration',
      ip: expect.any(String),
      privacyVersion: await policyVersion(),
    });
  });

  it.each([
    ['no', { newsletter: 'false' }],
    ['not given', {}],
  ])('subscribes nobody when the choice is %s', async (_case, query) => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, query);

    expect(landing(res).error).toBeNull();
    expect(await userByEmail(person.email)).not.toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });

  it('answers the same whether the page asked for the subscription or not', async () => {
    const asked = newPerson(provider);
    const plain = newPerson(provider);

    const withChoice = await signInAs(asked, { newsletter: 'true' });
    const without = await signInAs(plain);

    expect(landing(withChoice.res)).toEqual(landing(without.res));
    expect(Object.keys(setCookies(withChoice.res)).sort()).toEqual(
      Object.keys(setCookies(without.res)).sort(),
    );
  });

  // the address was subscribed through the form before: the login goes on, the subscription stays
  it('keeps the subscription the address has and says nothing of it', async () => {
    const person = newPerson(provider);
    const existing = await arrange({ email: person.email, source: 'form' });
    const before = await rowsOf(person.email);
    const journalBefore = await journalOf(person.email);

    const { res } = await signInAs(person, { newsletter: 'true' });

    expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    expect(await rowsOf(person.email)).toEqual(before);
    expect(before).toEqual([expect.objectContaining({ id: existing.id, source: 'form' })]);
    expect(await journalOf(person.email)).toEqual(journalBefore);
  });
});

describe.each(PROVIDERS)('a login with %s to an account the shop has', (provider) => {
  it('ignores the choice and subscribes nobody', async () => {
    const person = newPerson(provider);
    expect(landing((await signInAs(person)).res).error).toBeNull();

    const { res } = await signInAs(person, { newsletter: 'true' });

    expect(landing(res).error).toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });

  // the provider takes over an account made with a password that nobody verified: not a new account
  it('ignores the choice at the takeover of an unverified account made with a password', async () => {
    const taken = await createUser({
      email: uniqueEmail(`news-take-${provider}`),
      isVerified: false,
    });
    emails.push(taken.email);
    const person: Person = {
      provider,
      email: taken.email,
      sub:
        provider === 'github'
          ? String(Math.floor(Math.random() * 1e9) + 2e9)
          : `${provider}-${uniqueTag()}`,
    };

    const { res } = await signInAs(person, { newsletter: 'true' });

    expect(landing(res).error).toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });
});

describe.each(PROVIDERS)('the choice and the state of a login with %s', (provider) => {
  // the state is signed; the choice added after the signing breaks the signature, and the login with
  // it: no account is made, so nothing is subscribed
  it('subscribes nobody when the choice was added to a signed state', async () => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, {}, (state) => {
      const [, signature] = state.split('.');
      return `${b64urlJson({ ...payloadOf(state), newsletter: true })}.${signature}`;
    });

    expect(landing(res).error).toEqual(expect.any(String));
    expect(setCookies(res).accessToken).toBeUndefined();
    expect(await userByEmail(person.email)).toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });

  it('subscribes nobody when there is no state', async () => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, { newsletter: 'true' }, () => undefined);

    // a callback with a code and no state is refused by the route itself
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(setCookies(res).accessToken).toBeUndefined();
    expect(await userByEmail(person.email)).toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });

  it('subscribes nobody when the state is made up', async () => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, { newsletter: 'true' }, () => 'made-up.state');

    expect(landing(res).error).toEqual(expect.any(String));
    expect(await userByEmail(person.email)).toBeNull();
    expect(await rowsOf(person.email)).toEqual([]);
  });

  // a state signed by the server itself with the choice, as the start makes one
  it('subscribes on a state of ours that holds the choice', async () => {
    const person = newPerson(provider);

    const { res } = await signInAs(person, {}, (_state, guestId) =>
      craftState(provider, signedNow(guestId, { newsletter: true })),
    );

    expect(landing(res).error).toBeNull();
    expect(await rowsOf(person.email)).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  // only the boolean the start writes counts, whatever else a state could hold
  it.each([['true'], [1], ['yes'], [null], [[true]], [{ yes: true }]])(
    'ignores %j as the choice',
    async (value) => {
      const person = newPerson(provider);

      const { res } = await signInAs(person, {}, (_state, guestId) =>
        craftState(provider, signedNow(guestId, { newsletter: value })),
      );

      expect(landing(res).error).toBeNull();
      expect(await userByEmail(person.email)).not.toBeNull();
      expect(await rowsOf(person.email)).toEqual([]);
    },
  );
});

describe('the language of the subscription a login makes', () => {
  it('takes the language Google gave when the shop answers in it', async () => {
    const person = newPerson('google', 'uk-UA');

    await signInAs(person, { newsletter: 'true' });

    expect(await rowsOf(person.email)).toEqual([expect.objectContaining({ locale: 'uk' })]);
  });

  it('subscribes without a language when the provider gave none', async () => {
    const person = newPerson('github');

    await signInAs(person, { newsletter: 'true' });

    expect(await rowsOf(person.email)).toEqual([expect.objectContaining({ locale: null })]);
  });
});
