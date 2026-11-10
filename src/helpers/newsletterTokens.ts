import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import env from '@config/env.js';
import { hashToken } from '@helpers/tokenHash.js';
import { InternalError } from '@utils/errors.js';

// How long the link of a confirmation mail lives. The database decides it (a request that waits
// longer than this is removed, cartlify.newsletter_confirm refuses it): the number here only tells
// the person in the mail, keep both in step
export const NEWSLETTER_CONFIRM_DAYS = 3;

// The tokens of the newsletters, made here and kept by the database only as hashes, and the HMAC of
// an address for the blocklist. Two secrets, never mixed up: NEWSLETTER_LINK_SECRET makes the tokens
// of the links of a subscription (the page "Manage the subscription" and the unsubscribe button of the
// mail clients), NEWSLETTER_BLOCK_SECRET the HMAC of a blocked address. Both are random bytes in
// base64url or base64 (src/config/env.ts), the bytes are the key

function keyOf(secret: string, name: 'NEWSLETTER_LINK_SECRET' | 'NEWSLETTER_BLOCK_SECRET'): Buffer {
  if (!secret) throw new InternalError({ reason: `${name}_REQUIRED` });
  return Buffer.from(secret, 'base64');
}

// the token of the link "This is not me" and of the confirmation, one for both buttons of the mail:
// random, and the database keeps only the hash
export function makeConfirmToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

// the random salt of a subscription row; the token of its management link is derived from it
export function makeManageSalt(): string {
  return randomBytes(32).toString('base64url');
}

// The token of the link "Manage the subscription" of a subscription, built from the salt of its row
// every time a mail needs it: the database keeps the salt and the hash of the token, never the
// token, and a copy of it without NEWSLETTER_LINK_SECRET opens no link. The same salt always gives
// the same token
export function manageTokenOf(salt: string): string {
  if (!salt) throw new InternalError({ reason: 'NEWSLETTER_SALT_REQUIRED' });

  return createHmac('sha256', keyOf(env.NEWSLETTER_LINK_SECRET, 'NEWSLETTER_LINK_SECRET'))
    .update(salt)
    .digest('base64url');
}

// The mark of the unsubscribe token: it is signed with the salt, so the token of the unsubscribe and
// the token of the page of management of one subscription are two different values, and the one that
// sits in the header of every mail (and shows in the logs of the proxies and of the mail clients)
// opens the unsubscribe and nothing else
const UNSUBSCRIBE_MARK = ':unsubscribe';

// The token of the unsubscribe button of the mail clients (the header List-Unsubscribe) of a
// subscription, built from the salt of its row every time a mail needs it, like manageTokenOf but with
// its own mark: HMAC-SHA256(NEWSLETTER_LINK_SECRET, salt + ':unsubscribe'). The database keeps the
// sha256 of it (the column unsubscribeHash) and finds the subscription by it in
// cartlify.newsletter_unsubscribe_one_click, which can end the subscription and do nothing more
export function unsubscribeTokenOf(salt: string): string {
  if (!salt) throw new InternalError({ reason: 'NEWSLETTER_SALT_REQUIRED' });

  return createHmac('sha256', keyOf(env.NEWSLETTER_LINK_SECRET, 'NEWSLETTER_LINK_SECRET'))
    .update(`${salt}${UNSUBSCRIBE_MARK}`)
    .digest('base64url');
}

// what the database finds the subscription by (the same hash as of a confirmation token)
export function manageHashOf(token: string): string {
  return hashToken(token);
}

// whether a token is the one of this salt, in constant time: for a check after the row is read
export function manageTokenMatches(token: string, salt: string): boolean {
  const given = Buffer.from(token);
  const expected = Buffer.from(manageTokenOf(salt));

  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The address as the database writes it into a subscription: lower(btrim(email)). btrim cuts spaces
// and nothing else (a tab or a line break stays, the api never lets one in), and the addresses the
// api takes are ASCII, where lower() and toLowerCase() agree. The address a subscription keeps is this
// text; the HMAC of the blocklist is made from a shorter one (blocklistAddressOf), cut from this
export function normalizeEmail(email: string): string {
  let start = 0;
  let end = email.length;
  while (start < end && email[start] === ' ') start += 1;
  while (end > start && email[end - 1] === ' ') end -= 1;

  return email.slice(start, end).toLowerCase();
}

// Gmail delivers a.n.n.a@gmail.com and anna@gmail.com to the same mailbox, and googlemail.com is the
// same service under its old name
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// The address the blocklist knows a person by: the address as normalizeEmail gives it, cut down to
// the mailbox. A +tag is a way to write the same mailbox on every provider that has them, so it is cut
// for every domain (from the first +, when something stands before it); Gmail also ignores the dots of
// the name, and googlemail.com is gmail.com. A person who declined a mail, or an address an admin
// blocked, must stay blocked when typed another way (a+1@x.com for a@x.com). The subscription keeps
// the address as typed; only the key of the blocklist is cut. A text with no @ or no name before it is
// left as it is: it is no address, and the api never lets one in
export function blocklistAddressOf(email: string): string {
  const address = normalizeEmail(email);
  const at = address.lastIndexOf('@');
  if (at < 1) return address;

  let name = address.slice(0, at);
  let domain = address.slice(at + 1);
  if (!domain) return address;

  const plus = name.indexOf('+');
  if (plus > 0) name = name.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    name = name.replaceAll('.', '');
    domain = 'gmail.com';
  }

  return `${name}@${domain}`;
}

// the entry of the blocklist for an address: HMAC-SHA256 of the address of the blocklist
// (blocklistAddressOf) with NEWSLETTER_BLOCK_SECRET, as hex. Every use of an address against the
// blocklist goes through this one: the form, the decline of a mail, the admin who blocks or looks an
// address up. Without the secret a copy of the database tells nothing about which known address is
// blocked
export function emailHmacOf(email: string): string {
  return createHmac('sha256', keyOf(env.NEWSLETTER_BLOCK_SECRET, 'NEWSLETTER_BLOCK_SECRET'))
    .update(blocklistAddressOf(email))
    .digest('hex');
}
