# Status

> **Stage:** backend API in active development, the storefront comes on top of it · **Tests:** 17,000+ on every push, unit and integration on a real PostgreSQL and Redis

## ✅ Done

| Area                                                               | What works                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🛍️ [Catalog](variants.md)                                          | variants (a size, a colour, a memory), characteristics, filters, search, reviews, favorites                                                                                                                                                                                                                                              |
| 📦 Stock                                                           | batches with expiry dates, deliveries, write-offs, reservation, a log of every change, an accounting report                                                                                                                                                                                                                              |
| 💳 [Orders and payments](payments.md)                              | cart, a card with Google Pay and Apple Pay, PayPal and Bizum on the page of Stripe                                                                                                                                                                                                                                                       |
| 🚚 [Delivery](delivery.md)                                         | the carriers of ShippyPro with their prices for the address, delivery zones, customs data, an order in several parcels and boxes, labels in one click, the parcels followed by the events of the carrier, voids, refusals and lost parcels                                                                                               |
| 💶 [Money and disputes](disputes.md)                               | a journal of every movement of money, refunds followed to the end, disputes at the bank followed by the app itself, money given back by hand or by a bank shared among the goods, compensations, money that came back, alerts and reports of all of it                                                                                   |
| ↩️ [Returns](returns.md)                                           | the EU withdrawal by the account or a public form, every parcel of a return, the goods taken back, the money back through the provider or outside the app (in parts when the payment holds less), what each statement still owes                                                                                                         |
| 🔐 [Accounts and security](two-factor.md)                          | JWT with refresh, OAuth (Google, GitHub, LinkedIn), a second step at the login of the staff (an authenticator app, recovery codes, trusted browsers), roles, CSRF, request limits, a captcha, row level security                                                                                                                         |
| 📣 [Newsletters](newsletters.md)                                   | a double opt-in, campaigns in several languages, a sending pass with retries, a webhook for bounces and complaints                                                                                                                                                                                                                       |
| 💬 Support                                                         | WebSocket chat, an OpenAI assistant that knows the catalog, a hand-over to an admin                                                                                                                                                                                                                                                      |
| 📊 Admin                                                           | journals filtered by every column with their sums and groups, alerts, statistics, the product safety data of the EU (GPSR)                                                                                                                                                                                                               |
| ⚖️ Terms and privacy                                               | versioned terms, contract and privacy policy with consents, terms of keeping personal data, an export of the data                                                                                                                                                                                                                        |
| 🧾 [Taxes](taxes.md)                                               | VAT of a shop of almost any country by the rules root sets: the countries, thresholds by a year or the last 12 months, limits of a parcel, tax groups; invoices and credit notes (one for each real movement of the money), fiscal receipts (fiskaly in Spain), the tax number on a parcel across customs, a report for the declarations |
| 🌍 [Shop settings](shop-settings.md) and [languages](languages.md) | the data of the shop root changes without a deploy, every mail in English, Ukrainian or Spanish                                                                                                                                                                                                                                          |
| 🔌 [Outside services](providers.md)                                | payments, delivery, mail, files, the models, the captcha and the login elsewhere, each behind an interface of its kind                                                                                                                                                                                                                   |
| 📘 [API docs](api.md)                                              | Swagger / OpenAPI, checked against every answer of the integration tests                                                                                                                                                                                                                                                                 |

## 🔄 Next Up

- a full audit trail

## ⏭️ Later

1. a catalog in several languages
2. readiness for heavy traffic and growth
3. a review of the whole code base and the full documentation
4. production infrastructure and automation

## 🌱 Built to Grow

- **Ready for a storefront:** every route, answer and error code is described in Swagger, so a frontend is built against a documented API
- **A new language is a dictionary:** the mails speak the language of their reader, and one more language needs no change of the code
- **A new provider is a folder:** every outside service sits behind an interface of its kind; a new provider of payments, of delivery, of mail, of files, of the models, of the captcha or of accounts joins the ones of today with a folder and a line in a registry, and runs through the same contract tests
- **Money that adds up:** every movement of money is a line of one journal, written by the database with the change it belongs to, so the reports, the alerts and the cards never disagree
- **Rules live in the database:** roles, row level security and functions keep every client of the API, present or future, within the same limits
