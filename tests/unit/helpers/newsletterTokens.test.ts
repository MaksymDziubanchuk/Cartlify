import { createHash, createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import {
  blocklistAddressOf,
  emailHmacOf,
  makeConfirmToken,
  makeManageSalt,
  manageHashOf,
  manageTokenMatches,
  manageTokenOf,
  normalizeEmail,
  unsubscribeTokenOf,
} from '@helpers/newsletterTokens.js';
import { hashToken } from '@helpers/tokenHash.js';

import { thrownBy } from '../../helpers/errors.js';

// the secrets of the tests as the app has them (tests/setup/isolateEnv.ts), put back after a test
// that changes one of them
const LINK_SECRET = env.NEWSLETTER_LINK_SECRET;
const BLOCK_SECRET = env.NEWSLETTER_BLOCK_SECRET;

afterEach(() => {
  env.NEWSLETTER_LINK_SECRET = LINK_SECRET;
  env.NEWSLETTER_BLOCK_SECRET = BLOCK_SECRET;
});

const OTHER_SECRET = Buffer.from('another-secret-of-more-than-thirty-two-bytes').toString(
  'base64url',
);

// the same computation, written out here: the bytes of the secret are the key
const hmacOf = (secret: string, text: string, encoding: 'hex' | 'base64url') =>
  createHmac('sha256', Buffer.from(secret, 'base64')).update(text).digest(encoding);

describe('makeConfirmToken', () => {
  it('is a url-safe string of at least 32 random bytes', () => {
    const { token } = makeConfirmToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('gives the sha-256 of the token as hex, the only thing the database keeps', () => {
    const { token, hash } = makeConfirmToken();

    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('never repeats', () => {
    const made = Array.from({ length: 200 }, () => makeConfirmToken());

    expect(new Set(made.map((one) => one.token)).size).toBe(200);
    expect(new Set(made.map((one) => one.hash)).size).toBe(200);
  });
});

describe('makeManageSalt', () => {
  // the table takes a salt of 16 to 128 characters
  it('is a url-safe string of at least 32 random bytes, inside what the table takes', () => {
    const salt = makeManageSalt();

    expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(salt, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(salt.length).toBeGreaterThanOrEqual(16);
    expect(salt.length).toBeLessThanOrEqual(128);
  });

  it('never repeats', () => {
    expect(new Set(Array.from({ length: 200 }, makeManageSalt)).size).toBe(200);
  });
});

describe('manageTokenOf', () => {
  it('is the HMAC-SHA256 of the salt with the link secret, as base64url', () => {
    const salt = makeManageSalt();

    expect(manageTokenOf(salt)).toBe(hmacOf(LINK_SECRET, salt, 'base64url'));
    expect(manageTokenOf(salt)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // the link in every mail of a subscription is built again from the salt of its row
  it('gives the same token for the same salt, every time', () => {
    const salt = makeManageSalt();

    expect(manageTokenOf(salt)).toBe(manageTokenOf(salt));
    expect(manageTokenOf('a-fixed-salt-of-the-tests')).toBe(
      manageTokenOf('a-fixed-salt-of-the-tests'),
    );
  });

  it('gives another token for another salt', () => {
    expect(manageTokenOf('salt-one-of-the-tests')).not.toBe(manageTokenOf('salt-two-of-the-tests'));
  });

  it('does not show the salt', () => {
    const salt = makeManageSalt();

    expect(manageTokenOf(salt)).not.toContain(salt);
  });

  it('gives another token with another link secret', () => {
    const salt = makeManageSalt();
    const before = manageTokenOf(salt);

    env.NEWSLETTER_LINK_SECRET = OTHER_SECRET;

    expect(manageTokenOf(salt)).not.toBe(before);
    expect(manageTokenOf(salt)).toBe(hmacOf(OTHER_SECRET, salt, 'base64url'));
  });

  it('refuses a salt that is empty', () => {
    expect(thrownBy(() => manageTokenOf(''))).toMatchObject({
      details: { reason: 'NEWSLETTER_SALT_REQUIRED' },
    });
  });

  it('stops without the link secret, naming it and no value', () => {
    env.NEWSLETTER_LINK_SECRET = '';

    expect(thrownBy(() => manageTokenOf(makeManageSalt()))).toMatchObject({
      statusCode: 500,
      details: { reason: 'NEWSLETTER_LINK_SECRET_REQUIRED' },
    });
  });
});

// the token of the button of the mail client is made from the same salt and the same secret as the
// token of the page of management, with its own mark, so the two never meet
describe('unsubscribeTokenOf', () => {
  it('is the HMAC-SHA256 of the salt and the mark of the unsubscribe with the link secret, as base64url', () => {
    const salt = makeManageSalt();

    expect(unsubscribeTokenOf(salt)).toBe(hmacOf(LINK_SECRET, `${salt}:unsubscribe`, 'base64url'));
    expect(unsubscribeTokenOf(salt)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is not the token of the page of management of the same salt', () => {
    const salt = makeManageSalt();

    expect(unsubscribeTokenOf(salt)).not.toBe(manageTokenOf(salt));
    expect(manageHashOf(unsubscribeTokenOf(salt))).not.toBe(manageHashOf(manageTokenOf(salt)));
  });

  it('gives the same token for the same salt, every time: a mail is built again from the row', () => {
    const salt = makeManageSalt();

    expect(unsubscribeTokenOf(salt)).toBe(unsubscribeTokenOf(salt));
  });

  it('gives another token for another salt', () => {
    expect(unsubscribeTokenOf('salt-one-of-the-tests')).not.toBe(
      unsubscribeTokenOf('salt-two-of-the-tests'),
    );
  });

  it('does not show the salt, nor lead to the token of management', () => {
    const salt = makeManageSalt();

    expect(unsubscribeTokenOf(salt)).not.toContain(salt);
    // the mark is part of what is signed: the token of a salt that ends in the mark is a third one
    expect(unsubscribeTokenOf(`${salt}:unsubscribe`)).not.toBe(manageTokenOf(salt));
    expect(manageTokenOf(`${salt}:unsubscribe`)).toBe(unsubscribeTokenOf(salt));
  });

  it('is the sha-256 hash of it that the database keeps, the same way as of the other tokens', () => {
    const token = unsubscribeTokenOf(makeManageSalt());

    expect(manageHashOf(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('gives another token with another link secret', () => {
    const salt = makeManageSalt();
    const before = unsubscribeTokenOf(salt);

    env.NEWSLETTER_LINK_SECRET = OTHER_SECRET;

    expect(unsubscribeTokenOf(salt)).not.toBe(before);
    expect(unsubscribeTokenOf(salt)).toBe(hmacOf(OTHER_SECRET, `${salt}:unsubscribe`, 'base64url'));
  });

  it('refuses a salt that is empty', () => {
    expect(thrownBy(() => unsubscribeTokenOf(''))).toMatchObject({
      details: { reason: 'NEWSLETTER_SALT_REQUIRED' },
    });
  });

  it('stops without the link secret, naming it and no value', () => {
    env.NEWSLETTER_LINK_SECRET = '';

    expect(thrownBy(() => unsubscribeTokenOf(makeManageSalt()))).toMatchObject({
      statusCode: 500,
      details: { reason: 'NEWSLETTER_LINK_SECRET_REQUIRED' },
    });
  });

  it('is not made with the secret of the blocklist', () => {
    const salt = makeManageSalt();
    const before = unsubscribeTokenOf(salt);

    env.NEWSLETTER_BLOCK_SECRET = OTHER_SECRET;

    expect(unsubscribeTokenOf(salt)).toBe(before);
  });
});

describe('manageHashOf', () => {
  it('is the sha-256 of the token as hex, the same hash the database finds the row by', () => {
    const token = manageTokenOf(makeManageSalt());

    expect(manageHashOf(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(manageHashOf(token)).toBe(hashToken(token));
    expect(manageHashOf(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same salt on every call, so a mail can be rebuilt from the row', () => {
    const salt = makeManageSalt();

    expect(manageHashOf(manageTokenOf(salt))).toBe(manageHashOf(manageTokenOf(salt)));
  });

  it('differs between two subscriptions', () => {
    expect(manageHashOf(manageTokenOf(makeManageSalt()))).not.toBe(
      manageHashOf(manageTokenOf(makeManageSalt())),
    );
  });
});

describe('manageTokenMatches', () => {
  it('accepts the token of the salt', () => {
    const salt = makeManageSalt();

    expect(manageTokenMatches(manageTokenOf(salt), salt)).toBe(true);
  });

  it.each([
    ['the token of another salt', () => manageTokenOf(makeManageSalt())],
    ['an empty token', () => ''],
    ['a token cut short', () => manageTokenOf('the-salt-of-the-cut').slice(0, 20)],
    ['a token with a char more', () => `${manageTokenOf('the-salt-of-the-cut')}A`],
    ['the salt itself', () => 'the-salt-of-the-cut'],
  ])('refuses %s', (_case, token) => {
    expect(manageTokenMatches(token(), 'the-salt-of-the-cut')).toBe(false);
  });

  it('refuses when the link secret is not the one that made the token', () => {
    const salt = makeManageSalt();
    const token = manageTokenOf(salt);

    env.NEWSLETTER_LINK_SECRET = OTHER_SECRET;

    expect(manageTokenMatches(token, salt)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  // the database does lower(btrim(email)): case folded, spaces cut at both ends, and only spaces.
  // The api refuses an address with anything else around it, so it never gets here
  it.each([
    ['Anna@Example.COM', 'anna@example.com'],
    ['  anna@example.com  ', 'anna@example.com'],
    ['  ANNA@example.com ', 'anna@example.com'],
    ['anna@example.com', 'anna@example.com'],
    ['A.N.N.A+News@Example.com', 'a.n.n.a+news@example.com'],
    ['', ''],
    ['   ', ''],
  ])('turns %j into %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  // btrim() cuts spaces only: a tab or a line break at the end stays, and so it must here, or an
  // address would hash one way in the app and be stored another in the database
  it.each(['\tanna@example.com', 'anna@example.com\n', 'anna@example.com\r', ' anna@example.com'])(
    'does not cut %j, as btrim does not',
    (raw) => {
      expect(normalizeEmail(raw)).toBe(raw);
    },
  );

  it('does not cut spaces inside the address', () => {
    expect(normalizeEmail('anna @example.com')).toBe('anna @example.com');
  });
});

// The address the blocklist knows a person by. A person who declined a mail (or whom an admin blocked)
// must stay blocked when they type the address another way: a +tag is the same mailbox on every
// provider that has them, and Gmail ignores the dots of the name and treats googlemail.com as
// gmail.com. The subscription itself keeps the address as typed (normalizeEmail); only the key of the
// blocklist is cut down
describe('blocklistAddressOf', () => {
  it.each([
    ['anna@example.com', 'anna@example.com'],
    ['Anna@Example.COM', 'anna@example.com'],
    ['  anna@example.com  ', 'anna@example.com'],
    // a +tag is cut for every domain, from the first +
    ['anna+news@example.com', 'anna@example.com'],
    ['anna+a+b@example.com', 'anna@example.com'],
    ['ANNA+News@Example.com', 'anna@example.com'],
    ['anna+@example.com', 'anna@example.com'],
    // dots are the name of the mailbox elsewhere
    ['a.nna@example.com', 'a.nna@example.com'],
    ['anna.lee+x@example.com', 'anna.lee@example.com'],
    // gmail ignores dots, and the googlemail.com address is the same mailbox as the gmail.com one
    ['anna@gmail.com', 'anna@gmail.com'],
    ['a.n.n.a@gmail.com', 'anna@gmail.com'],
    ['A.Nna+news@Gmail.com', 'anna@gmail.com'],
    ['anna@googlemail.com', 'anna@gmail.com'],
    ['a.nna+x@googlemail.com', 'anna@gmail.com'],
    // only those two domains: a subdomain or a look-alike is another provider
    ['a.nna@mail.gmail.com', 'a.nna@mail.gmail.com'],
    ['a.nna@gmail.com.example.org', 'a.nna@gmail.com.example.org'],
    ['a.nna@notgmail.com', 'a.nna@notgmail.com'],
    ['a.nna@gmail.co', 'a.nna@gmail.co'],
  ])('turns %j into %j', (raw, expected) => {
    expect(blocklistAddressOf(raw)).toBe(expected);
  });

  // a +tag cut from the front would leave no name; such a thing is no address, and it is hashed as it is
  it.each(['+tag@example.com', '+@example.com', '+tag@gmail.com'])(
    'leaves %j whole: a name made only of a tag is not cut to nothing',
    (raw) => {
      expect(blocklistAddressOf(raw)).toBe(normalizeEmail(raw));
    },
  );

  it.each(['', '   ', 'no-at-sign', '@example.com', 'anna@', 'anna+tag'])(
    'leaves %j as normalizeEmail gives it',
    (raw) => {
      expect(blocklistAddressOf(raw)).toBe(normalizeEmail(raw));
    },
  );

  it('uses the last @ as the end of the name, as an address with a quoted @ puts it', () => {
    expect(blocklistAddressOf('"a@b"+x@example.com')).toBe('"a@b"@example.com');
  });

  it('is the same cut whatever the case or the spaces the address came in', () => {
    expect(blocklistAddressOf('  A.N.NA+X@GoogleMail.com ')).toBe('anna@gmail.com');
  });
});

describe('emailHmacOf', () => {
  it('is the HMAC-SHA256 of the address of the blocklist with the block secret, as hex', () => {
    expect(emailHmacOf('Anna@Example.com')).toBe(hmacOf(BLOCK_SECRET, 'anna@example.com', 'hex'));
    expect(emailHmacOf('A.nna+x@GMail.com')).toBe(hmacOf(BLOCK_SECRET, 'anna@gmail.com', 'hex'));
    expect(emailHmacOf('Anna@Example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  // the variants a person can type for one mailbox all give the one entry of the blocklist
  it.each([
    ['anna@example.com', 'anna+1@example.com'],
    ['anna@example.com', 'ANNA+news+x@Example.com'],
    ['anna@gmail.com', 'a.n.n.a@gmail.com'],
    ['anna@gmail.com', 'A.nna+deals@gmail.com'],
    ['anna@gmail.com', 'anna@googlemail.com'],
    ['anna@gmail.com', 'an.na+x@GoogleMail.com'],
  ])('gives %j and %j one and the same hash', (one, other) => {
    expect(emailHmacOf(other)).toBe(emailHmacOf(one));
  });

  it.each([
    ['anna@example.com', 'anna@example.org'],
    ['anna@example.com', 'a.nna@example.com'],
    ['anna@example.com', 'ann@example.com'],
    ['anna@gmail.com', 'anna@gmail.org'],
    ['anna@gmail.com', 'anna@example.com'],
    ['anna+x@example.com', 'bob+x@example.com'],
  ])('gives %j and %j two hashes', (one, other) => {
    expect(emailHmacOf(other)).not.toBe(emailHmacOf(one));
  });

  // the same person, however the address was typed
  it.each([
    'anna@example.com',
    'ANNA@EXAMPLE.COM',
    'Anna@Example.com',
    '  anna@example.com',
    'anna@example.com   ',
    '   Anna@EXAMPLE.com   ',
  ])('gives the one hash for %j', (raw) => {
    expect(emailHmacOf(raw)).toBe(emailHmacOf('anna@example.com'));
  });

  it('gives another hash for another address', () => {
    expect(emailHmacOf('anna@example.com')).not.toBe(emailHmacOf('anna2@example.com'));
    expect(emailHmacOf('anna@example.com')).not.toBe(emailHmacOf('anna@example.org'));
  });

  it('keeps what btrim keeps, so an address with a tab is another address', () => {
    expect(emailHmacOf('anna@example.com\t')).not.toBe(emailHmacOf('anna@example.com'));
  });

  it('does not hold the address', () => {
    expect(emailHmacOf('anna@example.com')).not.toContain('anna');
  });

  it('gives another hash with another block secret', () => {
    const before = emailHmacOf('anna@example.com');

    env.NEWSLETTER_BLOCK_SECRET = OTHER_SECRET;

    expect(emailHmacOf('anna@example.com')).not.toBe(before);
    expect(emailHmacOf('anna@example.com')).toBe(hmacOf(OTHER_SECRET, 'anna@example.com', 'hex'));
  });

  it('stops without the block secret, naming it and no value', () => {
    env.NEWSLETTER_BLOCK_SECRET = '';

    expect(thrownBy(() => emailHmacOf('anna@example.com'))).toMatchObject({
      statusCode: 500,
      details: { reason: 'NEWSLETTER_BLOCK_SECRET_REQUIRED' },
    });
  });
});

// a link would open an entry of the blocklist and the other way round: each output is made from its
// own secret and from nothing else
describe('the two secrets', () => {
  it('change only their own output', () => {
    const salt = makeManageSalt();
    const tokenBefore = manageTokenOf(salt);
    const hmacBefore = emailHmacOf('anna@example.com');

    env.NEWSLETTER_BLOCK_SECRET = OTHER_SECRET;
    expect(manageTokenOf(salt)).toBe(tokenBefore);
    expect(emailHmacOf('anna@example.com')).not.toBe(hmacBefore);

    env.NEWSLETTER_BLOCK_SECRET = BLOCK_SECRET;
    env.NEWSLETTER_LINK_SECRET = OTHER_SECRET;
    expect(emailHmacOf('anna@example.com')).toBe(hmacBefore);
    expect(manageTokenOf(salt)).not.toBe(tokenBefore);
  });

  it('are two different secrets in the tests, or this test would prove nothing', () => {
    expect(Buffer.from(LINK_SECRET, 'base64').equals(Buffer.from(BLOCK_SECRET, 'base64'))).toBe(
      false,
    );
  });

  // swapping them by mistake in the code would make both outputs the same kind of thing
  it('give a token that is no hash of an address and a hash that is no token', () => {
    const text = 'anna@example.com';

    expect(manageTokenOf(text)).not.toBe(hmacOf(BLOCK_SECRET, text, 'base64url'));
    expect(emailHmacOf(text)).not.toBe(hmacOf(LINK_SECRET, text, 'hex'));
  });
});
