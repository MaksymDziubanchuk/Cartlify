# Status

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
- there is no storefront/UI layer in this repository yet; the current stage is the backend API
- WebSocket chat and OpenAI chatbot logic are implemented, but the admin-chat workflow is still being actively refined
- Swagger/OpenAPI is implemented and available, but route security metadata, operation ids, examples, and response descriptions are still being refined
- unit and integration tests (Jest, a disposable PostgreSQL and Redis in Docker) run on every push to `develop` and `main`
- Dockerized deployment and broader observability are **planned**, not done in this snapshot

## In Progress / Planned

### In progress / partial

- admin chat queue behavior is implemented, but still being refined through manual testing
- demo data goes through the routes of the shop (`db/tools/demo_data.mjs`); seeds as csv files with a check before they load come next
- Swagger/OpenAPI documentation is implemented, but route metadata is still being refined

### Planned

- Swagger/OpenAPI refinement for protected routes, operation ids, examples, and response descriptions
- detachable SSR/web layer for showcase pages without coupling business logic to the UI
- Dockerized local/dev/prod workflow and a production deployment target on AWS ECS/Fargate
- broader admin analytics, observability, and reporting
