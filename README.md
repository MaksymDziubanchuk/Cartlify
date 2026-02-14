# Cartlify — Backend-First E‑Commerce API (Portfolio)

Cartlify is a backend-first e-commerce platform built as a production-style portfolio project.  
The focus is **API design**, **database design**, and **security** — with features implemented incrementally.

**Current snapshot**
- **51 REST endpoints** across auth, users, products, categories, orders, favorites, reviews, admin, root, and system
- **PostgreSQL + Prisma**: **15 models**, **29 migrations**
- Cookie-based auth with **JWT access tokens + refresh token rotation** and **RBAC** (`GUEST`, `USER`, `ADMIN`, `ROOT`)

---

## Tech stack

- **Runtime:** Node.js (ESM)
- **Backend:** Fastify, TypeScript
- **Database:** PostgreSQL, Prisma ORM
- **Auth/Security:** JWT, HttpOnly cookies, bcrypt, RBAC, rate limiting, helmet
- **Uploads:** Cloudinary (images/files)
- **Email:** SendGrid (verification / reset flows)
- **Logging:** Pino

> GraphQL, WebSockets/real-time chat, CI/CD, and full test coverage are planned/in progress.

---

## Features (implemented)

### Authentication & Users
- Local auth (email/password)
- OAuth flows present in codebase (Google, GitHub, LinkedIn)
- JWT access tokens + refresh token rotation (HttpOnly cookies)
- Role-based access control and route guards
- Login logs and token storage (DB)

### Catalog
- Categories and products API
- Product images (Cloudinary)
- Reviews and rating aggregation (API layer)

### Orders
- Orders API with status handling and order items

### Admin / Root
- Admin endpoints for moderation/management
- Root endpoints for privileged operations (where applicable)

### System
- Health/readiness/info endpoints

---

## Database & security notes

This repository includes:
- Prisma migrations (`prisma/migrations/`)
- SQL scripts for roles/schemas/RLS and related DB logic (`db/`)

If you want to use a dedicated schema (e.g., `cartlify`), set it via the Postgres connection string (for example by adding a `schema=...` parameter) and run the scripts in `db/` accordingly.

---

## Getting started (local)

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### 1) Install
```bash
npm install
```

### 2) Configure environment
Create `.env` in the project root (minimal example):

```bash
NODE_ENV=development
PORT=3000
WEB_ORIGIN=http://localhost:3000

DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/cartlify"

COOKIE_SECRET=changeme

JWT_ACCESS_SECRET=changeme
JWT_REFRESH_SECRET=changeme

# Optional (only needed if you use the related flows)
CLOUDINARY_URL=
SENDGRID_API_KEY=
EMAIL_FROM=
EMAIL_FROM_NAME=
EMAIL_REPLY_TO=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_STATE_SECRET=

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=
GITHUB_STATE_SECRET=

LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=
LINKEDIN_STATE_SECRET=
```

### 3) Generate Prisma client & migrate
```bash
npm run prisma:generate
npm run prisma:migrate
```

### 4) Run in dev
```bash
npm run dev
```

### 5) Quick checks
- `GET /health`
- `GET /ready`
- `GET /info`

---

## Useful scripts

```bash
npm run dev            # dev server (watch)
npm run build          # compile TypeScript
npm start              # run compiled build
npm run prisma:migrate # prisma migrate dev
npm run migrate:deploy # prisma migrate deploy
npm test               # jest (in progress)
npm run lint
npm run format
npm run typecheck
```

---

## Project structure (high level)

```
src/
  app.ts
  routes/api/          # REST routes by module
  middlewares/         # auth, errors, logging, guards
  services/            # business logic
  schemas/             # shared JSON schemas + DTO schemas
  db/                  # prisma client
prisma/
  schema.prisma
  migrations/
db/
  01_roles_and_schemas.sql
  03_policies_and_rls.sql
  ...
```

---

## Roadmap (short)

- WebSockets / real-time chat module
- Admin analytics (views/materialized views)
- GraphQL endpoint (optional)
- More tests (Jest/Supertest)
- CI/CD

---

## License

MIT (planned)
