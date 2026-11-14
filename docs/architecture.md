# Architecture

## Project Goals

Cartlify was built to demonstrate backend engineering decisions that are relevant in a real commercial project:

- modular Fastify architecture
- strict TypeScript boundaries between controllers, services, DTOs, and schemas
- PostgreSQL-first design with custom SQL layer, RLS, functions, views, and indexes
- role-based access control for `GUEST`, `USER`, `ADMIN`, and `ROOT`
- a catalog of products with variants (a size, a colour), pictures a variant picks from the gallery of its product, a directory of characteristics, and stock in batches with a log of every change
- consistent order flow with background timeout handling
- real-time support chat with guest/user/admin flows
- AI-assisted product and support conversations with fallback behavior
- shop data root changes without a deploy (a table with versions, not environment variables) and mails, the chat bot and the payment page that answer in the customer's own language, through a shared dictionary (i18next)
- documented REST API surface through Swagger/OpenAPI
- API design that can later support SSR, GraphQL, and additional real-time features

## Technology Stack

| Area                          | Technologies                                                                | Status      |
| ----------------------------- | --------------------------------------------------------------------------- | ----------- |
| Runtime                       | Node.js, TypeScript                                                         | Implemented |
| Web framework                 | Fastify                                                                     | Implemented |
| Database access               | PostgreSQL, Prisma                                                          | Implemented |
| DB hardening layer            | raw SQL scripts for roles, schema, RLS, views, functions, triggers, indexes | Implemented |
| Authentication                | JWT, HttpOnly cookies, refresh flow                                         | Implemented |
| Authorization                 | RBAC + PostgreSQL RLS context                                               | Implemented |
| API documentation             | Swagger / OpenAPI                                                           | Implemented |
| Realtime chat                 | WebSocket chat endpoint and event-based messaging                           | Implemented |
| AI assistant                  | OpenAI-powered chatbot service with product/support context                 | Implemented |
| Payments                      | Stripe payment pages (card with Google Pay and Apple Pay, PayPal, Bizum) and webhook, a money journal, refunds, disputes followed to their end | Implemented |
| Media                         | Cloudinary                                                                  | Implemented |
| Email                         | SendGrid: a stream for the orders, one of its own for the newsletters       | Implemented |
| Captcha                       | Cloudflare Turnstile on the forms that mail or open an account              | Implemented |
| OAuth                         | Google, GitHub, LinkedIn                                                    | Implemented |
| Cache / background processing | Redis, order timeout worker, the money worker, the lock of the newsletter pass | Implemented |
| Internationalization          | i18next, a dictionary file per language (`src/locales/`)                   | Implemented |
| Lint / formatting             | ESLint, Prettier                                                            | Implemented |
| Testing                       | Jest unit and integration tests, PostgreSQL and Redis in Docker             | Implemented |
| CI utilities                  | GitHub Actions for tests, DB migration and SQL execution                    | Implemented |

## Project Structure

```text
Cartlify/
├── db/
│   ├── schema/                 # raw SQL, see "The database" below: roles, extensions, RLS, views, functions, indexes
│   ├── data/                   # the scripts that clear data stay local, not in git
│   └── tools/                  # test database build, structure snapshot (the reference of the structure), anonymized copy of prod for dev, demo data
├── prisma/                     # Prisma schema and migrations (tables only)
├── src/
│   ├── config/                 # env and service configs, the shop settings module, i18next (src/locales/*.json)
│   ├── locales/                # one dictionary file per language the server answers in (en.json, uk.json, es.json)
│   ├── db/                     # Prisma client and transactions, DB actor context, admin log writer, names of variants, expired stock, cost of the last delivery
│   ├── helpers/                # shared helpers / normalizers (fields of variants, characteristics, parties, the filter by characteristics, locale)
│   ├── jobs/                   # commands run on a schedule, not by a request: the pass of the newsletters (npm run newsletter:run)
│   ├── middlewares/            # auth, RBAC, logging, error handling, id validation
│   ├── plugins/                # Fastify plugins, including Swagger/OpenAPI registration
│   ├── redis/                  # Redis client and keys
│   ├── routes/api/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── products/           # products, variants, gallery, prices and sales, stock, reviews
│   │   ├── attributes/         # directory of characteristics and the sets a category asks for
│   │   ├── parties/            # manufacturers and persons responsible in the EU
│   │   ├── documents/          # PDF documents of products
│   │   ├── categories/
│   │   ├── favorites/
│   │   ├── orders/
│   │   ├── returns/            # statements of withdrawal and of return, the money back
│   │   ├── withdrawals/        # the public form of withdrawal, no account needed
│   │   ├── payments/
│   │   ├── delivery/
│   │   ├── reviews/
│   │   ├── admin/
│   │   ├── root/
│   │   ├── newsletters/        # the subscription, the pages behind the mail links, campaigns, subscribers, the blocklist, the SendGrid webhook
│   │   ├── shopSettings/       # the data of the shop root changes without a deploy (public, admin and root routes)
│   │   ├── system/             # health, readiness, project info
│   │   ├── chat/
│   │   └── legal/
│   ├── schemas/                # shared AJV schemas and DTO schemas
│   ├── services/               # cross-module services
│   │   └── email/templates/    # mails as .html and .txt files with {{marks}}: auth/, newsletters/, orders/, returns/, users/
│   ├── types/                  # DTOs and shared TypeScript types
│   ├── utils/                  # JWT, OAuth, Cloudinary, app errors
│   └── workers/                # background workers
├── tests/
│   ├── unit/                   # no database or network, mirrors src/ paths
│   ├── integration/            # api/<module>, db, flows, worker against the Docker test stack; every answer is held against the Swagger document
│   ├── helpers/                # app startup for app.inject, test environment guard
│   ├── fixtures/               # static files used by tests
│   ├── setup/                  # per-project jest setup, keeps the local .env out of tests
│   ├── coverage/               # generated coverage report (gitignored)
│   └── run.mjs                 # test launcher behind npm test
├── docker-compose.test.yml     # disposable PostgreSQL and Redis for integration tests
├── .github/workflows/          # tests, DB migration and SQL execution workflows
└── package.json
```

## The Database

The database is built from the Prisma migrations (tables only) and six SQL scripts, and the rest of the rules live there, not in the server:

| Script                                     | What it holds                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema/01_roles_and_schemas.sql`       | the schema, the roles (`cartlify_owner`, `cartlify_app`, `cartlify_readonly`), their rights, the list of functions the app may call; run first and again last, as a superuser |
| `db/schema/02_extensions.sql`              | the extensions (`pg_trgm`, `unaccent`) and the index of the name search of products; run as a superuser after the migrations                                                  |
| `db/schema/05_fn_and_triggers.sql`         | functions and triggers: stock and batches, orders, reviews, the names of variants, the stock log, the money journal, refunds, disputes and holds, the guards of columns       |
| `db/schema/03_policies_and_rls.sql`        | row level security policies, driven by the actor of the transaction (role, user, guest)                                                                                       |
| `db/schema/04_views.sql`                   | views: the statistics of the admin, the required characteristics of a category, the variants that lack one                                                                    |
| `db/schema/06_indexes_and_constraints.sql` | indexes and checks Prisma cannot express                                                                                                                                      |

The order of a build is `01`, the migrations, `02`, `05`, `03`, `04`, `06`, `01` again (`db/tools/test_db_build.mjs`). Every script runs again without a change, and `npm run db:snapshot:check` compares the structure of a database with the reference `db/tools/structure_snapshot.txt`.

The scripts are for setting a database up, a new one or one the app is stopped for, never for a database a running server uses: they recreate triggers, policies and checks in one transaction with the strongest locks, and the queries of a running server (its workers read the tables every few seconds) end such a run in a deadlock, with nothing changed. The commands and the order are in [commands](commands.md).

The catalog model, in tables: `products` (what variants share), `product_variants` (price, sale, stock, codes, weight and sizes), `product_images` (the gallery) and `variant_images` (the pictures a variant shows, in its own order), `attribute_groups`, `attributes`, `attribute_options`, `category_attributes` (the directory of characteristics and the sets a category asks for) and `variant_attribute_values` (the values a variant has), `parties` and `documents` with `product_documents` (GPSR data), `product_batches` with `order_batch_allocations` (stock in batches and which batch a sale took) and `stock_log` (a line for every change of the stock of a variant, only added to). Orders, carts, favorites and the log of prices point to the variant (`variantId`) next to the product. See [Products, variants and characteristics](variants.md).

The money, in tables: `money_log` (a line for every movement of money of an order, a statement or a dispute, the sum signed, only added to: its guard `money_log_append_only` lets a few fields be written once, from empty, and nothing else) and `payment_disputes` (the description and the current state of a dispute at the bank, without a sum). Next to them the current state stays where it is read: `orders.holds` (what holds a paid order from its sending) and `orders.fraudWarnedAt`, `returns.refundedTotal` (counted by a trigger from the journal), `return_items.moneyLogId` (the line that put the money of a row where it is); the costs of the sends and of the parcels back are lines of the journal, not columns. Only functions of `05` write the journal, each in the transaction that changes the state, through the internal `log_money_change` (the app cannot call it): `pay_order` (the payment in two parts), `record_late_payment`, `begin_payment_refund`, `begin_return_refund` (a transfer in parts, with what the decisions on money already with the buyer give its rows, `cover_return_rows`), `settle_money_refund` (the one end of every refund of the app), `record_hand_refund`, `record_refund_bank_reference`, `mark_return_refunded_outside`, `mark_payment_refund_outside`, `record_return_shipment` and `set_return_shipment_cost`, `record_order_shipment_cost`, `sync_payment_dispute` (a dispute from a snapshot of Stripe, its money once for each balance transaction, the hold of the order), `mark_dispute_drafted`, `hold_payment_review`, `release_payment_review`, `hold_fraud_warning`, `begin_compensation` (a compensation by the button of the app), `record_money_received` and `record_carrier_money` (money the shop got back outside the app), `decide_order_hold`, `decide_money_use` and `share_money_line` (what money given back by hand or taken by a bank was for, `write_money_use`). A trigger of the orders refuses the step of a held order to shipped (`ORDER_ON_HOLD`). See [Payments](payments.md) and [Disputes](disputes.md).

The newsletters, in tables: `newsletter_subscriptions` (the current state of a subscription), `newsletter_subscription_events` (its journal, only added to), `newsletter_campaigns`, `newsletter_recipients` (a row for each subscriber a campaign goes to) and `newsletter_form_blocklist` (a keyed hash of an address, no address). Nobody but the database functions of `05` writes the subscriptions and their journal; the right to run the newsletters is a column of `users` that only a function of root changes ([newsletters](newsletters.md)).

## Production Notes

This repository is still in active development and should not be treated as a fully production-ready deployment package yet.

Current production-oriented pieces already present:

- PostgreSQL RLS and custom SQL hardening scripts
- separate runtime and migration database credentials
- Redis-backed order timeout worker, and a money worker on the database alone (refunds in transit, disputes whose step did not finish)
- JWT cookie auth with refresh-token flow
- OAuth support
- structured backend module boundaries
- Swagger/OpenAPI documentation deployed with the running API
- unit and integration tests on every push in GitHub Actions
