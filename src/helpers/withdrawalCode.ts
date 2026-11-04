import { createHmac, timingSafeEqual } from 'node:crypto';

import env from '@config/env.js';

import { webPageUrl } from './webOrigin.js';

// The code of withdrawal: the number of an order signed with a secret of the server (HMAC), shown in
// three groups of four (K7QM-4XTP-9RHD). Nothing is kept in the database: the server computes the
// code for any mail and checks one by computing it again. The code proves that the person holds a
// mail the shop sent about the order; it works while the order can be withdrawn from (the caller
// checks that), and it dies only with the secret. The code goes after the # of the link of a mail,
// which a browser keeps to itself, so it is in no log of the server

// 32 symbols, no 0 and O, no 1 and I, which are read as one another
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 12;

// the code of an order, none while the server has no secret
export function withdrawalCodeOf(
  orderId: number,
  secret = env.WITHDRAWAL_CODE_SECRET,
): string | null {
  if (!secret) return null;

  const digest = createHmac('sha256', secret).update(`withdrawal:${orderId}`).digest();

  // 5 bits of each of the first bytes: 32 symbols, so every symbol is as likely as another
  let code = '';
  for (let i = 0; i < LENGTH; i += 1) code += ALPHABET[digest[i]! & 31];

  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

const plain = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

// whether this is the code of the order; false for anything else, also without a secret
export function isWithdrawalCode(
  orderId: number,
  given: unknown,
  secret = env.WITHDRAWAL_CODE_SECRET,
): boolean {
  if (typeof given !== 'string') return false;

  const expected = withdrawalCodeOf(orderId, secret);
  if (!expected) return false;

  const left = Buffer.from(plain(given));
  const right = Buffer.from(plain(expected));

  return left.length === right.length && timingSafeEqual(left, right);
}

// the link of a mail to the page of withdrawal of an order, with the code after the #; without a
// secret the link has no code and the form is checked by hand. With a statement the page opens on it
// (?return=<id>), to write the parcel of the goods it waits for
export function withdrawalLinkOf(orderId: number, returnId?: number): string {
  const page = webPageUrl(env.WEB_PAGE_WITHDRAWAL, {
    id: orderId,
    ...(returnId === undefined ? {} : { query: { return: String(returnId) } }),
  });
  const code = withdrawalCodeOf(orderId);

  return code ? `${page}#${code}` : page;
}
