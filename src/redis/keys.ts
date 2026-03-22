export const redisKeys = {
  orderTimeoutZset: 'queue:orders:confirm-timeouts',
  orderTimeoutBaseZset: 'queue:orders:confirm-timeouts:base',
} as const;
