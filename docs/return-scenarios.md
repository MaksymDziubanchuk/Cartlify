# Return scenarios

Each case of a withdrawal or a return, step by step: who does what, with which route, what the buyer is told and what the admins see. The rules behind them, the fields and the states are in [Returns](returns.md); the bodies and the error codes are in Swagger (`/documentation`).

Words used below: the **buyer** is the person of the order; an **admin** is an admin or root; **root** is root only. A **statement** is one withdrawal or return, with its code (`W42-2` for a withdrawal, `R42-2` for a return outside it). Every step of an admin or root goes to the admin log and shows in the history of the card of the statement (`GET /api/returns/:returnId`).

## Contents

| #                                                            | Case                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| [1](#1-the-buyer-withdraws-before-the-order-is-sent)         | The buyer withdraws before the order is sent                   |
| [2](#2-the-buyer-withdraws-after-the-order-was-sent)         | The buyer withdraws after the order was sent                   |
| [3](#3-the-buyer-withdraws-by-the-link-of-a-mail)            | The buyer withdraws by the link of a mail (the code)           |
| [4](#4-a-statement-of-the-form-without-the-code)             | A statement of the form without the code                       |
| [5](#5-the-buyer-states-units-a-form-without-the-code-holds) | The buyer states units a form without the code holds           |
| [6](#6-the-shop-cancels-a-paid-order)                        | The shop cancels a paid order                                  |
| [7](#7-the-buyer-refused-the-parcel)                         | The buyer refused the parcel                                   |
| [8](#8-a-return-outside-the-withdrawal)                      | A return outside the withdrawal (defect, wrong item, goodwill) |
| [9](#9-the-money-before-the-goods)                           | The money before the goods                                     |
| [10](#10-goods-that-come-back-damaged-or-used)               | Goods that come back damaged or used                           |
| [11](#11-goods-that-never-come)                              | Goods that never come                                          |
| [12](#12-the-cost-of-the-way-back)                           | The cost of the way back                                       |
| [13](#13-a-transfer-that-fails)                              | A transfer that fails                                          |
| [14](#14-a-dispute-at-the-bank)                              | A dispute at the bank                                          |
| [15](#15-the-carrier-delivered-earlier)                      | The carrier delivered earlier than the step                    |
| [16](#16-late-statements-and-the-grace)                      | Late statements and the grace                                  |
| [17](#17-a-statement-that-extends-another)                   | A statement that extends another                               |
| [18](#18-the-account-is-deleted-meanwhile)                   | The account is deleted meanwhile                               |
| [19](#19-what-the-admins-watch)                              | What the admins watch                                          |

## 1. The buyer withdraws before the order is sent

The order is `paid` (or a pickup is ready and not collected): the goods are still on the shelf.

1. The order page shows the button while `withdrawalOpen` is true. The buyer picks the items and units (or none: the whole of what is left with the right of withdrawal) and may write why.
2. The page asks for a confirmation with the items and units named: the next step is final.
3. `POST /api/orders/:orderId/withdrawal` (the buyer). The database makes the statement, puts the units back in the stock at once (in the batches they were sold from), and cancels the order when all of it was named. The answer is the order.
4. Right after, the money goes back through the provider in the three steps of a refund. A provider that does not answer leaves it `pending`: the worker and the webhook finish it (see [13](#13-a-transfer-that-fails) for a failure).

The buyer is mailed the notice of the statement (the goods stay with the shop, the money follows), then the end of the statement with the money that went back. The free delivery of the whole order is kept when only part of it was withdrawn: the shop pays it.

## 2. The buyer withdraws after the order was sent

The order is `shipped` (the period has not started) or `delivered` (within the period).

1. `POST /api/orders/:orderId/withdrawal` (the buyer), as in [1](#1-the-buyer-withdraws-before-the-order-is-sent). The statement waits for the parcel: its rows are `expected`.
2. The mail of the statement gives the address to send the goods to, the last day to send them (14 days), who pays the carrier (the contract of the order), and the link of the page of the parcel.
3. The buyer sends the goods and writes the carrier, the number and what they paid the carrier (`buyerPaid`): `POST /api/orders/:orderId/returns/:returnId/proof` from the account, or the page of the link (`POST /api/withdrawals/proof`, with the code).
   When the goods go back in more than one parcel, the buyer names the units of this one (`items`): the units not named go into a statement of their own (`W42-2`), mailed to the buyer, which gets its own parcel the same way. An admin splits a statement the same way from the card: `POST /api/returns/:returnId/split`.
4. An admin follows the parcel. Either:
   - the goods arrive: `POST /api/returns/:returnId/receive` with a result for the units (`to_stock`, `written_off`, `lost`, `not_accepted`, `not_arrived`). A parcel not confirmed yet is confirmed in the same step (`parcel`): what the buyer paid the carrier, from the receipt (`buyerPaid`, 0 without one), or what the shop paid (`cost`); or
   - the proof is enough to pay before the goods arrive: `POST /api/returns/:returnId/proof/confirm` with the same sums, then [9](#9-the-money-before-the-goods).
5. The money: `POST /api/returns/:returnId/refund` (an admin) for the rows whose goods came back (or whose proof is confirmed). Root may lower a sum with a note (`reductions`); the way back may be taken off (see [12](#12-the-cost-of-the-way-back)). The law gives 14 days from the statement; the shop may hold the money until the goods are in or the proof is confirmed.
6. The statement closes by itself when every row has its result; the buyer is mailed the money and the end.

The order stays `delivered` when all of it came back; `returnStatus` says `full`. A shipped order whose statements are all closed with all the money back becomes `cancelled`.

## 3. The buyer withdraws by the link of a mail

For a buyer with a deleted account, or one who is not signed in. The mails of the order carry a link with the code after `#`.

1. The page of the link asks where to send the visitor: `POST /api/withdrawals/route` with the order and the code. `account`: the button of the order (after a login); `form`: the public form; `closed`: the period is over. A buyer whose account is alive may use the form too, without a login.
2. The page shows the units: `POST /api/withdrawals/items` with the order, the code and the name of the recipient. The answer lists the units free to withdraw from (the name and the quantity, no prices), `signIn` when the account is alive.
3. The form: `POST /api/withdrawals` with the same facts, an email for the answers, the units the page showed (all that is left without them) and the words (optional). With a right code the statement is the one of an account (`form_code`): the rest is [1](#1-the-buyer-withdraws-before-the-order-is-sent) or [2](#2-the-buyer-withdraws-after-the-order-was-sent).
4. The mails go to the email of the form, greeted by the name of the form, with no link to the order; the parcel is written on the page of the link (`POST /api/withdrawals/proof`).

Every refusal is the same answer (`WITHDRAWAL_REJECTED`), so the form tells nothing about orders. The number of the order is always needed: a person who has none can still withdraw by a letter or in the chat, which the shop takes as a statement (the contract or the policy says so).

## 4. A statement of the form without the code

Anybody who knows the number of an order and the facts of its recipient can send the form without the code (`form_manual`). Nothing is automatic: no stock and no money move, a paid order is not cancelled.

1. The page shows the units: `POST /api/withdrawals/items` with the number of the order and the facts of the recipient: the name, the phone and, for a delivery to an address, its country and its postal code when the order has one (a pickup: the name and the phone). The spaces and the case do not count, the phone by its digits. The answer is as in [3](#3-the-buyer-withdraws-by-the-link-of-a-mail), and `underReview` says one statement without the code already waits for the check.
2. `POST /api/withdrawals` with the same facts and the units. One statement without the code waits for the check of an admin per order: while it does, another gets `409 WITHDRAWAL_UNDER_REVIEW` (told only once the facts matched; the page explains the answer comes by email and that the link of a mail or the account withdraw at once).
3. The person of the form is mailed that the team checks the statement (no goods named); the account of the order, while it lives, is mailed too, so the buyer learns of a statement they did not make.
4. The alert `returns_manual_check` keeps it in front of the admins. An admin checks it outside the app (writes to the email of the statement, compares with the order). Nothing of it is handled before the check: the goods, the proof, the money, a parcel and the way back are refused with `409 RETURN_NOT_ACCEPTED`.
5. Then either:
   - it is the buyer's: the admin accepts it, `POST /api/returns/:returnId/accept` (the card shows who and when). It leaves the alert, it is handled as in [2](#2-the-buyer-withdraws-after-the-order-was-sent), and the form takes another statement without the code for the units left;
   - it is not: root closes its rows without accepting it, `POST /api/returns/:returnId/close` with `not_buyer` and a note. The form is mailed that the statement could not be matched to a purchase, naming no goods and no account;
   - the buyer states the units themselves: [5](#5-the-buyer-states-units-a-form-without-the-code-holds).

A pickup is checked by the name and the phone only, which more people know than an address: the admin weighs that in the check.

## 5. The buyer states units a form without the code holds

The buyer withdraws from the account or with the code while a statement without the code that no admin accepted yet holds units of the same order.

1. The order shows those units as free (`withdrawable`), and the button takes them.
2. `POST /api/orders/:orderId/withdrawal` or `POST /api/withdrawals` with the code. The database takes the units the new statement needs from the statement without the code, oldest rows first: those rows become `not_arrived` with the money refused and the code `stated_again`. A statement left with nothing is closed by its results; the rest of a partial one stays open for the admin.
3. The person of the statement without the code is mailed that its goods are now handled in another statement of the order, without saying who made it and without the units ("yours is closed" when nothing is left): the person of the form may not be the buyer. The line of the new statement in the admin log names the statements it took units from (`takenFrom`).
4. The new statement goes on as [1](#1-the-buyer-withdraws-before-the-order-is-sent) or [2](#2-the-buyer-withdraws-after-the-order-was-sent).

An accepted statement is the buyer's already: its units are not taken over, and the buyer states only the units left.

A statement of an admin never takes units over: it is refused while they are held (`RETURN_QUANTITY_EXCEEDED`).

## 6. The shop cancels a paid order

The shop cannot send a paid order (no stock, an error of the price, the buyer asked by mail).

1. `POST /api/returns` (an admin) with the order, the items (or all of them), `basis: other` and `reason: shop_cancel`. There is no other route that cancels an order.
2. The goods go back to the stock at once, the order is `cancelled` when all of it is back, and the money goes back at once through the provider: the money journal gets the transfer in its parts (the goods, and the delivery when the order is whole), in transit, then sent when Stripe tells it (`GET /api/admin/money-log?orderId=`).
3. The buyer is mailed that the shop registered the return, then the money.

A transfer that cannot start now (a dispute of the payment is open, a refund made by hand waits for root) leaves the order cancelled and the goods back: the rows wait with their money not refunded, and the card of the statement says why (`disputeOpen`, `handRefundPending`).

The same cancel comes from a decision of root on an order something holds (`POST /api/orders/:orderId/holds/hand_refund/decision` or `/fraud_warning/decision` with `cancel`): the statement is root's `shop_cancel` on all that is left, money already given back by hand counts for it, the rest goes through Stripe. Without anybody, the app cancels a paid order not sent by a statement of its own when the bank decided a dispute for the buyer ([14](#14-a-dispute-at-the-bank)) or the whole payment went back by hand in the dashboard of Stripe ([Payments](payments.md#a-refund-made-by-hand-in-the-dashboard-of-stripe)).

## 7. The buyer refused the parcel

The order was sent and the parcel comes back to the shop unopened.

1. `POST /api/returns` (an admin) with `basis: withdrawal` and `reason: refused`: the statement takes whatever is left of the order and waits for the parcel, whatever the rules of withdrawal of the items.
2. The parcel arrives: `POST /api/returns/:returnId/receive` with the parcel that came back (`parcel`). The money: `POST /api/returns/:returnId/refund`; the delivery goes back with the last row that makes the order whole.
3. The order becomes `cancelled` when the parcel is back with all the money and the delivery.

## 8. A return outside the withdrawal

A defect, a wrong item, damage on the way, or goodwill, also after the period.

1. `POST /api/returns` (an admin) with the order, the units, `basis: other` and a reason (`defect`, `wrong_item`, `damaged`, `goodwill`, `other`), the words of the buyer, and the moment the buyer asked (`statedAt`, when it was earlier than now).
2. The buyer is mailed that the shop registered the return, with the code `R42-1`.
3. The rest is [2](#2-the-buyer-withdraws-after-the-order-was-sent) from step 3: the parcel, the goods, the money. The parcel the shop pays for (a label of the shop) is recorded on the statement: `POST /api/returns/:returnId/shipments`, its cost later with `PATCH /api/returns/:returnId/shipments/:shipmentId`.

## 9. The money before the goods

The buyer sent the parcel and the shop does not want to make them wait.

1. The buyer wrote the proof (see [2](#2-the-buyer-withdraws-after-the-order-was-sent), step 3). The alert `returns_proof_waiting` reminds the admins of a proof not confirmed.
2. An admin checks the tracking number and the receipt, and confirms: `POST /api/returns/:returnId/proof/confirm` with what the buyer paid the carrier (`buyerPaid`), or what the shop paid (`cost`) when it paid the label.
3. `POST /api/returns/:returnId/refund`: the rows still `expected` may go now. The transfer is written into the money journal in its parts; the goods part names the rows it pays, so the reports put the money on the right products even before the goods are in.
4. The goods arrive later: `POST /api/returns/:returnId/receive`; the money stays as it was (the stock log counts the units back when they come, the money journal already has the money). The alert `returns_goods_late` reminds of goods paid ahead that are not in. If they never come, see [11](#11-goods-that-never-come).

## 10. Goods that come back damaged or used

1. `POST /api/returns/:returnId/receive` with `not_accepted` and the reason (`unsealed`, `mixed`, `used`, `damaged`, `other`) for the units concerned. Their money is refused and the stock does not move. Money already on its way or back cannot be refused (`RETURN_ITEM_MONEY_SETTLED`), nor goods whose item money already with the buyer pays (a refund made by hand or what a bank took, given to it): those are taken in or written off.
2. The shop sends them back to the buyer: `POST /api/returns/:returnId/shipments` with `direction: to_buyer`, the rows and their units (`items`), the carrier, the number and the cost. The buyer is mailed the units and the parcel. Goods the shop keeps, as the buyer agreed, need no step.
3. The buyer is mailed the end with the reason of each refusal.

When the bank or a refund made by hand had paid the buyer for the goods after the shop refused them, the buyer has both: root keeps the goods that are still in the shop (`POST /api/returns/:returnId/keep`, they come in or are written off and that money pays their row), records what the buyer gives back (`POST /api/returns/:returnId/overpaid/received`), or gives it up (`POST /api/returns/:returnId/overpaid/lost`); [Returns](returns.md#money-already-with-the-buyer-for-goods-not-taken).

When the goods only lost some value (used more than needed to check them), they are taken back and the money lowered instead: root gives `reductions` (the row and its new sum, a note) to `POST /api/returns/:returnId/refund`. The mail says how much was kept for the value the goods lost and for which goods, never the note.

## 11. Goods that never come

- **The buyer did not send them** (no proof, nothing arrived). The alert `returns_goods_not_sent` reminds of it. Root closes the rows: `POST /api/returns/:returnId/close` with `goods_not_returned` (or `buyer_changed_mind` when the buyer said so) and a note. The units can be stated again later.
- **The parcel was lost on the way**, with a proof: `POST /api/returns/:returnId/receive` with `lost` (the parcel confirmed first, or in the same step); the money is due as for goods that came back.
- **The money went ahead and the parcel never came**: `POST /api/returns/:returnId/receive` with `not_arrived`. The money stays `refunded` and the statement closes; the shop gets the money back outside the app (from the carrier or the buyer).
- **The money was not sent yet**: `not_arrived` refuses it with the goods.

## 12. The cost of the way back

Who pays the carrier for the parcel back is what the contract the order kept says (`returnShippingPaidBy`; an order without a contract: the shop).

- **The buyer pays, and the shop paid the carrier** (a label of the shop):
  1. Record the parcel with its cost: `POST /api/returns/:returnId/shipments`. A number of a parcel goes once on a statement, whatever the spaces and the case (`409 RETURN_SHIPMENT_EXISTS`): a double click does not count the cost twice. The cost is a line of the money journal (`money.return_parcel_cost`, below 0); a cost written later, or changed, with `PATCH /api/returns/:returnId/shipments/:shipmentId` is the first line or a line `money.correction` of the difference, so a past period of the reports does not change. A cost below what transfers already took off for the way back is refused (`RETURN_DEDUCTION_EXCEEDS_COST`).
  2. The card of the statement gives `deductible`, read from the journal: what the parcels cost less what other transfers took off.
  3. `POST /api/returns/:returnId/refund` with `returnShippingDeduction` (up to `deductible`; the transfer stays above 0). The transfer has a part `deduction` (above 0) next to its goods and delivery, Stripe is asked for the difference, and the mail of the money names the sum taken off.
- **The shop pays, and the buyer paid the carrier**: the admin sets the sum of the receipt when confirming the parcel (`buyerPaid`, 0 without a receipt; the page shows the sum the buyer told beside the field, never in it). A typo is corrected while no money of the way back went: `PATCH /api/returns/:returnId/shipments/:shipmentId` with `{ buyerPaid }` (`409 RETURN_WAY_BACK_PAID` after; a statement that was closed opens again when the shop owes the way back by the new sum); the card warns of a sum above the order (`buyer_paid_over_total`). A confirmed parcel the buyer paid the carrier for takes no cost of the shop (`400 RETURN_PARCEL_SUM_INVALID`): the same way back would be paid twice; the sum the buyer told before the confirmation is a hint and does not count. The transfer that ends the money of the statement takes it with the goods (a part `way_back`), and the mail of the money names it. When the payment cannot hold it with the goods and with the money the other statements of the order still owe, the goods go alone and the way back waits: once it is left alone and fits (another statement of the order was refused, say), `POST /api/returns/:returnId/refund` without `itemIds` sends it by a transfer of its own, and the buyer is mailed it once Stripe sent it; a transfer that failed is among the failures that wait for the shop, and the same request sends it again. When it can never fit (a statement for all of the order), root sends it outside the app: `POST /api/returns/:returnId/refund/outside`, the buyer is mailed it. The alert `returns_money_short` shows a way back that does not fit now. It counts in `refundedTotal`. When the card warns `shop_paid_parcel`, the shop paid a parcel of this statement itself: nothing is owed for it.
- **The buyer pays and paid the carrier themselves**: nothing to record but the proof.
- **The goods were all refused** (not accepted, or never arrived): the shop pays no way back, whoever the contract says pays it; the card of the statement shows none owed and the statement closes. The contract of the shop says so: a clause for its text.

## 13. A transfer that fails

`POST /api/returns/:returnId/refund` answers with the rows `failed` and the reason of the failure (`refundFailure`). The money journal has the transfer (its parts, in transit) and a line `money.refund_failed` for each part with the opposite sum and the reason, so `refundedTotal` falls back. The alert `return_refunds_failed` lists the statement (`GET /api/payments/refunds?purpose=return&state=failed`: `id` is the first line of the transfer, `returnId` the statement).

- `card_unavailable`: the card can no longer take money; the buyer is mailed that the shop will contact them. Root sends the money another way and records it: `POST /api/returns/:returnId/refund/outside` (the rows, the way `bank_transfer`, `cash` or `other`, a note, the real day). The journal gets `money.outside` in parts (the goods, the delivery that goes with the rows, the deduction the failed transfer meant to take), the rows become `refunded`, the admin log `return.refund_outside` with the lines.
- `shop_balance`, `unknown`: try again later with `POST /api/returns/:returnId/refund` (a new transfer under a new key), or send it outside the app as above.
- `already_refunded`: the money of the payment went back by hand in the dashboard of Stripe; root says what that refund was for (`POST /api/payments/money-lines/:moneyLogId/decision`) and the units it gave back pay the rows first.
- `disputed`: see [14](#14-a-dispute-at-the-bank). It is not mailed and not in the alert of the failed transfers while the dispute is open (the dispute is in `disputes_to_answer`); once no dispute of the payment is open, the transfer is back among the failures while its rows still owe the money.

A transfer that got no answer stays in transit (the rows `pending`): the worker asks the provider again with the same key, the webhook of the provider settles it, and the alert `return_refunds_in_transit` shows one in transit for days.

A payment that holds less than the transfer (a compensation of root, or a loss root decided on a refund by hand or on what a bank took, used some of it): the card says so first (`moneyLeft.short`, the alert `returns_money_short`). `POST /api/returns/:returnId/refund` sends what is left of the payment, taken off the goods of the last rows (never off what money already with the buyer covers of them): a row is paid in parts (`paid` of `amount`), and the rows Stripe pays nothing of wait whole. Root then sends the rest outside the app (`POST /api/returns/:returnId/refund/outside`): the row is refunded once its parts give all of it, the statement closes, and its closing mail tells each part, by the way it went. A row paid in part takes the result of all its units at once and is not closed without its money until the rest is paid. With nothing left of the payment, the transfer is refused (`409 RETURN_REFUND_EXCEEDS_PAID`) and all of it goes outside the app.

A transfer can fail after it went: Stripe answers `succeeded`, the lines are `sent`, the buyer is mailed that the money was sent and the statement may close, but the bank of a card that is closed or expired sends the money back a while later (`refund.failed`, `expired_or_canceled_card`). The webhook then writes the failure lines, puts the rows of that refund to `failed` with `card_unavailable`, opens the statement again and mails the buyer that the money did not reach them; the alert lists it. Root sends the money another way and records it, as above. In the reports the transfer stays in the period it was made in, the failure gives the money back in its own period, and the money root sent counts in the period root records it.

## 14. A dispute at the bank

The buyer of an order with a statement disputed the payment at the bank. The app follows the dispute by itself from the events of Stripe; nobody records its end ([Disputes](disputes.md)).

1. The dispute opens. The money journal gets what the bank took (`money.dispute_withdrawn`), the dispute is in `GET /api/payments/disputes`, and the app puts a draft of the evidence on it at Stripe (the order, the send, the refunds, the statements). A transfer of the statement is refused while it is open (`409 RETURN_REFUND_DISPUTED`; one already asked fails as `disputed`), and so is the money sent outside the app: the bank may give the buyer the money. The card of the statement says `disputeOpen`; the goods, the proof and the parcels go on as usual.
2. The alert `disputes_to_answer` lists the dispute, the date its evidence is due nearest first (`evidenceDueBy`), and marks that the order has a statement (`returnOpen`). A person reads the draft in the dashboard of Stripe, adds to it and submits it there (once).
3. The bank decides, and the app does the rest:
   - **won**: the bank gives the money back (`money.dispute_reinstated`), and the app sends the money of the statement at once by an ordinary transfer, with the usual mails ("money sent");
   - **lost**: what the bank took is tied to the earliest statement of the order that waits for money; the app's transfer of the statement uses it first (a part `covered`) and asks Stripe only for what is left, or for nothing when the bank gave all of it. The bank gave more than the statement owed: the difference is a loss of the shop, plain in the journal. The returned total of the statement counts the money of the bank.
4. A step that could not be taken when the event came (Stripe or the database busy) is taken by the worker within minutes. The buyer is never mailed that a dispute opened or was won.

A dispute of a paid order not sent and without a statement holds the order instead; a lost one cancels it by a statement of the system and sends the rest: [Disputes](disputes.md#case-by-case).

## 15. The carrier delivered earlier

The period of withdrawal counts from the delivery. When the carrier delivered before the admin marked it:

1. `PATCH /api/orders/:orderId/status` with `status: delivered` and `deliveredAt`, the moment of the delivery (or for each order of `POST /api/orders/status`).
2. It is refused in the future and before the order was sent (`ORDER_DELIVERED_AT_INVALID`), and with any other step (`DELIVERED_AT_NOT_ALLOWED`). Without it the moment is now.

This is for the delivery by hand, until the services of the carriers give the moment themselves. The admin takes the date from the tracking of the carrier: an earlier date shortens the period of the buyer, and the step goes to the admin log with it.

## 16. Late statements and the grace

- The buyer is told the end of the period of the contract (`withdrawalEndsAt`, the mails, the bot).
- The server takes a statement `withdrawalGraceDays` (root sets it) more; the page keeps the button by `withdrawalOpen`, and the bot says the period of the contract ended and the shop still takes a statement.
- After that the server refuses (`RETURN_PERIOD_OVER`); the button leads to the chat, and an admin may still take goods back as a return outside the withdrawal ([8](#8-a-return-outside-the-withdrawal)).

## 17. A statement that extends another

The buyer asks for more units of the same order than an earlier statement named (for example by mail, after a first parcel).

1. `POST /api/returns` (an admin) with `extendsId`, the earlier statement of the same order; the new one has its own code and rows, and its mail says it extends the earlier one.
2. The list keeps the statements of a chain together or apart with `extended`.

## 18. The account is deleted meanwhile

The account can be deleted at any time, also with an open statement (`DELETE /api/users/me`). The statement goes on: the mails go to the email of the statement, the money to the card of the order, the parcel is written on the page of the link of a mail. The buyer of a deleted account withdraws from another order by the link of a mail ([3](#3-the-buyer-withdraws-by-the-link-of-a-mail)). Root answers a request for the data of the person with `GET /api/users/:userId/export`.

## 19. What the admins watch

| Alert                       | A statement is listed when                                                                                                                   | What to do                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `returns_manual_check`      | a statement of the form without the code is open and no admin accepted it                                                                    | [4](#4-a-statement-of-the-form-without-the-code)                                                |
| `returns_proof_waiting`     | the buyer wrote the parcel and the shop has not confirmed it (2 days unless set)                                                             | confirm it ([9](#9-the-money-before-the-goods)) or wait for it                                  |
| `returns_goods_not_sent`    | nothing was told of the parcel and the goods are not in (21 days unless set)                                                                 | write to the buyer, or close the rows ([11](#11-goods-that-never-come))                         |
| `returns_money_late`        | the money is due (goods in, or the proof confirmed) and not back (10 days unless set); not while a dispute or a refund made by hand holds it | `POST /api/returns/:returnId/refund`                                                            |
| `returns_goods_late`        | the money went ahead and the goods are not in (14 days unless set)                                                                           | follow the parcel ([11](#11-goods-that-never-come))                                             |
| `return_refunds_in_transit` | a transfer is in transit and Stripe has told neither sent nor failed (3 days unless set)                                                     | look at it in the dashboard of Stripe                                                           |
| `return_refunds_failed`     | a transfer failed and its rows still owe the money (not while a dispute of the payment is open or a refund made by hand waits for root)      | [13](#13-a-transfer-that-fails)                                                                 |
| `dispute_refunds_*`         | the same for the rest a statement of the system sends after a dispute lost                                                                   | [13](#13-a-transfer-that-fails)                                                                 |
| `disputes_to_answer`        | a dispute of the payment of the order is open and no evidence was submitted, marked when the order has a statement                           | [14](#14-a-dispute-at-the-bank)                                                                 |
| `hand_refunds_to_explain`   | (root) a refund made by hand in the dashboard of Stripe waits for root to say what it was for, a statement of the order open or not          | the decision ([Payments](payments.md#what-money-given-back-by-hand-or-taken-by-a-bank-was-for)) |

The alerts of the statements name the list of the statements with the filters of their cases (`GET /api/returns`), the alerts of the refunds name `GET /api/payments/refunds` with the purpose and the state of their cases, the alert of the disputes `GET /api/payments/disputes?toAnswer=true`; the count of an alert is the total of its list. The list of the refunds names the statement of each transfer (`returnId`); the list of the statements also finds a statement by its code (`q=W42-2`), and the card of an order gives for each item the units left to send (`toShip`). Every alert of the money is in [Payments](payments.md#the-alerts).
