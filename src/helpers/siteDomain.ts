import env from '@config/env.js';
import { InternalError } from '@utils/errors.js';

// domain outside production when SITE_DOMAIN is not set: reserved for examples, mail to it
// is never delivered to anyone
const DEV_SITE_DOMAIN = 'example.com';

// a bare domain name: dot-separated labels of letters, digits and dashes, at least two of them
const DOMAIN_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function resolveSiteDomain(): string | null {
  const raw = env.SITE_DOMAIN.trim().toLowerCase();

  // production without SITE_DOMAIN has no domain of its own, development falls back to example.com
  if (!raw) return env.NODE_ENV === 'production' ? null : DEV_SITE_DOMAIN;

  if (!DOMAIN_NAME.test(raw)) {
    throw new Error(
      'Invalid env variable: SITE_DOMAIN must be a domain name such as shop.example.com, ' +
        'without a scheme, a port or a path',
    );
  }

  return raw;
}

// the domain the site lives on, null in production when SITE_DOMAIN is not set
export const siteDomain: string | null = resolveSiteDomain();

// the domain for addresses the app makes up itself (a deleted account): ours, so a mail that
// still goes to such an address never reaches a domain of someone else.
// A production server without SITE_DOMAIN cannot make one
export function requireSiteDomain(): string {
  if (!siteDomain) throw new InternalError({ reason: 'SITE_DOMAIN_REQUIRED' });

  return siteDomain;
}
