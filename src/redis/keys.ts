export const redisKeys = {
  orderTimeoutZset: 'queue:orders:confirm-timeouts',
  orderTimeoutBaseZset: 'queue:orders:confirm-timeouts:base',
  orderPaymentSessionMap: 'queue:orders:payment-session-map',
  // when the app last closed the page of an order to open one at another provider; part of the
  // idempotency key of the next page, so a provider never gives a closed page back as open
  orderPaymentPageClosedAtMap: 'queue:orders:payment-page-closed-at',
  // the cases of alerts an admin or root put aside, a hash of each: <prefix><user id>
  adminAlertDismissalsPrefix: 'admin:alerts:dismissed:',
  // a chat the bot could not answer for a customer who may talk to an admin: the mark lets the
  // customer call an admin by the button; <prefix><thread id>
  chatAdminCallPrefix: 'chat:admin-call:',
  // held by the one pass of the newsletters that is running (src/jobs/newsletterPass.job.ts)
  newsletterPassLock: 'lock:newsletters:pass',
  // the last time a pass of the newsletters stopped on a problem of the whole stream, until a pass
  // goes through (src/routes/api/newsletters/services/helpers/sendingHalt.helper.ts)
  newsletterSendingHalt: 'newsletters:sending-halt',
} as const;
