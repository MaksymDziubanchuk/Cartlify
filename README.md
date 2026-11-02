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

Cartlify is a portfolio project: a REST API with the parts a real shop needs, from the catalog to the accounting report. The storefront is not here yet, the API is documented in Swagger, and the project is in active development ([status](docs/status.md)).

## ✨ What It Does

| Area                       | What is there                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 🛍️ **Catalog**             | products with variants (a size, a colour, a memory), a directory of characteristics, filters of the catalog, search, reviews, favorites |
| 📦 **Stock**               | batches with expiry dates, deliveries, write-offs, reservation for orders, a log of every change                                        |
| 💳 **Orders and payments** | cart, delivery, consents to the terms, Stripe payment pages and webhook, refunds, mails                                                 |
| 🔐 **Accounts**            | JWT in HttpOnly cookies with refresh, OAuth (Google, GitHub, LinkedIn), roles, sessions, data export                                    |
| 💬 **Support**             | real-time chat over WebSocket with an OpenAI assistant that knows the catalog and hands a talk over to an admin                         |
| 📊 **Admin**               | journals, alerts, statistics, accounting reports, the product safety data an offer needs in the EU                                      |

## 🧱 How It Is Built

- **Rules in the database.** Roles, row level security, functions and triggers live in SQL scripts; the API connects as a role that cannot step over them, and every request runs as its own actor.
- **Thin layers.** Each module goes routes → controllers → services, with JSON schemas and DTO types next to it.
- **Tests on the real stack.** Unit and integration tests run against a disposable PostgreSQL and Redis in Docker on every push; the structure of the built database is compared with a committed snapshot.
- **An API held to its docs.** Every answer of the integration tests is checked against the OpenAPI document, and a test checks that the document describes every route, code and example.

Also in use: Stripe, Cloudinary, SendGrid, OpenAI, Jest, GitHub Actions. More in [architecture](docs/architecture.md).

## 🚀 Quick Start

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm install
cp .env.example .env
```

Fill `.env` ([configuration](docs/configuration.md)), build the database with its roles, migrations and SQL scripts and start Redis ([local setup](docs/setup.md)), then:

```bash
npm run dev    # the API with reload, Swagger UI at http://localhost:3000/documentation
npm test       # pick the test parts; the integration ones need Docker
```

Every command: [commands](docs/commands.md).

## 📚 Documentation

| Document                               | What it covers                                                            |
| -------------------------------------- | ------------------------------------------------------------------------- |
| [Features](docs/features.md)           | what the API does, module by module                                       |
| [Variants](docs/variants.md)           | products, variants, characteristics, stock, lists and filters             |
| [API](docs/api.md)                     | the REST modules, Swagger / OpenAPI, the realtime chat                    |
| [Architecture](docs/architecture.md)   | goals, stack, structure of the repository, the database, production notes |
| [Configuration](docs/configuration.md) | every environment variable                                                |
| [Local setup](docs/setup.md)           | the database, Redis and the app on your machine                           |
| [Commands](docs/commands.md)           | build, start, migrations, tests, demo data, a copy of prod for dev        |
| [Status](docs/status.md)               | where the project stands                                                  |

## License

Copyright (c) 2025-2026 Maksym Dziubanchuk. All rights reserved.

The source code is public only to be viewed as part of the author's portfolio. It is not open source: using, copying, modifying, distributing or deploying it, in whole or in part, needs prior written permission from the author. See [LICENSE](LICENSE).
