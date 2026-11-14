import env from '@config/env.js';
import { BadRequestError } from '@utils/errors.js';

import { verifyOidcIdToken } from '../oidc.js';
import { pictureAddressOf } from '../picture.js';

import {
  buildLinkedInAuthUrl,
  exchangeLinkedInCodeForTokens,
  verifyLinkedInOAuthState,
  type LinkedInIdTokenPayload,
} from './linkedinOAuth.js';

import type { IdentityProvider } from '../types.js';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// a login with a LinkedIn account: the code gives an id token, signed by LinkedIn, which tells
// the person; its claim of a verified address comes as a boolean or as the string "true"
export const linkedinProvider: IdentityProvider = {
  name: 'linkedin',
  label: 'LinkedIn',
  authProvider: 'LINKEDIN',

  startUrl: buildLinkedInAuthUrl,
  readState: verifyLinkedInOAuthState,

  async readPerson(code) {
    const tokens = await exchangeLinkedInCodeForTokens(code);
    if (!tokens.id_token) {
      throw new BadRequestError('OAUTH_NO_ID_TOKEN', { stage: 'TOKEN_EXCHANGE' });
    }

    const idp = await verifyOidcIdToken<LinkedInIdTokenPayload>(tokens.id_token, {
      jwksUri: 'https://www.linkedin.com/oauth/openid/jwks',
      issuers: ['https://www.linkedin.com/oauth'],
      audience: env.LINKEDIN_CLIENT_ID,
      algorithms: ['RS256'],
    });

    return {
      sub: (idp.sub ?? '').trim(),
      email: idp.email ?? '',
      emailVerified: idp.email_verified === true || idp.email_verified === 'true',
      name: text(idp.name),
      avatarUrl: text(idp.picture),
      locale: null,
    };
  },

  // the pictures are on media.licdn.com, at the size LinkedIn gives
  pictureUrl(raw) {
    return pictureAddressOf(raw, (host) => host === 'media.licdn.com');
  },
};
