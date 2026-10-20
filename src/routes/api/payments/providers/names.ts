// the payment providers this server takes payments with; a payment page request names one of
// them. Kept apart from the providers themselves (no sdk here), the schemas read it
export const PAYMENT_PROVIDER_NAMES = ['stripe'] as const;

export type AvailablePaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

export function isAvailablePaymentProvider(value: unknown): value is AvailablePaymentProviderName {
  return typeof value === 'string' && (PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value);
}
