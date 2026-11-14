// the providers of accounts a person can sign in with (a login by an account of theirs elsewhere,
// OAuth); every one of them has its routes, /api/auth/oauth/<name> and /api/auth/<name>/callback.
// No client here, the schemas and the journals read it
export const IDENTITY_PROVIDER_NAMES = ['google', 'github', 'linkedin'] as const;

export type IdentityProviderName = (typeof IDENTITY_PROVIDER_NAMES)[number];
