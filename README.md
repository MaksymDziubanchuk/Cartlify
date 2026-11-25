<div align="center">

# Cartlify

**The backend of an online shop, built the way a commercial one is built.**

[![Tests](https://github.com/MaksymDziubanchuk/Cartlify/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/MaksymDziubanchuk/Cartlify/actions/workflows/tests.yml)
![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-8-FF4438?logo=redis&logoColor=white)
![License](https://img.shields.io/badge/license-all_rights_reserved-lightgrey)

[Features](docs/features.md) · [Variants](docs/variants.md) · [API](docs/api.md) · [Architecture](docs/architecture.md) · [Setup](docs/setup.md)

</div>

---

Cartlify is a portfolio project: a REST API with the parts a real shop needs, from the catalog to the accounting report. The API is documented in Swagger, the storefront comes on top of it, and the project is in active development ([status](docs/status.md)).

**Why Cartlify:** every outside service a block of its own, money that adds up, rules the API cannot step over, the rules of the EU, 17,000+ tests — [advantages](docs/advantages.md).

## ✨ What It Does

| Area                       | What is there                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🛍️ **Catalog**             | products with variants (a size, a colour, a memory), a directory of characteristics, filters of the catalog, search, reviews, favorites                                          |
| 📦 **Stock**               | batches with expiry dates, deliveries, write-offs, reservation for orders, a log of every change                                                                                 |
| 💳 **Orders and payments** | cart, delivery, consents to the terms, a card with Google Pay and Apple Pay, PayPal and Bizum on the page of Stripe, mails                                                       |
| 🚚 **Delivery**            | the carriers of a delivery provider priced for the address, zones of the shop, customs data, an order in several parcels and boxes with their labels, the events of the carriers |
| 💶 **Money**               | a journal of every movement of money (the payments, the refunds, the costs of the parcels), refunds followed to the end, disputes at the bank followed by the app itself         |
| 🧾 **Taxes and receipts**  | the tax of a sale by the country of the buyer (thresholds, OSS, imports, exports), invoices and credit notes in PDF, fiscal receipts registered through a provider, a VAT report |
| ↩️ **Returns**             | the withdrawal within the EU term by the account or a public form, the goods taken back, the money back through the provider                                                     |
| 🔐 **Accounts**            | JWT in HttpOnly cookies with refresh, OAuth (Google, GitHub, LinkedIn), a second step at the login of the staff, roles, sessions, a captcha on the public forms, data export     |
| 📣 **Newsletters**         | a consent of its own with a double opt-in for guests, one unsubscribe, campaigns in several languages, a mail stream of its own                                                  |
| 💬 **Support**             | real-time chat over WebSocket with an OpenAI assistant that knows the catalog and hands a talk over to an admin                                                                  |
| 🌍 **Languages**           | every mail in the language of its reader (English, Ukrainian, Spanish), the data of the shop root changes without a deploy                                                       |
| 📊 **Admin**               | journals, alerts, statistics, accounting reports, the product safety data an offer needs in the EU                                                                               |

## 🧱 How It Is Built

- **Rules in the database.** Roles, row level security, functions and triggers live in SQL scripts; the API connects as a role that cannot step over them, and every request runs as its own actor.
- **Thin layers.** Each module goes routes → controllers → services, with JSON schemas and DTO types next to it.
- **Money that follows itself.** Every movement of money is a line of one journal, only added to, written by the database in the same transaction as the change it belongs to; the reports, the alerts and the cards read it. A dispute at the bank is followed from its first event to its end: the parcel is held, a draft of the evidence is put at Stripe, and when the bank decides the app sends the money that waited, or cancels the order and sends the rest ([disputes](docs/disputes.md)).
- **Outside services you can swap.** Payments, delivery, the tax, the fiscal receipts, mail, files, the models, the captcha and the login with an account elsewhere each sit behind an interface of their kind; a provider lives in a folder of its own, and a new one with the same function is a folder and a line in a registry, with nothing else of the app or of the database to change. A test keeps the name of every provider in its folder, and one contract for each kind runs every provider through the same tests ([providers](docs/providers.md)).
- **Tests on the real stack.** Unit and integration tests run against a disposable PostgreSQL and Redis in Docker on every push; the structure of the built database is compared with a committed snapshot.
- **An API held to its docs.** Every answer of the integration tests is checked against the OpenAPI document, and a test checks that the document describes every route, code and example.

Also in use: Stripe, ShippyPro, fiskaly, Cloudinary, SendGrid, OpenAI, Cloudflare Turnstile, Google, GitHub and LinkedIn sign-in (the providers of today, [providers](docs/providers.md)), Jest, GitHub Actions. More in [architecture](docs/architecture.md).

## 🚀 Quick Start

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm ci
cp .env.example .env
```

Fill `.env` ([configuration](docs/configuration.md)), build the database with its roles, migrations and SQL scripts and start Redis ([local setup](docs/setup.md)), then:

```bash
npm run dev    # the API with reload, Swagger UI at http://localhost:3000/documentation
npm test       # pick the test parts; the integration ones need Docker
```

Every command: [commands](docs/commands.md).

## 📚 Documentation

| Document                                     | What it covers                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| [Advantages](docs/advantages.md)             | why Cartlify: swappable services, the money, the rules, the EU, the tests     |
| [Features](docs/features.md)                 | what the API does, module by module                                           |
| [Variants](docs/variants.md)                 | products, variants, characteristics, stock, lists and filters                 |
| [Payments](docs/payments.md)                 | the ways to pay, the money journal, refunds, holds, the webhook               |
| [Disputes](docs/disputes.md)                 | disputes at the bank followed by the app, the Stripe dashboard                |
| [Returns](docs/returns.md)                   | withdrawal and returns, the money back, personal data and its terms           |
| [Delivery](docs/delivery.md)                 | methods, zones, customs, carriers, parcels and boxes, events, voids           |
| [Taxes](docs/taxes.md)                       | the tax of a sale, invoices and credit notes, fiscal receipts, the VAT report |
| [Return scenarios](docs/return-scenarios.md) | each case of a withdrawal or a return, step by step, with the routes          |
| [Shop settings](docs/shop-settings.md)       | the data of the shop root changes without a deploy, a row a setting           |
| [Languages](docs/languages.md)               | how the server picks a language, mails, the chat bot and payment pages        |
| [Newsletters](docs/newsletters.md)           | subscription, the pages behind the mail links, campaigns, sending, setup      |
| [API](docs/api.md)                           | the REST modules, Swagger / OpenAPI, the realtime chat                        |
| [Architecture](docs/architecture.md)         | goals, stack, structure of the repository, the database, production notes     |
| [Providers](docs/providers.md)               | the outside services behind an interface of their kind, adding a provider     |
| [Configuration](docs/configuration.md)       | every environment variable                                                    |
| [Local setup](docs/setup.md)                 | the database, Redis and the app on your machine                               |
| [Commands](docs/commands.md)                 | build, start, migrations, tests, demo data, a copy of prod for dev            |
| [Status](docs/status.md)                     | where the project stands                                                      |

## License

Copyright (c) 2025-2026 Maksym Dziubanchuk. All rights reserved.

The source code is public only to be viewed as part of the author's portfolio. It is not open source: using, copying, modifying, distributing or deploying it, in whole or in part, needs prior written permission from the author. See [LICENSE](LICENSE).
