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
3. The buyer sends the goods and writes the carrier and the number: `POST /api/orders/:orderId/returns/:returnId/proof` from the account, or the page of the link (`POST /api/withdrawals/proof`, with the code).
4. An admin follows the parcel. Either:
   - the goods arrive: `POST /api/returns/:returnId/receive` with a result for the units (`to_stock`, `written_off`, `lost`, `not_accepted`, `not_arrived`); or
   - the proof is enough to pay before the goods arrive: `POST /api/returns/:returnId/proof/confirm`, then [9](#9-the-money-before-the-goods).
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

An accepted statement is the buyer's already: its units are not taken over, and the buyer states only the units left. 4. The new statement goes on as [1](#1-the-buyer-withdraws-before-the-order-is-sent) or [2](#2-the-buyer-withdraws-after-the-order-was-sent).

A statement of an admin never takes units over: it is refused while they are held (`RETURN_QUANTITY_EXCEEDED`).

## 6. The shop cancels a paid order

The shop cannot send a paid order (no stock, an error of the price, the buyer asked by mail).

1. `POST /api/returns` (an admin) with the order, the items (or all of them), `basis: other` and `reason: shop_cancel`. There is no other route that cancels an order.
2. The goods go back to the stock at once, the order is `cancelled` when all of it is back, and the money goes back at once through the provider.
3. The buyer is mailed that the shop registered the return, then the money.

## 7. The buyer refused the parcel

The order was sent and the parcel comes back to the shop unopened.

1. `POST /api/returns` (an admin) with `basis: withdrawal` and `reason: refused`: the statement takes whatever is left of the order and waits for the parcel, whatever the rules of withdrawal of the items.
2. The parcel arrives: `POST /api/returns/:returnId/receive`. The money: `POST /api/returns/:returnId/refund`; the delivery goes back with the last row that makes the order whole.
3. The order becomes `cancelled` when the parcel is back with all the money and the delivery.

## 8. A return outside the withdrawal

A defect, a wrong item, damage on the way, or goodwill, also after the period.

1. `POST /api/returns` (an admin) with the order, the units, `basis: other` and a reason (`defect`, `wrong_item`, `damaged`, `goodwill`, `other`), the words of the buyer, and the moment the buyer asked (`statedAt`, when it was earlier than now).
2. The buyer is mailed that the shop registered the return, with the code `R42-1`.
3. The rest is [2](#2-the-buyer-withdraws-after-the-order-was-sent) from step 3: the parcel, the goods, the money. The parcel the shop pays for (a label of the shop) is recorded on the statement: `POST /api/returns/:returnId/shipments`, its cost later with `PATCH /api/returns/:returnId/shipments/:shipmentId`.

## 9. The money before the goods

The buyer sent the parcel and the shop does not want to make them wait.

1. The buyer wrote the proof (see [2](#2-the-buyer-withdraws-after-the-order-was-sent), step 3). The alert `returns_proof_waiting` reminds the admins of a proof not confirmed.
2. An admin checks the tracking number and confirms: `POST /api/returns/:returnId/proof/confirm`.
3. `POST /api/returns/:returnId/refund`: the rows still `expected` may go now.
4. The goods arrive later: `POST /api/returns/:returnId/receive`; the money stays as it was. The alert `returns_goods_late` reminds of goods paid ahead that are not in. If they never come, see [11](#11-goods-that-never-come).

## 10. Goods that come back damaged or used

1. `POST /api/returns/:returnId/receive` with `not_accepted` and the reason (`unsealed`, `mixed`, `used`, `damaged`, `other`) for the units concerned. Their money is refused and the stock does not move. Money already on its way or back cannot be refused (`RETURN_ITEM_MONEY_SETTLED`).
2. What happens to those goods is outside the app: the shop sends them back to the buyer or keeps them, as they agree.
3. The buyer is mailed the end with the reason of each refusal.

When the goods only lost some value (used more than needed to check them), they are taken back and the money lowered instead: root gives `reductions` (the row and its new sum, a note) to `POST /api/returns/:returnId/refund`. The mail says how much was kept for the value the goods lost and for which goods, never the note.

## 11. Goods that never come

- **The buyer did not send them** (no proof, nothing arrived). The alert `returns_goods_not_sent` reminds of it. Root closes the rows: `POST /api/returns/:returnId/close` with `goods_not_returned` (or `buyer_changed_mind` when the buyer said so) and a note. The units can be stated again later.
- **The parcel was lost on the way**, with a proof: `POST /api/returns/:returnId/receive` with `lost` (the proof confirmed first); the money is due as for goods that came back.
- **The money went ahead and the parcel never came**: `POST /api/returns/:returnId/receive` with `not_arrived`. The money stays `refunded` and the statement closes; the shop gets the money back outside the app (from the carrier or the buyer).
- **The money was not sent yet**: `not_arrived` refuses it with the goods.

## 12. The cost of the way back

Who pays the carrier for the parcel back is what the contract the order kept says (`returnShippingPaidBy`; an order without a contract: the shop).

- **The buyer pays, and the shop paid the carrier** (a label of the shop):
  1. Record the parcel with its cost: `POST /api/returns/:returnId/shipments`. A number of a parcel goes once on a statement, whatever the spaces and the case (`409 RETURN_SHIPMENT_EXISTS`): a double click does not count the cost twice.
  2. The card of the statement gives `deductible`: the most the next transfer may take off.
  3. `POST /api/returns/:returnId/refund` with `returnShippingDeduction` (up to `deductible`; the transfer stays above 0). The mail of the money names the sum taken off.
- **The shop pays, and the buyer paid the carrier**: root pays the buyer back outside the app and records it, once a statement: `POST /api/returns/:returnId/reimbursement` (the sum, the way, a note, the day). The buyer is mailed it. When the card warns `shop_paid_parcel`, the shop already paid a parcel of this statement: check the buyer really sent another one before paying again.
- **The buyer pays and paid the carrier themselves**: nothing to record but the proof.

## 13. A transfer that fails

`POST /api/returns/:returnId/refund` answers with the rows back at `not_refunded` and the reason of the failure (`refundFailure`); the alert `failed_refunds` lists the statement.

- `card_unavailable`: the card can no longer take money; the buyer is mailed that the shop will contact them. Root sends the money another way and records it: `POST /api/returns/:returnId/refund/outside` (the rows, the way `bank_transfer`, `cash` or `other`, a note, the real day).
- `shop_balance`, `unknown`: try again later with `POST /api/returns/:returnId/refund`, or send it outside the app as above.
- `disputed`: see [14](#14-a-dispute-at-the-bank).

A transfer that got no answer stays `pending`: the worker asks the provider again with the same key, and the webhook of the provider settles it.

## 14. A dispute at the bank

The buyer disputed the payment at the bank, so the provider refused the transfer as `disputed`. The app neither sends it again nor records it as returned outside until the bank decides.

1. The bank decides (the dashboard of the provider tells it).
2. Root records the end: `POST /api/returns/:returnId/dispute` for every disputed row of the order:
   - `outcome: lost` with a note and the day the dispute closed (`at`): the bank gave the buyer the money. The rows become `refunded` with the way `chargeback`; the reports count the money on that day. No mail: the bank told the buyer.
   - `outcome: won` with a note: the bank gave the money back to the shop. The mark goes and the money is sent again: `POST /api/returns/:returnId/refund`.

The webhook of the provider that tells the end of a dispute will take this step over; until it is wired, root does it.

## 15. The carrier delivered earlier

The period of withdrawal counts from the delivery. When the carrier delivered before the admin marked it:

1. `PATCH /api/orders/:orderId/status` with `status: delivered` and `deliveredAt`, the moment of the delivery (or for each order of `POST /api/orders/status`).
2. It is refused in the future and before the order was sent (`ORDER_DELIVERED_AT_INVALID`), and with any other step (`DELIVERED_AT_NOT_ALLOWED`). Without it the moment is now.

This is for the delivery by hand, until the services of the carriers give the moment themselves. The admin takes the date from the tracking of the carrier: an earlier date shortens the period of the buyer, and the step goes to the admin log with it.

## 16. Late statements and the grace

- The buyer is told the end of the period of the contract (`withdrawalEndsAt`, the mails, the bot).
- The server takes a statement `WITHDRAWAL_GRACE_DAYS` more; the page keeps the button by `withdrawalOpen`, and the bot says the period of the contract ended and the shop still takes a statement.
- After that the server refuses (`RETURN_PERIOD_OVER`); the button leads to the chat, and an admin may still take goods back as a return outside the withdrawal ([8](#8-a-return-outside-the-withdrawal)).

## 17. A statement that extends another

The buyer asks for more units of the same order than an earlier statement named (for example by mail, after a first parcel).

1. `POST /api/returns` (an admin) with `extendsId`, the earlier statement of the same order; the new one has its own code and rows, and its mail says it extends the earlier one.
2. The list keeps the statements of a chain together or apart with `extended`.

## 18. The account is deleted meanwhile

The account can be deleted at any time, also with an open statement (`DELETE /api/users/me`). The statement goes on: the mails go to the email of the statement, the money to the card of the order, the parcel is written on the page of the link of a mail. The buyer of a deleted account withdraws from another order by the link of a mail ([3](#3-the-buyer-withdraws-by-the-link-of-a-mail)). Root answers a request for the data of the person with `GET /api/users/:userId/export`.

## 19. What the admins watch

| Alert                    | A statement is listed when                                                            | What to do                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `returns_manual_check`   | a statement of the form without the code is open and no admin accepted it             | [4](#4-a-statement-of-the-form-without-the-code)                        |
| `returns_proof_waiting`  | the buyer wrote the parcel and the shop has not confirmed it (2 days unless set)      | confirm it ([9](#9-the-money-before-the-goods)) or wait for it          |
| `returns_goods_not_sent` | nothing was told of the parcel and the goods are not in (21 days unless set)          | write to the buyer, or close the rows ([11](#11-goods-that-never-come)) |
| `returns_money_late`     | the money is due (goods in, or the proof confirmed) and not back (10 days unless set) | `POST /api/returns/:returnId/refund`                                    |
| `returns_goods_late`     | the money went ahead and the goods are not in (14 days unless set)                    | follow the parcel ([11](#11-goods-that-never-come))                     |
| `failed_refunds`         | a transfer failed                                                                     | [13](#13-a-transfer-that-fails), [14](#14-a-dispute-at-the-bank)        |

Each alert names the list of the statements with the filters of its cases (`GET /api/returns`), so the count of an alert is the total of its list. The list also finds a statement by its code (`q=W42-2`), and the card of an order gives for each item the units left to send (`toShip`).
