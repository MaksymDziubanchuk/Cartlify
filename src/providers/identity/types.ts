import type { AuthProvider } from '@prisma/client';

import type { Provider } from '../provider.js';

import type { IdentityProviderName } from './names.js';
import type { OAuthState } from './state.js';

// the person a provider of accounts vouches for, the way the login of the shop takes it
export type IdentityPerson = {
  // the id of the account at the provider, which the account of the shop is linked by
  sub: string;
  // the address as the provider gives it, and whether the provider has proven it is the person's
  email: string;
  emailVerified: boolean;
  name: string | null;
  // the address of the picture of the account at the provider, if it has one
  avatarUrl: string | null;
  // the language the provider says, as it says it; the login keeps it only when the shop answers in it
  locale: string | null;
};

// What the login of the shop asks of a provider of accounts (src/routes/api/auth/services/
// oauth.service.ts). How the provider does it (its addresses, its tokens, the way it tells the
// person) is its own. A refusal of the provider is an error in our words: OAUTH_TOKEN_EXCHANGE_FAILED,
// OAUTH_NO_ID_TOKEN, OAUTH_NO_ACCESS_TOKEN, OAUTH_FETCH_USER_FAILED, OAUTH_FETCH_EMAILS_FAILED (401),
// OAUTH_PROVIDER_UNAVAILABLE (503) when it cannot be reached; a setting it lacks is a server error
export interface IdentityProvider extends Provider<IdentityProviderName> {
  // the provider of the account in the database (users.authProvider)
  authProvider: Exclude<AuthProvider, 'LOCAL'>;
  // the address the browser of a guest goes to, with the state of the login (state.ts)
  startUrl(guestId: string, accepted: readonly number[], newsletter: boolean): string;
  // the state that came back with the callback, checked with the secret of the provider
  readState(state: string, guestId: string): OAuthState;
  // the person the code of the callback names
  readPerson(code: string, state: string): Promise<IdentityPerson>;
  // the address the picture of the account is downloaded from, at the size given: https on a host
  // of the provider only, null for any other address
  pictureUrl(raw: string, size: number): URL | null;
}
