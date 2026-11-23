# Taxes, invoices and fiscal receipts

How the shop takes the tax of a sale (VAT, GST), makes its invoices and credit notes, has fiscal receipts registered, and reports the tax for the declarations. Written for the owner of the shop (root) and for the frontend.

The code knows no law of any country. It has one general mechanism: count, compare, switch, warn. Every number and every choice is what root writes for the shop and for each country it sells to. The checks of the database keep the combinations that cannot work out; everything else is root's decision, with the law of the countries the shop works with.

## The shop

The data of the shop (`PUT /api/root/shop-settings`, [Shop settings](shop-settings.md)) holds what is about the shop itself:

- `sellerCountry`: the country the seller is registered in. The United States, Portugal and Poland are not supported as countries of a seller (`SELLER_COUNTRY_NOT_SUPPORTED`):
  - the United States: a tax of every state and city;
  - Portugal: invoices come from certified software only;
  - Poland: a credit note lowers the tax only once the buyer confirms it, and the invoices of KSeF.
- `vatPayer`: the shop takes the tax in its own country. With `true` the shop needs `sellerCountry`, `sellerTaxId` and `sellerTaxIdLabel` (the words before the number on a document: `NIF-IVA`, `USt-IdNr.`, `VAT`), the record of `sellerCountry` with its rates, and a rule in the record of every country without customs.
- `maxOrderTotal`: the largest total of an order, the delivery in it; a larger one is refused (`ORDER_TOTAL_ABOVE_MAXIMUM` with the sum). In Spain write 3000: a simplified invoice goes up to it, a larger sale needs the tax number of the buyer, which the shop does not ask.
- `invoiceMode`: `every_order` (an invoice of every paid order) or `on_request` (of an order the buyer asked one for at the confirmation). Null: no invoice is made.
- `invoicePrefix`, `creditNotePrefix`, `invoiceYearly`: the two series of the documents and whether a series starts every year (`F2026-1`).
- `receiptMoment`: when the fiscal receipt of a sale is made, at the payment or when the order is sent, for a receipts provider that makes them.
- `documentFooter`: the text at the foot of every document (the registration of the firm, the bank, a note).
- `pickupCountry`: the country of the place a pickup order is collected at; the tax of a pickup is of its record.

## The countries

Every country the shop sells to has a record, its own country included: `PUT /api/root/countries/:country` writes everything a country is, at once, with its zone of the delivery (a new zone name makes a zone, the prices are the prices of the zone). There is no other list of countries and no zone of the rest: the shop delivers to the countries it has records of in its zones.

- `customsFree`: a parcel there crosses no customs border (the own country, the rest of the EU from the EU).
- `rule`, the rule of the tax:
  - `seller`: the tax of the country of the seller;
  - `recipient`: the tax of this country, while every condition written holds;
  - `none`: no tax;
  - `buyer_at_receipt`: customs take the tax from the buyer on receipt.

  A country with customs takes `recipient` or `buyer_at_receipt`. A country without customs takes any rule but `buyer_at_receipt`, and none at all for a shop that takes no tax in its own country (no tax is taken there).

- The rule `recipient`:
  - `registered`: the shop is registered for the tax in the country, with `taxNumber`, `taxNumberLabel` (`IOSS`, `UK VAT`) and `taxNumberKind` (`ioss`: the number goes with the parcel; `other`: on a commercial invoice of the parcel). Not registered, a sale the tax of the country would hold is refused: `TAX_SALES_STOPPED` past the threshold, `TAX_PARCEL_LIMIT` within the limit of a parcel (with the limit, for the page to say from which sum an order can go).
  - `parcelLimit`: the rule holds up to this price of a parcel, the delivery counted in or not, with the tax or without (Britain: 135 pounds without the delivery and the tax). Above it a country with customs leaves the tax to the buyer on receipt.
  - `threshold`: the rule holds once the sales of the period, this order with them, pass the sum (with the tax or without). Countries of one `group` share one threshold: the same sum, the same period, a write of one writes the others (the EU: 10 000 euro for all of the EU together). The period root picks once, no dates to write: `period: year`, a year from the 1st of `startMonth` at midnight in the time zone of the shop (January for the EU; another month for a tax year that starts later), or `period: rolling_12`, the last 12 months. A year counts from 0 when it starts; the year after one that passed the threshold starts with the tax of the recipient from its first sale (the law of the EU: this year or the year before), and passing the threshold in it changes nothing but the alerts, unless root chose `nextCycle: initial` (the next year starts with the first rule until the threshold is passed again); the record tells the cycle in force (`cycleFrom`, `nextCycleFrom`). Over the last 12 months the tax of the recipient holds from the order that passed the threshold (the database writes the moment) until root goes back to the first rule with `nextCycle: initial`; the alert `tax_threshold_dropped` tells when the sum fell below it (`held` in the record). Where the shop is not registered the same holds for the stop of the sales. The sales are the paid orders and the confirmed ones that wait for their payment; money sent back later does not lower them. The sums are in the currency of the shop: compare the threshold with the rate of the day when its alert comes, and keep a margin in the sum if it is near.
  - Below the threshold, or above the limit, a country without customs sells with the tax of the seller, a country with customs leaves the tax to the buyer on receipt.
- `rates`: the rates of the country, needed for `recipient` and in the record of the country of a seller that takes the tax: the main rate (`group: null`) and a rate of every tax group, each from the start (`from: null`); a planned rate is an entry with the time it starts, an old one stays as history.
- `deliveryVat`: how the tax comes out of the price of the delivery: `main`, at the main rate; `proportional`, in proportion to the items of each rate.
- `exportPrice`: the price where no tax of the seller is taken (`none`, `buyer_at_receipt`, `recipient` across customs): `same`, or `without_seller_vat` (the tax of the seller comes out of the unit price, half up to the cent).
- `exemptionText`: why a document of such a sale has no tax, a reference to the law, in the language of the shop.

## The tax groups

A tax group is a kind of products with a rate of its own (books, medicines): `POST /api/root/tax-groups` makes one with its rate in every country that has rates. A product has a group or none (the main rate), and may be classed in another group by a country (`taxExceptions`, `{ "DE": 3, "FR": null }`: the same product is a food supplement in one country and a medicine in another). `PATCH /api/products/tax` sets the group and the classes of many products at once, a dry run lists the products of the scope; `POST /api/root/countries/:country/copy-exceptions` copies the classes of another country.

## The tax of an order

The tax is taken out of the price of a line (the prices are with the tax, the price on the card and in the cart is the same): tax = price of the line × rate / (100 + rate), half up to the cent. A planned rate counts from its start; the confirmation fixes the tax of the order and keeps it, a rate that comes later does not change it.

`POST /api/orders/current/delivery-options` and the confirmation give the price of every line after the rule, the tax by rate, the delivery, the total, and whether the buyer may pay the tax and the duty on receipt; the page shows them as it likes, from the same numbers. The duty is always the buyer's, paid to the carrier or to customs: the app does not count it.

An order whose reservation ended before its payment came is a cart again: a payment that comes later is taken only while the items keep the tax the confirmation fixed (a read or a write of the cart since gives them the prices of now and takes it off); otherwise it goes back in full, as a payment the order cannot take.

The confirmation of an order to a country where the sales stopped (`TAX_SALES_STOPPED`), within the limit of a parcel the shop is not registered for (`TAX_PARCEL_LIMIT`), or above `maxOrderTotal` (`ORDER_TOTAL_ABOVE_MAXIMUM`) is refused with the code; the list of the ways shows the same refusal in `tax.refusal` before, for the page to say it.

## The documents

- **Invoice.** Made by the database in the transaction of the payment, when `invoiceMode` asks for one: `every_order`, or `on_request` with the box the buyer ticked at the confirmation (`invoiceRequested`). Its number is the next one of its series, without gaps, under a lock of the series (a failed transaction takes no number). It keeps copies of what it was made with: the seller (the name, the address, the tax number with its words; with the rule `recipient` the number of the shop in that country), the buyer (the name, the address), the lines with their rule, country, rate and tax, the delivery split by rate, the totals by rate, the text of `exemptionText` where no tax is taken, and `documentFooter`. A document never changes after it is made.
- **Credit note.** Made when money for the goods goes back to the buyer: a refund once the provider sent it, money given back outside the app, a compensation, and the decision of what money given back by hand or taken by a bank was for (below). It lowers the invoice by the tax the money held: every line of the money journal carries the shares of the tax of its order (`taxShares`), a refund the shares of what was left of the payment (the units of the rows of a statement, else every line by what it has left; a share a line has no room for goes to the other lines of the part), so a credit note of any sum adds up to the cent and the last one takes what is left. The goods and the delivery a statement gives back together make one credit note: of one transfer, of money already with the buyer, of money sent outside the app.
- **Money given back by hand and what a bank took.** A refund made by hand in the dashboard of the provider and the money a bank takes for a dispute hold no tax when they move: what they were for is not known yet. The decision of it gives the tax and one credit note, in the moment of the decision (the report of the tax counts it then): root's decision of the items and the delivery the money was for (`POST /api/payments/money-lines/:moneyLogId/decision`), or the one the system makes by itself (the whole payment of an order not sent given back by hand, a dispute lost on an order not sent: all of the order). The items and the delivery give their tax back by their sums; the rest of money given back by hand is a compensation and gives its tax back by what every line has left; the rest of what a bank took is a loss of the shop and lowers no tax (the buyer has the goods and the money). While a dispute is open, and when the shop wins it, there is no document: the sale stands. A decision made again (allowed while no statement took the money) reverses the credit note it gave with an invoice and gives a new one; the shares of the tax of the line keep both, each in its own moment, so a period that is over never changes. A statement that the money pays later gives no document: the credit note of its goods is there already. A share of a unit the shop also paid by a transfer ahead of the goods (the unit the money paid turned out to be the one the transfer paid) becomes a loss of the shop at the reception: written into the line, it reverses the credit note of the decision with an invoice and gives a new one without that share, so the loss lowers no tax.
- **Reversing invoice.** When money that went back counts for the shop again, an invoice reverses the credit note of that money by the shares of what came back: a refund that failed after it was sent (all of it), money the buyer gave back outside the app (the share of each line that paid the row: its own transfer, the money already with the buyer), a decision made again: the documents end where the money does.
- **After the shop stops making invoices.** A credit note or a reversing invoice of an invoice made is still numbered when `invoiceMode` goes back to `null`, and when root took `invoicePrefix`, `creditNotePrefix` or `invoiceYearly` away: in the last series set. A new prefix starts a new series (a correction names the number of the document it corrects). A series holds one kind: the database refuses an `invoicePrefix` (the invoices and the reversing invoices) that the credit notes are numbered in, and a `creditNotePrefix` of the invoices, a series a year of it included (`INVOICE_SERIES_TAKEN`).
- **The PDF.** `GET /api/orders/:orderId/documents/:documentId/pdf` draws an invoice or a credit note from its copies, in the language of the shop (an official document), with the code and the text of its fiscal receipt at the top when one is registered. Nothing is stored: the same document always draws the same.
- **Who reads them.** The buyer the documents of their own orders, an admin and root any (`GET /api/orders/:orderId/documents`, with the receipts and their state; the last error of a provider only for the staff). The export of a person's data (`GET /api/users/me/export`) gives their documents: the order, the kind, the number, the date, the sum, the currency and the copy of the buyer.
- **How long.** The copy of the buyer in a document is emptied after `retention.taxDocumentsDays` of the privacy policy (the law of the country: 4 to 10 years); the rest of the document stays.

## The fiscal receipts

A receipts provider registers the sales at the tax authority where the law asks for it. `RECEIPT_PROVIDER` chooses it ([configuration](configuration.md)): `none` (no receipts) or `fiskaly` (SIGN ES, a shop registered in Spain: Verifactu, where the receipt is the invoice itself, its code and text printed at the top).

- `receiptMoment` of the shop: `payment` or `shipment`. root writes it only with a provider that makes receipts (`RECEIPT_PROVIDER_NOT_CONFIGURED`), with an invoice of every order (`RECEIPT_INVOICE_EVERY_ORDER_REQUIRED`), at the moment the provider takes (fiskaly: `payment`, `RECEIPT_MOMENT_FIXED`) and for a country of the seller it serves (fiskaly: Spain, `RECEIPT_SELLER_COUNTRY_NOT_SUPPORTED`). Without it no receipt is made. Once `RECEIPT_PROVIDER` of the server changes, every write of the data of the shop (a country included) is refused with the code of the receipts until root writes `receiptMoment` again for the new provider (`null` for `none`, `RECEIPT_MOMENT_WITHOUT_PROVIDER`; set for one that makes receipts, `RECEIPT_MOMENT_REQUIRED`).
- The database makes the receipt with the document it registers: a receipt of the sale with the invoice (at the payment, or when the order is sent), a receipt of the return with a credit note. A receipt of a return waits until the receipt of the sale it corrects is registered (or made by hand): one the tax authority has not registered yet may still be refused.
- The worker sends each receipt to the provider and asks about it every minute until it is registered; a provider that does not answer gets it again after 1, 5, 15, 60 and then every 360 minutes. The buyer gets the mail "Your receipt" (or "Your return receipt") once, with its number and the link to check it.
- A receipt the provider refused (its data, a number taken) waits for a person: root or a money admin makes it by hand in the dashboard of the provider and confirms it with the number it got there (`POST /api/orders/:orderId/documents/:documentId/receipt-confirmation`); the receipt is `manual` from then on and is not sent again.
- What a rule becomes at fiskaly: the rule `seller` — the VAT of Spain at its rate; `recipient` in another EU country — the sale under OSS, not taxed in Spain; `recipient` out of the EU (the shop took the tax of Britain, Norway) — an export, exempt in Spain; a sale outside the EU (`none`, `buyer_at_receipt`, a country with customs) — an export, exempt; no tax in another EU country — not taxed in Spain by the rules of the place of supply; no rate in Spain — exempt. The record of the tax authority holds the taxes of Spain only: its total is the sum of the bases and of those taxes, so a line without the VAT of Spain is registered at its net, and the tax of another country the shop took (OSS, Britain) stays on the invoice and the receipt of the buyer, not in the record (the tax authority refuses a total past 10 of that sum, error 2005).

## Parcels across customs

When the shop took the tax of a country with customs on an order (the rule `recipient`), the parcel goes with the tax number of the shop in that country, so the buyer does not pay the tax again at the border, and the customs are given the value of the goods without that tax (the declaration of the parcel and the commercial invoice alike):

- `taxNumberKind: ioss`: the number goes with the parcel itself (the import scheme of the EU).
- `taxNumberKind: other` (a VAT number of Britain, Norway, Switzerland): the provider makes a commercial invoice of the parcel right after it, with the number of the shop as the VAT number of the exporter, the values of the goods without the tax and the tax paid apart, the number of the invoice of the order (the number of the parcel when the order has no invoice), the country of origin and the customs code of each line, under DAP. A carrier that takes the papers electronically is sent it with the parcel (`customsInvoice: electronic` of the shipment); otherwise the admin prints it and puts it on the parcel with the label (`customsInvoice: print`, `GET /api/orders/:orderId/shipments/:shipmentId/customs-invoice`). Through ShippyPro the carriers that take it electronically are UPS, FedEx, MyDHL and Chronopost. A carrier that refuses it, or a provider that does not answer, leaves it to print; the parcel is kept.
- A record of the country with no number now refuses the parcel (`DELIVERY_TAX_NUMBER_MISSING`): root writes the number again, or the order goes back to the buyer.
- The commercial invoice carries no EORI of the shop: the data of the shop has no field for it. A carrier that needs one has it from its contract with the shop.

## The report of the tax

`GET /api/admin/reports/vat?from=&to=` (admin and root) gives the tax of a period for the declarations, read from the money journal: every line of money holds the shares of the tax of its order, so the report is what the money did, not what the orders said.

- `sales`: the payments; `returns`: the money that went back to the buyers (below 0), counted when it was sent; `failures`: the money that came back to the shop after it; `total`: all of them together.
- Each row is a rule, a country and a rate with its net, tax and gross; a country taxed by the rule `recipient` names the tax number root wrote for it (the declaration of that country, or OSS). The sums are in the currency of the shop.

## The alerts

Root follows the tax of the countries, root and the money admins the receipts (`GET /api/admin/alerts`). No kind has a number from the server: a person writes the numbers of a kind before following it (`ALERT_THRESHOLD_REQUIRED`), and a kind with numbers counts nothing for them until then.

| Kind                         | A case                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tax_threshold_near`         | the sales of a threshold (a group of countries or one) in its period reached the per cent written                                                           |
| `tax_threshold_passed`       | a threshold passed in a country where the shop is registered: its tax is taken now; root says what the next year starts with (`threshold.nextCycle`)        |
| `tax_threshold_dropped`      | the sales of the last 12 months of a threshold that holds the tax of the recipient fell below it: root may go back to the first rule (`nextCycle: initial`) |
| `tax_sales_stopped`          | an order refused because a threshold passed where the shop is not registered (`TAX_SALES_STOPPED`), for the period                                          |
| `tax_parcel_limit_refusals`  | informs: as many orders to a country refused within the limit of a parcel (`TAX_PARCEL_LIMIT`) as written, in the days written (the window)                 |
| `tax_rate_soon`              | informs: a rate of a country starts within the days written                                                                                                 |
| `tax_threshold_period_ended` | informs: the year of a threshold ended, its sales start from 0 (the tax of the recipient holds on when the year before passed it)                           |
| `receipts_not_issued`        | a receipt not registered for the minutes written; its list is of the orders that have one (`GET /api/orders?receipts=pending&receiptsMadeTo=<time>`)        |
| `receipts_refused`           | a receipt the provider refused: make it by hand and confirm it; its list is of the orders that have one (`GET /api/orders?receipts=refused`)                |

A kind that only informs is closed by the person who read it (`PUT /api/admin/alerts/seen/:kind`): what they saw goes for them, a later event of the kind alerts again; the others still see it.

## Routes

| Route                                                                               | Who                      | What                                                             |
| ----------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `GET`, `PUT`, `DELETE /api/root/countries/:country`, `GET /api/root/countries`      | root                     | the records of the countries with their zones                    |
| `POST /api/root/countries/:country/copy-exceptions`                                 | root                     | the classes of the products of another country                   |
| `GET`, `POST /api/root/tax-groups`, `PATCH`, `DELETE /api/root/tax-groups/:groupId` | root                     | the tax groups                                                   |
| `PATCH /api/products/tax`                                                           | admin, root              | the group and the classes of many products, a dry run            |
| `POST /api/orders/current/delivery-options`                                         | buyer                    | the ways with the tax of each and the refusal                    |
| `GET /api/orders/:orderId/documents`, `.../documents/:documentId/pdf`               | buyer (own), admin, root | the documents and the receipts, the PDF                          |
| `POST /api/orders/:orderId/documents/:documentId/receipt-confirmation`              | admin, root              | a receipt made by hand at the provider                           |
| `GET /api/orders/:orderId/shipments/:shipmentId/customs-invoice`                    | admin, root              | the commercial invoice of a parcel with the tax number, to print |
| `GET /api/admin/reports/vat`                                                        | admin, root              | the tax of a period                                              |
| `PUT /api/admin/alerts/seen/:kind`                                                  | admin, root              | close a kind that informs                                        |

## Before the launch

- **The countries.** root writes the record of every country the shop sells to, its own included, the tax groups with their rates, the thresholds and their periods, the limits of a parcel and the texts of the exemption; in Spain `maxOrderTotal` 3000. The numbers of the thresholds are the law of each country and change with it.
- **fiskaly.** A managed organization of the shop at fiskaly with the real NIF, the agreement it asks for (PAdES), its keys on the server (`FISKALY_API_KEY`, `FISKALY_API_SECRET`, `FISKALY_ENVIRONMENT=live`) and `RECEIPT_PROVIDER=fiskaly`; then root writes `receiptMoment`. The first real receipt is checked at the tax authority. On TEST a made-up NIF of the right form is registered; whether the real one compares the name with the register is seen on LIVE.
- **ShippyPro.** The IOSS number in the profile of the account when the shop has one; the first real parcel with a commercial invoice is sent with a carrier that takes it electronically, and its papers are checked with the carrier, and whether the carrier asks for the EORI of the shop (the commercial invoice carries none) or has it from the profile or the contract.
