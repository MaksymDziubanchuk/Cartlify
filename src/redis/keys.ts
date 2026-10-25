export const redisKeys = {
  orderTimeoutZset: 'queue:orders:confirm-timeouts',
  orderTimeoutBaseZset: 'queue:orders:confirm-timeouts:base',
  orderPaymentSessionMap: 'queue:orders:payment-session-map',
  // when the app last closed the page of an order to open one at another provider; part of the
  // idempotency key of the next page, so a provider never gives a closed page back as open
  orderPaymentPageClosedAtMap: 'queue:orders:payment-page-closed-at',
  // the cases of alerts an admin or root put aside, a hash of each: <prefix><user id>
  adminAlertDismissalsPrefix: 'admin:alerts:dismissed:',
} as const;
