# Status

> **Stage:** backend API in active development, the storefront comes on top of it · **Tests:** 15,000+ on every push, unit and integration on a real PostgreSQL and Redis

## ✅ Done

| Area                                                               | What works                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 🛍️ [Catalog](variants.md)                                          | variants (a size, a colour, a memory), characteristics, filters, search, reviews, favorites                        |
| 📦 Stock                                                           | batches with expiry dates, deliveries, write-offs, reservation, a log of every change, an accounting report        |
| 💳 [Orders and payments](payments.md)                              | cart, delivery by the shop and pickup, Stripe payment pages and webhook, refunds followed to the end               |
| ↩️ [Returns](returns.md)                                           | the EU withdrawal by the account or a public form, the goods taken back, the money back through the provider       |
| 🔐 Accounts and security                                           | JWT with refresh, OAuth (Google, GitHub, LinkedIn), roles, CSRF, request limits, a captcha, row level security     |
| 📣 [Newsletters](newsletters.md)                                   | a double opt-in, campaigns in several languages, a sending pass with retries, a webhook for bounces and complaints |
| 💬 Support                                                         | WebSocket chat, an OpenAI assistant that knows the catalog, a hand-over to an admin                                |
| 📊 Admin                                                           | journals, alerts, statistics, the product safety data of the EU (GPSR)                                             |
| ⚖️ Terms and privacy                                               | versioned terms, contract and privacy policy with consents, terms of keeping personal data, an export of the data  |
| 🌍 [Shop settings](shop-settings.md) and [languages](languages.md) | the data of the shop root changes without a deploy, every mail in English, Ukrainian or Spanish                    |
| 📘 [API docs](api.md)                                              | Swagger / OpenAPI, checked against every answer of the integration tests                                           |

## 🔄 Next Up

- Google Pay and Apple Pay through Stripe, and the events of Stripe made outside the app (a refund by hand, a dispute)

## ⏭️ Later

1. delivery through carriers and international delivery
2. taxes (VAT), fiscal receipts and invoices
3. two-factor login for the admins, a full set of audit journals
4. hardening for heavy traffic: concurrent requests, timeouts and retries
5. a security review and a polish of the whole code base
6. Docker, the periodic tasks (the newsletters, the cleanups, backups) and a load run
7. prices that follow the demand (an experiment)
8. the full documentation and a launch checklist
9. a storefront on this API

## 🌱 Built to Grow

- **Ready for a storefront:** every route, answer and error code is described in Swagger, so a frontend is built against a documented API
- **A new language is a dictionary:** the mails speak the language of their reader, and one more language needs no change of the code
- **A new payment provider is a module:** providers stand side by side, a new one joins Stripe without bending it
- **Rules live in the database:** roles, row level security and functions keep every client of the API, present or future, within the same limits
