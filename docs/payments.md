# Payments: a payment the order could not take

The payment pages and the webhook of the providers are described in [Features](features.md#payments). This page is about the case they cannot settle by themselves: a provider takes the money of a page, and the order cannot take it. The money goes back at once, the buyer is told, and the shop watches the refund until it is sure the money reached the buyer.

## When a payment is "late"

The webhook of the provider records every payment it hears of with the database function `pay_order`. The function answers whether the order can take the money, and the answers that mean it cannot are the reasons of the refund:

| Reason                       | What happened                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `OUT_OF_STOCK`               | the reservation of the order was over and some items were no longer in stock                 |
| `ALREADY_PAID_OTHER_PAYMENT` | another payment paid the order already (the buyer paid two pages); the order stays paid      |
| `AMOUNT_MISMATCH`            | the order changed after the page was opened (an item was added), the sum is not the sum paid |
| `ORDER_NOT_PAYABLE`          | the order could not take a payment any more (for example it was cancelled)                   |
| `ORDER_NOT_FOUND`            | the order was deleted by its owner                                                           |

The payment is then refunded **in full**, with one key for the payment (`refund:<payment id>`), so the same event delivered again, or at the same time, makes one refund. The same payment delivered again later does not sell the order: the webhook answers `200` with `skipped: REFUNDED`. The page the buyer returns to tells it too (`order.paymentRefunded` of `GET /api/payments/stripe/checkout/sessions/:sessionId`).

## The four states of the refund

Until the refunds have a table of their own, the lines of the admin log are their record (`GET /api/admin/audit-log`, entity `order`, action `OTHER`). A refund is one line `order.refund_late` and the lines that follow it for the same payment:

| State     | Line                        | Written when                                                                                                                                   | The buyer is mailed                        |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `created` | `order.refund_late`         | the refund is made at the provider; the app reads this line to know the payment is refunded already                                            | nothing                                    |
| `sent`    | `order.refund_late_sent`    | the provider tells the money is sent: its first answer to the request was `succeeded`, or its event says so                                    | "We sent your payment back"                |
| `failed`  | `order.refund_late_failed`  | the provider tells the refund failed (`failed`, `canceled`): in its first answer, by its event, or after it was `sent` (the bank sent it back) | "We could not send your payment back"      |
| `outside` | `order.refund_late_outside` | root records that the money went to the buyer another way after the refund failed                                                              | "We sent you money" (how and on which day) |

A pending refund (a card refund takes days at some banks) writes nothing and mails nothing: the buyer is told when the money is sent, not before. The order is `created` until then. There is no mail "the money arrived": the provider does not know when the bank of the card credits it, so the mails say the money was **sent**, and the mail of the money sent promises to write again if anything happens to the refund.

Each line is written **once** for a payment, together with its mail, however many times the provider delivers the event and however many deliveries come at the same time: the changes of the state of one refund wait for each other (a lock on the payment, held to the end of the transaction), and the second finds the line of the first. A mail follows the commit of the line; a mail that cannot be sent is only logged (with the order id, not the address) and the line stays.

### How the end of a refund comes

- **At the request.** The provider answers the refund request with `succeeded`: the line `order.refund_late_sent` is written at once, in the same call that wrote `order.refund_late`. A payment the provider had given back before the app asked (an admin did it in its dashboard) counts as `succeeded`: the buyer has the money.
- **Failed at once.** The provider makes the refund and answers `failed` in the same answer: the line `order.refund_late_failed` is written at once, after `order.refund_late`, the buyer is mailed and the alert `failed_refunds` shows it, as for a failure that comes later. A request the provider refuses without making a refund (a payment the buyer disputes at the bank, where the bank gives the money back) is `PAYMENT_REFUND_FAILED`: the event of the payment is delivered again, and the disputes are followed with the other events of Stripe made outside the app (next in the plan).
- **By the event.** The provider answers `pending`; later it sends `refund.updated` (or `refund.failed`). Stripe events are `refund.updated` with `status: succeeded`, `failed` or `canceled`, and `refund.failed`. A failure arrives twice (both events); the second finds the line of the first.
- **Asked again.** After the line `order.refund_late` is written, a refund whose first answer was `pending` is read again at the provider: the event that ends it may have come before the line was there to find. A provider that cannot be asked at that moment does not fail the payment (the refund is made, `200` is answered); the event that ends the refund comes later, and the alert `refunded_payments_not_sent` covers the rest.
- **Out of order.** An old snapshot that says `succeeded` after the event that says `failed` changes nothing: a refund that failed does not succeed again. A `succeeded` end after the refund was sent changes nothing too.

An event is recognised as the end of a refund of the app when its refund id is the one on the line `order.refund_late`, or its key (`metadata.transfer`, `refund:<payment id>`) names a payment with such a line. The transfers of the statements of return have keys of their own (`refund:<uuid>`) and are settled by the returns ([Returns](returns.md)). A refund made by hand in the dashboard of the provider has neither: it is acknowledged (`200 { "received": true }`) and nothing is done. Telling the shop about such refunds (and about disputes) is a later step of the payments work.

The reason of a failure goes to the line in two forms: `failure`, our word, and `failureText`, the words of the provider (for the shop; the buyer never sees them).

| `failure`          | The provider says                                                                    |
| ------------------ | ------------------------------------------------------------------------------------ |
| `card_unavailable` | `lost_or_stolen_card`, `expired_or_canceled_card`: the card can no longer take money |
| `shop_balance`     | `insufficient_funds`: the balance of the shop at the provider                        |
| `disputed`         | `charge_for_pending_refund_disputed`: the buyer disputed the payment at the bank     |
| `unknown`          | anything else, and `canceled`                                                        |

## The lines of the admin log

The events are in `GET /api/admin/log-events` (`auditLog`) and filter `GET /api/admin/audit-log` (`events=`, comma separated). The actor of the three lines of the system is the buyer (role `USER`, `initiator: system`), the line `order.refund_late_outside` is root's. `changes` always starts with the field `refund`:

| Event                       | `changes[0].new`                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `order.refund_late`         | `initiator`, `reason` (see above), `amount` ("51.00"), `currency`, `provider`, `paymentId`, `refundId` (none when the provider had refunded it) |
| `order.refund_late_sent`    | `initiator`, `provider`, `paymentId`, `refundId`, `amount`, `currency`                                                                          |
| `order.refund_late_failed`  | the same and `failure`, `failureText`, `sentBack` (the money had been sent before)                                                              |
| `order.refund_late_outside` | `initiator: root`, `provider`, `paymentId`, `refundId`, `amount`, `currency`, `method`, `at`; and a second change `note` (the note of root)     |

Every failed refund, of a statement or of a late payment, filters with `events=return.refund_failed,order.refund_late_failed`.

## The alerts

All three are kinds of `GET /api/admin/alerts` for every admin and root ([Features](features.md#admin-and-root-capabilities)): a count, a ready request to a list, subscription, threshold and cases put aside as for the other kinds.

| Kind                         | Counts                                                                                                                                    | Threshold                             | List                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `refunded_payments`          | the lines `order.refund_late` of the last days                                                                                            | 7 days (1 to 365)                     | the admin log, `events=order.refund_late`          |
| `refunded_payments_not_sent` | refunds of late payments made more than the threshold days ago that the provider has told neither sent nor failed                         | 3 days (1 to 365)                     | `GET /api/payments/refunds?state=unsent&to=<time>` |
| `failed_refunds`             | the open statements whose transfer failed, **and** the refunds of late payments that failed and root has not recorded as sent another way | none: it stays until it is dealt with | `GET /api/payments/refunds?state=failed`           |

A late refund that failed stays in `failed_refunds` for as long as it takes: until root records the money (below). The count of an alert is the `total` of its list. A case is put aside by its id (`PUT /api/admin/alerts/dismissals/:kind/:id`): the id of a statement for a transfer, the id of the refund at the provider (`re_…`) for a late payment.

## The list of the refunds that wait

`GET /api/payments/refunds` (admin, root). Query: `state` (required: `failed` or `unsent`), `userId`, `orderId`, `to` (only those that came to their state before the time), `limit` (1 to 100, 20 by default), `cursor`. The oldest first; the answer is `{ items, total, limit, nextCursor }` with `total` of the filter.

- `state=failed`: the transfers of the open statements of return whose last try failed (`source: return`, `id` is the statement, see `GET /api/returns/:returnId`) and the refunds of late payments that failed and are not recorded as sent another way (`source: payment`).
- `state=unsent`: the refunds of late payments that are neither sent nor failed.

Each item: `id`, `source`, `orderId`, `userId` (the buyer), `returnId`, `provider`, `paymentId`, `refundId`, `amount` and `currency` (all of the payment, or the sum of the rows of the statement whose transfer failed), `failure`, `failureText`, `at` (when it came to its state: the transfer failed, the refund was made). A bad cursor is `400 CURSOR_INVALID`.

## Root records that the money went another way

When the refund of a late payment fails, the money did not reach the buyer. The shop writes to the buyer (the mail says so), sends the money by hand and records it:

`POST /api/payments/refunds/:refundId/outside` (root only; `:refundId` is the `refundId` of the item of the list, so an order with two late payments is not ambiguous). Body: `method` (`bank_transfer`, `cash`, `other`), `note` (1 to 500 characters, for the shop, never mailed), `at` (the day the money really went, a date-time).

- Only a refund that **failed** and is not recorded yet: otherwise `409 LATE_REFUND_NOT_FAILED` (the refund is made or sent), `409 LATE_REFUND_ALREADY_MARKED` (root recorded it already); two marks at the same time make one line, the second gets the `409`.
- `404 LATE_REFUND_NOT_FOUND`: the app made no refund with this id (one made by hand in the dashboard is none of its refunds).
- `400 LATE_REFUND_OUTSIDE_AT_INVALID`: `at` is of the future (by the clock of the database that dates the lines) or before the refund was made. `400 VALIDATION_ERROR` for a wrong field; `403 INSUFFICIENT_ROLE` for an admin, a buyer or a visitor.

The answer is the refund as it is now: `{ refundId, orderId, userId, provider, paymentId, amount, currency, state: "outside", failure, failureText, outside: { method, note, at, by } }`. The line `order.refund_late_outside` is written once, the refund leaves `failed_refunds` and the list, and the buyer is mailed how much, how and on which day ("We sent it by a bank transfer on 2 November 2026", the day told in the time zone of the shop `SHOP_TIME_ZONE`).

## The mails

All in the language of the buyer's account, English, Ukrainian or Spanish ([Languages](languages.md)), in `src/services/email/templates/orders/`. A deleted account gets none.

| Mail                        | Subject (English)                                 | Says                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderPaymentRefunded`      | We sent your payment for order #42 back           | the sum, why in words (the table of the reasons), that the order is not paid (or stays paid with the other payment), that the bank shows the money in a few days, and that the shop writes if anything happens to the refund           |
| `orderPaymentRefundFailed`  | We could not send your payment back for order #42 | the sum, why in words (a card that can no longer take money, or a general line for the other reasons), when the money had been sent: the bank sent it back; the shop will write about another way, and the buyer may write to the shop |
| `orderPaymentRefundOutside` | We sent you money for order #42                   | the sum, how (a bank transfer, cash, another way) and on which day                                                                                                                                                                     |

The money mails of the statements of return say "sent" in the same way (`returnRefunded`: "Money sent for order #42", `returnClosed`: "We sent you €10.00."); see [Returns](returns.md).

## A walk through a refund that fails

1. The buyer pays the page of a reservation that is over. The webhook answers `200`, the refund is made (`order.refund_late`); Stripe keeps it pending, so the buyer hears nothing.
2. Stripe tells the refund failed (`refund.failed`). `order.refund_late_failed` is written, the buyer is mailed that the shop could not send the payment back and will write about another way.
3. An admin sees `failed_refunds` in the alerts, opens its list (`GET /api/payments/refunds?state=failed`) and finds the refund with its `refundId`, the sum and the reason. The journal shows the line with `events=return.refund_failed,order.refund_late_failed`.
4. The admin and the buyer agree on a way; the money is sent by hand. Root records it: `POST /api/payments/refunds/:refundId/outside` with the way, a note and the day.
5. The refund leaves the alert and the list, `order.refund_late_outside` is in the journal, and the buyer is mailed that the money was sent.

A refund that stays pending for days shows in `refunded_payments_not_sent` once it is older than the threshold: look at it at the provider.
