// the biggest file a multipart request may carry, in bytes: a bigger one is cut off while it is
// read and the request is answered with 413 PAYLOAD_TOO_LARGE. The swagger names the same number
export const MAX_UPLOAD_SIZE_BYTES = 5_000_000;

// the biggest x-www-form-urlencoded body, in bytes
export const FORM_BODY_LIMIT_BYTES = 1_048_576;

// the smallest order total a payment page takes: Stripe refuses a card payment below 0.50 in EUR
// and USD. The confirmation refuses a smaller total with ORDER_TOTAL_BELOW_MINIMUM before the stock
// is held, the payment page does the same for an order confirmed before that (another
// STRIPE_CURRENCY may have another minimum)
export const MIN_CHECKOUT_TOTAL = 0.5;
