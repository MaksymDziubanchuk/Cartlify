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
- a catalog of products with variants (a size, a colour, a memory): the price, the sale, the stock, the codes, the weight and the pictures belong to a variant, a directory of characteristics (groups, types, main characteristics, values of a list with a colour, sets a category requires) describes them, the server builds the names of variants, and a list groups variants by their main characteristics (see [products, variants and characteristics](variants.md))
- a filter of the catalog by characteristics (`f`) and the panel of the filter of a category
- the safety and origin data an offer needs in the EU (GPSR): manufacturers and persons responsible in the EU, warnings and PDF documents of products
- stock in batches with expiry dates, delivery, a stock log (a line for every change of the stock of a variant) and an accounting report
- Swagger/OpenAPI documentation for the REST API, held to the code by tests: every answer of the integration tests is checked against it, and the whole document is checked for descriptions, codes, examples and lists of values

What is important to state honestly:

- the project is **not feature-complete yet**
- there is no storefront/UI layer in this repository yet; the current stage is the backend API
- WebSocket chat and OpenAI chatbot logic are implemented, but the admin-chat workflow is still being actively refined
- unit and integration tests (Jest, a disposable PostgreSQL and Redis in Docker) run on every push to `develop` and `main`
- there is no Docker image or production deployment setup in this repository yet

## In Progress

- returns: the withdrawal from the contract within its term (with the withdrawal button EU law asks for from 19 June 2026), the cancel of an order by its buyer and the goods an admin takes back; being designed, no code yet
- admin chat queue behavior is implemented, but still being refined through manual testing

## Next

- delivery through carriers, a tax model, fiscal receipts and a second payment provider (LiqPay)
- a Docker deployment of the API, then a storefront on it
