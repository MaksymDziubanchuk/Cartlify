import env from '@config/env.js';
import { BadRequestError } from '@utils/errors.js';

import { verifyOidcIdToken } from '../oidc.js';
import { pictureAddressOf } from '../picture.js';

import {
  buildGoogleAuthUrl,
  exchangeGoogleCodeForTokens,
  verifyGoogleOAuthState,
  type GoogleIdTokenPayload,
} from './googleOAuth.js';

import type { IdentityProvider } from '../types.js';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// a login with a Google account: the code gives an id token, signed by Google, which tells the person
export const googleProvider: IdentityProvider = {
  name: 'google',
  label: 'Google',
  authProvider: 'GOOGLE',

  startUrl: buildGoogleAuthUrl,
  readState: verifyGoogleOAuthState,

  async readPerson(code) {
    const tokens = await exchangeGoogleCodeForTokens(code);
    if (!tokens.id_token) throw new BadRequestError('OAUTH_NO_ID_TOKEN');

    const idp = await verifyOidcIdToken<GoogleIdTokenPayload>(tokens.id_token, {
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
    });

    return {
      sub: (idp.sub ?? '').trim(),
      email: idp.email ?? '',
      emailVerified: idp.email_verified === true,
      name: text(idp.name),
      avatarUrl: text(idp.picture),
      locale: typeof idp.locale === 'string' ? idp.locale : null,
    };
  },

  // the pictures are on googleusercontent.com, the size at the end of the path (=s96-c by default)
  pictureUrl(raw, size) {
    const url = pictureAddressOf(raw, (host) => host.endsWith('.googleusercontent.com'));
    if (url) url.pathname = url.pathname.replace(/=s\d+(-c)?$/, `=s${size}-c`);
    return url;
  },
};
