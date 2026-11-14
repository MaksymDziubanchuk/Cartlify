import { InternalError } from '@utils/errors.js';

import { githubProvider } from './github/github.provider.js';
import { googleProvider } from './google/google.provider.js';
import { linkedinProvider } from './linkedin/linkedin.provider.js';
import { IDENTITY_PROVIDER_NAMES, type IdentityProviderName } from './names.js';

import type { AuthProvider } from '@prisma/client';
import type { IdentityProvider } from './types.js';

export * from './names.js';
export * from './state.js';
export type * from './types.js';

// every provider of accounts a person can sign in with; each has its own routes, a person picks one
const providers: readonly IdentityProvider[] = [googleProvider, githubProvider, linkedinProvider];

// the list the schemas take the names from is the list of the providers themselves
if (
  providers.length !== IDENTITY_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== IDENTITY_PROVIDER_NAMES[i])
) {
  throw new Error('IDENTITY_PROVIDER_NAMES must name the providers of accounts in the same order');
}

export const identityProviders = providers;

export function getIdentityProvider(name: IdentityProviderName): IdentityProvider {
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider)
    throw new InternalError({ reason: 'OAUTH_PROVIDER_NOT_AVAILABLE', provider: name });
  return provider;
}

// the provider of an account of the database (users.authProvider); none for a local account
export function identityProviderOf(authProvider: AuthProvider): IdentityProvider | null {
  return providers.find((provider) => provider.authProvider === authProvider) ?? null;
}
