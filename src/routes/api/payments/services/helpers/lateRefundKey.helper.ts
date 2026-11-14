import { InternalError } from '@utils/errors.js';

// The key of the request of the refund of a payment the order could not take. The provider keeps
// it as the key of its idempotency and in the metadata of the refund (refund:<payment id>), so the
// same request asked again, by a repeated event or by the worker, is the one refund. A refund of what
// is left after money went back another way (by hand in the dashboard of the provider, a dispute the
// shop lost) names the cents left: it is a new request, never the first one again
export const lateRefundKeyOf = (paymentId: string, leftCents?: number): string =>
  leftCents === undefined ? `refund:${paymentId}` : `refund:${paymentId}:${leftCents}`;

// a sum the app writes (digits with up to two decimals, signed below 0) in cents, without float
// math: 10.15 * 100 is 1014.9999999999999
export function centsOfAmount(amount: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new InternalError({ reason: 'MONEY_AMOUNT_INVALID', amount });

  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}
