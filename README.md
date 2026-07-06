# Cartlify

Backend-first e-commerce platform built as a production-oriented portfolio project.

Cartlify is not presented as a finished storefront. It is a realistic engineering project focused on how a commercial e-commerce backend is structured: authentication, RBAC, catalog management, order flow, PostgreSQL policies, background jobs, real-time support chat, AI-assisted customer support, maintainable module boundaries, and documented REST API behavior.

The repository currently contains a working REST API foundation, PostgreSQL hardening scripts, Redis-based order timeout processing, OAuth/media/email integrations, WebSocket-based chat, Swagger/OpenAPI documentation, and an OpenAI-powered assistant for product and support conversations. Some parts of the roadmap are already implemented, some are partially scaffolded, and some are planned for the next stages.

---

## Table of Contents

- [Project Goals](#project-goals)
- [Current Status](#current-status)
- [Technology Stack](#technology-stack)
- [Implemented Features](#implemented-features)
- [In Progress / Planned](#in-progress--planned)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Local Setup](#local-setup)
- [Run Commands](#run-commands)
- [API Surface](#api-surface)
- [API Documentation](#api-documentation)
- [Realtime Chat / AI Bot](#realtime-chat--ai-bot)
- [Production Notes](#production-notes)

---

## Project Goals

Cartlify was built to demonstrate backend engineering decisions that are relevant in a real commercial project:

- modular Fastify architecture
- strict TypeScript boundaries between controllers, services, DTOs, and schemas
- PostgreSQL-first design with custom SQL layer, RLS, functions, views, and indexes
- role-based access control for `GUEST`, `USER`, `ADMIN`, and `ROOT`
- consistent order flow with background timeout handling
- real-time support chat with guest/user/admin flows
- AI-assisted product and support conversations with fallback behavior
- documented REST API surface through Swagger/OpenAPI
- API design that can later support SSR, GraphQL, and additional real-time features

---

## Current Status

**Repository maturity:** active development

What this repo already shows well:

- a non-trivial e-commerce domain model
- a real REST API structure with multiple modules
- authentication and authorization flows beyond basic login/logout
- PostgreSQL hardening beyond default Prisma usage
- background processing with Redis
- WebSocket-based chat flow
- OpenAI-powered chatbot integration
- guest-to-user chat continuity and admin escalation flow
- Swagger/OpenAPI documentation for the REST API

What is important to state honestly:

- the project is **not feature-complete yet**
- GraphQL exists in the repository as draft code, but is **not wired into the running app**
- SSR templates exist in the repo, but the storefront/UI layer is **not the finished focus of the current stage**
- WebSocket chat and OpenAI chatbot logic are implemented, but the admin-chat workflow is still being actively refined
- Swagger/OpenAPI is implemented and available, but route security metadata, operation ids, examples, and response descriptions are still being refined
- test coverage, Dockerized deployment, and broader observability are **planned**, not done in this snapshot

---

## Technology Stack

### Implemented in the current codebase

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
| Media                         | Cloudinary                                                                  | Implemented |
| Email                         | SendGrid                                                                    | Implemented |
| OAuth                         | Google, GitHub, LinkedIn                                                    | Implemented |
| Cache / background processing | Redis, order timeout worker                                                 | Implemented |
| Lint / formatting             | ESLint, Prettier                                                            | Implemented |
| CI utilities                  | GitHub Actions for DB migration / SQL execution                             | Implemented |

### Present in the repo, but not fully integrated into runtime

| Area              | Technologies                                         | Status                     |
| ----------------- | ---------------------------------------------------- | -------------------------- |
| GraphQL           | `graphql`, `@apollo/server`, schema/resolvers folder | Draft / not wired into app |
| SSR UI foundation | Handlebars templates, static assets                  | Partial foundation         |

### Planned stack / next steps

| Area                     | Planned technologies                          | Status  |
| ------------------------ | --------------------------------------------- | ------- |
| Testing                  | Jest, Supertest, PostgreSQL integration tests | Planned |
| API docs refinement      | security metadata, operation ids, examples    | Planned |
| Deployment               | Docker, AWS ECS/Fargate                       | Planned |
| SSR delivery layer       | detachable Handlebars-based web module        | Planned |
| Production observability | broader monitoring / metrics / reporting      | Planned |

---

## Implemented Features

### Authentication and user flows

- user registration
- email verification flow
- resend verification email
- login / logout
- refresh token rotation
- forgot password / reset password
- OAuth entry points and callbacks for Google, GitHub, and LinkedIn
- guest-to-user data migration during login/OAuth flows
- guest chat continuity after login/OAuth
- user profile read/update endpoints
- login logging

### Authorization and security

- role model: `GUEST`, `USER`, `ADMIN`, `ROOT`
- Fastify route guards
- database-level row-level security policies
- per-transaction actor context passed into PostgreSQL
- cookie-based auth flow with signed cookies
- centralized error normalization and request/response logging

### Catalog and product management

- category listing and admin CRUD
- product listing with filtering / pagination helpers
- product details endpoint
- admin product CRUD
- product image upload flow
- product category reassignment
- bulk price update endpoint for admin/root
- product view/popularity-related fields in the data model

### Reviews and favorites

- product reviews
- review deletion rules for user/admin/root
- review voting endpoint
- favorites for guest/user flows

### Orders

- current order/cart retrieval
- add/update/remove current order items
- confirm current order
- order history endpoint
- order by id endpoint
- admin/root order status update endpoint
- Redis-based timeout worker for order reservation expiry handling

### Chat and AI assistant

- current chat thread endpoint for guest/user sessions
- WebSocket connection endpoint for realtime messaging
- thread join/read/message events
- bot welcome message for newly created chat threads
- guest and authenticated-user chat flows
- OpenAI-powered chatbot responses
- product-aware bot answers based on product context
- automatic response language matching based on the latest customer message
- bot fallback behavior when AI response generation fails
- admin escalation flow for authenticated users
- guest admin-support guard that asks guests to log in or create an account first
- admin queue state model based on `adminRequestedAt` and `adminUnreadSince`
- message read-state handling for bot/user/admin chat scenarios

### Admin and root capabilities

- admin stats endpoint
- manual product popularity endpoint
- admin chat queue endpoints
- root-only admin management endpoints

### System endpoints

- `/health`
- `/ready`
- `/info`

### API documentation

- Swagger UI for REST API documentation
- OpenAPI 3.0.3 specification generation
- grouped route documentation by domain module
- reusable response schemas for system endpoints
- cookie-based security schemes for access token, refresh token, and guest id flows
- documented system readiness responses for healthy and unavailable states
- raw OpenAPI JSON endpoint for external inspection and tooling
- Swagger documentation is deployed together with the running API

Current API documentation refinement work:

- adding security metadata to all protected routes
- adding operation ids for cleaner generated API documentation
- improving summaries and descriptions for all domain modules
- replacing generic response descriptions with explicit response meanings
- adding request and response examples
- adding server entries for local and deployed environments

---

## In Progress / Planned

### In progress / partial

- GraphQL folder exists, but the app currently runs as REST-only
- Handlebars templates and static assets exist, but the SSR layer is not a finished storefront
- admin chat queue behavior is implemented, but still being refined through manual testing
- seeding approach exists on the database side, but there is no finalized end-to-end local seed command in this snapshot
- Swagger/OpenAPI documentation is implemented, but route metadata is still being refined

### Planned

- automated tests with Jest, Supertest, and PostgreSQL integration coverage
- Swagger/OpenAPI refinement for protected routes, operation ids, examples, and response descriptions
- detachable SSR/web layer for showcase pages without coupling business logic to the UI
- Dockerized local/dev/prod workflow and a production deployment target on AWS ECS/Fargate
- broader admin analytics, observability, and reporting

---

## Project Structure

```text
Cartlify/
├── db/                         # raw SQL: roles, schema, RLS, views, functions, indexes
├── prisma/                     # Prisma schema and migrations
├── src/
│   ├── config/                 # env and service configs
│   ├── db/                     # Prisma context helpers, DB actor context
│   ├── helpers/                # shared helpers / normalizers
│   ├── middlewares/            # auth, RBAC, logging, error handling, id validation
│   ├── plugins/                # Fastify plugins, including Swagger/OpenAPI registration
│   ├── redis/                  # Redis client and keys
│   ├── routes/api/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── products/
│   │   ├── categories/
│   │   ├── favorites/
│   │   ├── orders/
│   │   ├── reviews/
│   │   ├── admin/
│   │   ├── root/
│   │   └── chat/
│   ├── schemas/                # shared AJV schemas and DTO schemas
│   ├── services/               # cross-module services
│   ├── types/                  # DTOs and shared TypeScript types
│   ├── utils/                  # JWT, OAuth, Cloudinary, app errors
│   ├── views/                  # Handlebars templates (foundation only)
│   └── workers/                # background workers
├── .github/workflows/          # DB migration and SQL execution workflows
└── package.json
```

---

## Environment Variables

The repository already contains `.env.example`, but for the current runtime you should also include the variables used by `src/config/env.ts`.

A practical local example:

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
WEB_ORIGIN=http://localhost:3000

# PostgreSQL
DATABASE_URL=postgresql://cartlify_app:your_password@localhost:5432/cartlify_dev
MIGRATION_DATABASE_URL=postgresql://cartlify_owner:your_password@localhost:5432/cartlify_dev
DEV_SHADOW_DATABASE_URL=postgresql://cartlify_owner:your_password@localhost:5432/cartlify_shadow

# Auth / cookies
COOKIE_SECRET=replace_this_cookie_secret
JWT_ACCESS_SECRET=replace_this_access_secret
JWT_ACCESS_TTL_SHORT=1200
JWT_ACCESS_TTL_LONG=3600
JWT_REFRESH_SECRET=replace_this_refresh_secret
JWT_REFRESH_TTL_SHORT=86400
JWT_REFRESH_TTL_LONG=2592000
GUEST_ID_TTL=157680000
RESET_TTL_MS=3600000
BCRYPT_ROUNDS=12

# Redis
REDIS_URL=redis://localhost:6379
REDIS_ORDER_TIMEOUT_WORKER_MS=3000

# OpenAI / AI assistant
OPENAI_API_KEY=

# Cloudinary (required only if you test upload flows)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_URL=

# SendGrid (required only if you test email flows)
SENDGRID_API_KEY=
EMAIL_FROM=
EMAIL_FROM_NAME=
EMAIL_REPLY_TO=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_STATE_SECRET=

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=
GITHUB_STATE_SECRET=

# LinkedIn OAuth
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=
LINKEDIN_STATE_SECRET=

# Reserved / future integrations
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm install
```

### 2. Create local environment file

```bash
cp .env.example .env
```

Then update `.env` using the example above.

### 3. Create PostgreSQL databases

You need:

- main database for development
- shadow database for Prisma dev migrations
- Redis instance for the order timeout worker

Example:

```bash
createdb cartlify_dev
createdb cartlify_shadow
```

### 4. Initialize DB roles and schema

Run the SQL bootstrap script before Prisma migrations so the `cartlify` schema and roles exist:

```bash
psql -v ON_ERROR_STOP=1 -f "db/01_roles_and_schemas.sql" "$DATABASE_URL"
```

### 5. Generate Prisma client

```bash
npm run prisma:generate
```

### 6. Run Prisma migrations

```bash
npm run prisma:migrate
```

### 7. Apply PostgreSQL hardening layer

These scripts add extensions, RLS, functions, triggers, views, and additional indexes that go beyond basic Prisma migrations:

```bash
psql -v ON_ERROR_STOP=1 -f "db/02_extensions.sql" "$DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/03_policies_and_rls.sql" "$DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/04_views.sql" "$DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/05_fn_and_triggers.sql" "$DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/06_indexes_and_constraints.sql" "$DATABASE_URL"
```

### 8. Start Redis

Example with a local Redis server:

```bash
redis-server
```

### 9. Start the app

```bash
npm run dev
```

If everything is configured correctly, check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/info
```

Swagger UI is available at:

```bash
http://localhost:3000/documentation
```

Raw OpenAPI JSON is available at:

```bash
http://localhost:3000/documentation/json
```

---

## Run Commands

```bash
# development
npm run dev

# build
npm run build

# start built app
npm start

# generate prisma client
npm run prisma:generate

# create/apply prisma migration in development
npm run prisma:migrate

# apply existing prisma migrations (deployment style)
npm run migrate:deploy

# lint
npm run lint

# format
npm run format

# type check
npm run typecheck

# tests (placeholder script exists, but test suite is not established in this snapshot)
npm test
```

---

## API Surface

Current REST modules exposed by the application:

- `GET /health`
- `GET /ready`
- `GET /info`
- `GET /documentation`
- `GET /documentation/json`
- `api/auth/*`
- `api/users/*`
- `api/products/*`
- `api/categories/*`
- `api/favorites/*`
- `api/orders/*`
- `api/reviews/*`
- `api/admin/*`
- `api/root/*`
- `api/chat/*`

Examples of implemented business endpoints:

- auth: register, login, refresh, logout, verify, password reset, OAuth callbacks
- users: get/update current user, get user by id, root delete user
- products: list, details, reviews, create/update/delete, upload images, bulk price update
- categories: list, create, update, delete
- favorites: get/add/remove
- orders: current cart, item mutations, confirm, history, details, admin status update
- reviews: vote on review
- admin: stats, product popularity, admin chat queues
- root: manage admins

---

## API Documentation

Cartlify exposes Swagger/OpenAPI documentation for the REST API.

Local Swagger UI:

```bash
http://localhost:3000/documentation
```

Local OpenAPI JSON:

```bash
http://localhost:3000/documentation/json
```

Deployed Swagger UI:

```bash
https://cartlify.up.railway.app/documentation
```

Deployed OpenAPI JSON:

```bash
https://cartlify.up.railway.app/documentation/json
```

The current documentation includes:

- OpenAPI 3.0.3 specification
- grouped REST modules through Swagger tags
- reusable schemas for system and DTO responses
- cookie-based auth schemes for access token, refresh token, and guest id
- health, readiness, and project information endpoints
- separate readiness responses for healthy and unavailable states

The documentation is being improved further with:

- security metadata for all protected routes
- operation ids for all documented operations
- clearer summaries and descriptions for domain modules
- explicit response descriptions instead of generic default responses
- request and response examples
- local and deployed server entries in the OpenAPI spec

---

## Realtime Chat / AI Bot

Cartlify includes a WebSocket-based chat flow for guest, user, bot, and admin support scenarios.

Main chat flow:

1. A guest or authenticated user opens the current chat thread through the REST endpoint.
2. The client connects to the WebSocket endpoint.
3. The client joins a thread with a `thread:join` event.
4. Messages are sent with `message:send`.
5. New messages are broadcast as `message:new` events.
6. Read state is handled through `thread:read`.

Implemented chat behavior:

- guest bot chat
- authenticated user bot chat
- bot welcome message for new threads
- product-aware OpenAI chatbot responses
- automatic response language matching based on the latest customer message
- guest guard for admin support requests
- authenticated-user admin escalation
- admin queue model using `adminRequestedAt` and `adminUnreadSince`
- guest-to-user chat migration during authentication

The chat module is implemented, but admin workflow details are still being refined through manual testing.

---

## Production Notes

This repository is still in active development and should not be treated as a fully production-ready deployment package yet.

Current production-oriented pieces already present:

- PostgreSQL RLS and custom SQL hardening scripts
- separate runtime and migration database credentials
- Redis-backed order timeout worker
- JWT cookie auth with refresh-token flow
- OAuth support
- structured backend module boundaries
- Swagger/OpenAPI documentation deployed with the running API

Planned production improvements:

- automated unit and integration tests
- Swagger/OpenAPI refinement with full protected-route security metadata and request/response examples
- Dockerized local/dev/prod workflow
- AWS ECS/Fargate deployment target
- broader monitoring, metrics, and operational reporting
