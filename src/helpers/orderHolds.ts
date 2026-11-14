// what keeps a paid order from its sending (orders.holds, its form is db/06 orders_holds_chk): a
// dispute of its payment, a refund made by hand in the dashboard of the provider that root has not
// decided on, an early warning of fraud and a review of the payment by the provider. The functions of
// the database that follow the provider put and take away each, root decides on the ones that are
// its; the guard of orders refuses the step to shipped while one is there (ORDER_ON_HOLD)
export const ORDER_HOLD_REASONS = [
  'dispute',
  'hand_refund',
  'fraud_warning',
  'payment_review',
] as const;

export type OrderHoldReason = (typeof ORDER_HOLD_REASONS)[number];

// a hold as the database keeps it: since when (iso text in utc) and what put it (the id of the
// dispute or of the line of the refund by hand, the id of the warning or of the review at the
// provider)
export type OrderHold = { reason: OrderHoldReason; since: string; ref: string | number };

// the holds of a row: a list the database checks the form of
export const holdsOf = (value: unknown): OrderHold[] =>
  Array.isArray(value) ? (value as OrderHold[]) : [];

// the reasons that hold an order, each once, in the order they came
export const holdReasonsOf = (value: unknown): OrderHoldReason[] => [
  ...new Set(holdsOf(value).map((hold) => hold.reason)),
];
