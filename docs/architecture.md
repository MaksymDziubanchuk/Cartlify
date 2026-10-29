# Architecture

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
| Testing                       | Jest unit and integration tests, PostgreSQL and Redis in Docker             | Implemented |
| CI utilities                  | GitHub Actions for tests, DB migration and SQL execution                    | Implemented |

### Planned stack / next steps

| Area                     | Planned technologies                       | Status  |
| ------------------------ | ------------------------------------------ | ------- |
| API docs refinement      | security metadata, operation ids, examples | Planned |
| Deployment               | Docker, AWS ECS/Fargate                    | Planned |
| SSR delivery layer       | detachable Handlebars-based web module     | Planned |
| Production observability | broader monitoring / metrics / reporting   | Planned |

## Project Structure

```text
Cartlify/
├── db/
│   ├── schema/                 # raw SQL run in order: roles, extensions, RLS, views, functions, indexes
│   ├── data/                   # the scripts that clear data stay local, not in git
│   └── tools/                  # test database build, structure snapshot, anonymized copy of prod for dev, demo data
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
│   │   ├── delivery/
│   │   ├── reviews/
│   │   ├── admin/
│   │   ├── root/
│   │   ├── chat/
│   │   └── legal/
│   ├── schemas/                # shared AJV schemas and DTO schemas
│   ├── services/               # cross-module services
│   │   └── email/templates/    # mails as .html and .txt files with {{marks}}: auth/, orders/, users/
│   ├── types/                  # DTOs and shared TypeScript types
│   ├── utils/                  # JWT, OAuth, Cloudinary, app errors
│   └── workers/                # background workers
├── tests/
│   ├── unit/                   # no database or network, mirrors src/ paths
│   ├── integration/            # api/<module>, db, flows, worker against the Docker test stack
│   ├── helpers/                # app startup for app.inject, test environment guard
│   ├── fixtures/               # static files used by tests
│   ├── setup/                  # per-project jest setup, keeps the local .env out of tests
│   ├── coverage/               # generated coverage report (gitignored)
│   └── run.mjs                 # test launcher behind npm test
├── docker-compose.test.yml     # disposable PostgreSQL and Redis for integration tests
├── .github/workflows/          # tests, DB migration and SQL execution workflows
└── package.json
```

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
- unit and integration tests on every push in GitHub Actions

Planned production improvements:

- Swagger/OpenAPI refinement with full protected-route security metadata and request/response examples
- Dockerized local/dev/prod workflow
- AWS ECS/Fargate deployment target
- broader monitoring, metrics, and operational reporting
