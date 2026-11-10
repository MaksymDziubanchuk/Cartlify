import { describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { normalizeEmail } from '@helpers/newsletterTokens.js';

// The HMAC of the blocklist is made in the app from the normalized address, while the database
// writes the address of a subscription as lower(btrim(email)) (cartlify.newsletter_request and the
// other functions). If the two rules ever differ, a blocked address would hash one way and be stored
// another, and the block would not find it. The api takes ASCII addresses only (validateEmail), so
// the cases are ASCII, with every kind of space and line break that could come around one

const CASES = [
  'anna@example.com',
  'Anna@Example.COM',
  'ANNA@EXAMPLE.COM',
  '  anna@example.com',
  'anna@example.com  ',
  '   Anna@Example.com   ',
  ' ',
  '     ',
  '',
  'a b@example.com',
  ' a  b @example.com ',
  '\tanna@example.com',
  'anna@example.com\n',
  'anna@example.com\r\n',
  ' \tAnna@example.com\t ',
  ' anna@example.com',
  'anna@example.com ',
  'A.N.N.A+News@Example.com',
];

describe('normalizeEmail against the database', () => {
  it.each(CASES.map((raw) => [JSON.stringify(raw), raw] as const))(
    'writes %s as lower(btrim()) does',
    async (_name, raw) => {
      const rows = await prisma.$queryRawUnsafe<{ normalized: string }[]>(
        'select lower(btrim($1::text)) as normalized',
        raw,
      );

      expect(normalizeEmail(raw)).toBe(rows[0]!.normalized);
    },
  );
});
