import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createUser,
  createVerifyToken,
  uniqueEmail,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { arrange, forget, journalOf } from '../../../helpers/newsletterApi.js';
import { answerAsGithub, callback, startLogin } from '../../../helpers/oauth.js';

// The line of consent a subscription made at the registration writes keeps the version of the
// privacy policy in force at that moment (the person agrees to the keeping of the data of that
// version). A version in force is for the whole shop, so the file runs alone (.shopwide.test.ts);
// the rest of the subscription at the registration is in newsletterRegistration.test.ts and
// oauthNewsletter.test.ts

const RETENTION = {
  loginAddressesDays: 90,
  guestDataDays: 180,
  deletedChatsDays: 30,
  returnAddressesDays: 1095,
  returnPersonalDays: 3650,
  recipientDays: 3650,
  newsletterConsentDays: 3650,
  newsletterRecipientsDays: 365,
};

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];
const addresses: string[] = [];

const publishPolicy = async (tag: string) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/root/legal-documents',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: {
      kind: 'privacy',
      title: `Privacy ${tag}`,
      content: `The privacy policy of the shop, ${tag}.`,
      retention: RETENTION,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { version: number };
};

const newAddress = (label: string) => {
  const email = uniqueEmail(label);
  addresses.push(email);
  return email;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
  userIds.push(root.id);
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: addresses } }, select: { id: true } }),
    );
    await closeSessions([...userIds, ...users.map((u) => u.id)]);
    await forget(addresses);
  } finally {
    await stopApp();
  }
});

describe('the privacy policy in the line of consent of a subscription at the registration', () => {
  it('keeps the version in force when the email is verified with the choice', async () => {
    const before = await publishPolicy(uniqueTag());
    const user = await createUser({ email: newAddress('consent-reg'), isVerified: false });
    const token = await createVerifyToken(user.id);

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf),
      payload: { token, newsletter: true },
    });

    expect(first.statusCode).toBe(200);
    expect(await journalOf(user.email)).toEqual([
      expect.objectContaining({
        event: 'subscribed',
        place: 'registration',
        privacyVersion: before.version,
      }),
    ]);
  });

  // a version published later does not rewrite the line the person agreed under
  it('keeps the version of its day when a newer one is published afterwards', async () => {
    const user = await createUser({ email: newAddress('consent-old'), isVerified: false });
    const first = await publishPolicy(uniqueTag());
    const token = await createVerifyToken(user.id);
    await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf),
      payload: { token, newsletter: true },
    });

    const second = await publishPolicy(uniqueTag());

    expect(second.version).toBeGreaterThan(first.version);
    expect((await journalOf(user.email)).map((line) => line.privacyVersion)).toEqual([
      first.version,
    ]);
  });

  it('keeps the version in force for a new account of a login with a provider', async () => {
    const policy = await publishPolicy(uniqueTag());
    const email = newAddress('consent-github');
    answerAsGithub({
      id: Math.floor(Math.random() * 1e9) + 3e9,
      name: 'Consent Test',
      emails: [{ email, primary: true, verified: true }],
    });
    // a new account accepts every version of the terms and of the contract in force, if any is
    const current = await app.inject({ method: 'GET', url: '/api/legal/documents/current' });
    const accepted = (current.json().items as { id: number; kind: string }[])
      .filter((doc) => doc.kind !== 'privacy')
      .map((doc) => doc.id);
    const { guestId, state } = await startLogin(app, 'github', '', {
      newsletter: 'true',
      ...(accepted.length ? { acceptedDocumentIds: accepted.join(',') } : {}),
    });

    const res = await callback(
      app,
      'github',
      { code: 'test-code', state },
      cookieHeader({ guestId }),
    );

    expect(res.statusCode).toBe(302);
    expect(await journalOf(email)).toEqual([
      expect.objectContaining({
        event: 'subscribed',
        place: 'registration',
        privacyVersion: policy.version,
      }),
    ]);
  });

  // an address that is subscribed already gets no new line of consent
  it('writes no new line for an address that is subscribed already', async () => {
    await publishPolicy(uniqueTag());
    const user = await createUser({ email: newAddress('consent-has'), isVerified: false });
    await arrange({ email: user.email, source: 'form' });
    const before = await journalOf(user.email);
    const token = await createVerifyToken(user.id);

    await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf),
      payload: { token, newsletter: true },
    });

    expect(await journalOf(user.email)).toEqual(before);
  });
});
