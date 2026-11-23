// the providers of the tax of a cart this server has; TAX_PROVIDER names the one it counts with.
// Kept apart from the providers themselves, the settings and the tests read it
export const TAX_PROVIDER_NAMES = ['own'] as const;

export type TaxProviderName = (typeof TAX_PROVIDER_NAMES)[number];
