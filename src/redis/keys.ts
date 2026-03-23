export const redisKeys = {
  orderTimeoutZset: 'queue:orders:confirm-timeouts',
  orderTimeoutBaseZset: 'queue:orders:confirm-timeouts:base',
  orderPaymentSessionMap: 'queue:orders:payment-session-map',
} as const;
