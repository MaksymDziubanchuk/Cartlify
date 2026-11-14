import { BadRequestError } from '@utils/errors.js';

import { pictureAddressOf } from '../picture.js';

import {
  buildGithubAuthUrl,
  exchangeGithubCodeForTokens,
  fetchGithubEmails,
  fetchGithubUser,
  pickBestGithubEmail,
  verifyGithubOAuthState,
} from './githubOAuth.js';

import type { IdentityProvider } from '../types.js';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// a login with a GitHub account: the code gives an access token, which reads the profile and the
// addresses of the account; an address counts as proven when GitHub marks it verified
export const githubProvider: IdentityProvider = {
  name: 'github',
  label: 'GitHub',
  authProvider: 'GITHUB',

  startUrl: buildGithubAuthUrl,
  readState: verifyGithubOAuthState,

  async readPerson(code, state) {
    const tokens = await exchangeGithubCodeForTokens(code, state);
    if (!tokens.access_token) throw new BadRequestError('OAUTH_NO_ACCESS_TOKEN');

    const user = await fetchGithubUser(tokens.access_token);
    const emails = await fetchGithubEmails(tokens.access_token);

    const email = (pickBestGithubEmail(user, emails) ?? '').trim().toLowerCase();

    return {
      sub: String(user.id ?? '').trim(),
      email,
      emailVerified: emails.some(
        (item) => item.verified === true && item.email.trim().toLowerCase() === email,
      ),
      name: text(user.name),
      avatarUrl: text(user.avatar_url),
      locale: null,
    };
  },

  // the pictures are on avatars.githubusercontent.com, the size in the query
  pictureUrl(raw, size) {
    const url = pictureAddressOf(raw, (host) => host === 'avatars.githubusercontent.com');
    url?.searchParams.set('s', String(size));
    return url;
  },
};
