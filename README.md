# Cartlify

Backend-first e-commerce platform built as a production-oriented portfolio project.

Cartlify is not presented as a finished storefront. It is a realistic engineering project focused on how a commercial e-commerce backend is structured: authentication, RBAC, catalog management, order flow, PostgreSQL policies, background jobs, real-time support chat, AI-assisted customer support, maintainable module boundaries, and documented REST API behavior.

The repository currently contains a working REST API foundation, PostgreSQL hardening scripts, Redis-based order timeout processing, OAuth/media/email integrations, WebSocket-based chat, Swagger/OpenAPI documentation, and an OpenAI-powered assistant for product and support conversations. Some parts of the roadmap are already implemented, some are partially scaffolded, and some are planned for the next stages.

---

## Quick Start

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm install
cp .env.example .env
```

Fill `.env` ([configuration](docs/configuration.md)), create the database with its roles, migrations and SQL layer ([local setup](docs/setup.md)), start Redis, then:

```bash
npm run dev
curl http://localhost:3000/health
```

Swagger UI: `http://localhost:3000/documentation`.

---

## Main Commands

```bash
npm run dev         # development
npm run build       # build to dist/
npm start           # start the build
npm run typecheck
npm run lint
npm test            # pick test parts; integration parts need Docker
```

Every command and test option: [commands](docs/commands.md).

---

## Documentation

- [Features](docs/features.md)
- [API](docs/api.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Local setup](docs/setup.md)
- [Commands](docs/commands.md)
- [Status](docs/status.md)

---

## License

Copyright (c) 2025-2026 Maksym Dziubanchuk. All rights reserved.

The source code is public only to be viewed as part of the author's portfolio. It is not open source: using, copying, modifying, distributing or deploying it, in whole or in part, needs prior written permission from the author. See [LICENSE](LICENSE).
