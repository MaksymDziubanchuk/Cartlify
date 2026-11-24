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
  // the prices of the carriers of the delivery provider for a parcel to an address, five minutes:
  // <prefix><hash of the address, the box and the value>
  deliveryQuotePrefix: 'delivery:quote:',
  // when the delivery provider first failed to answer after its last answer (the alert
  // delivery_provider_down)
  deliveryProviderDownSince: 'delivery:provider-down-since',
  // when it last failed to answer: an hour with no call after it and the alert says nothing
  deliveryProviderDownLast: 'delivery:provider-down-last',
  // the tax (src/routes/api/admin/services/helpers/taxAlerts.helper.ts): the thresholds that stopped
  // sales in their period, a hash; the orders refused within the limit of a parcel, a count a country
  // a day (<prefix><country>:<yyyy-mm-dd>), counted while the mark is there; what a person saw of a
  // kind of alert that only informs, a hash of each (<prefix><user id>)
  taxSalesStopped: 'tax:sales-stopped',
  taxParcelRefusalsPrefix: 'tax:parcel-refusals:',
  taxParcelRefusalsOn: 'tax:parcel-refusals:on',
  adminAlertSeenPrefix: 'admin:alerts:seen:',
} as const;
