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
- withdrawal and returns ([Returns](returns.md)): the withdrawal from the contract within its term (the function EU law asks for from 19 June 2026), by the account or by a public form with a code from the mails, the cancel of an order, the goods an admin takes back, the money back through the provider, the reports and alerts for the admins, the personal data of a statement emptied after the terms of the privacy policy, and the export of the data of a person
- the safety and origin data an offer needs in the EU (GPSR): manufacturers and persons responsible in the EU, warnings and PDF documents of products
- stock in batches with expiry dates, delivery, a stock log (a line for every change of the stock of a variant) and an accounting report
- the data of the shop (delivery, the brand, the seller, the languages) that root changes without a deploy ([Shop settings](shop-settings.md)), and every mail in the language of its reader through dictionaries ([Languages](languages.md))
- marketing newsletters ([Newsletters](newsletters.md)): a subscription of a guest (a double opt-in, a captcha, the same answer for every address, a blocklist) or of an account, one unsubscribe by the page or by the button of a mail program, campaigns of blocks of text and products in several languages that the admins root allowed write, preview, test and schedule under a limit of the shop, a sending pass with a daily limit and retries, a mail stream of its own with an Event Webhook for the bounces and the complaints, alerts and journals for the people who run them, and the terms the privacy policy gives to what is kept
- Swagger/OpenAPI documentation for the REST API, held to the code by tests: every answer of the integration tests is checked against it, and the whole document is checked for descriptions, codes, examples and lists of values

What is important to state honestly:

- the project is **not feature-complete yet**
- there is no storefront/UI layer in this repository yet; the current stage is the backend API
- WebSocket chat and OpenAI chatbot logic are implemented, but the admin-chat workflow is still being actively refined
- unit and integration tests (Jest, a disposable PostgreSQL and Redis in Docker) run on every push to `develop` and `main`
- there is no Docker image or production deployment setup in this repository yet

## In Progress

- admin chat queue behavior is implemented, but still being refined through manual testing

## Next

- a service of periodic tasks that runs the pass of the newsletters (`npm run newsletter:run`, by hand until then) and the cleanups of the data kept too long, which nothing calls yet
- the tightening of DMARC for the mail domain, after some weeks of clean reports
- delivery through carriers, a tax model, fiscal receipts and a second payment provider (LiqPay)
- a Docker deployment of the API, then a storefront on it
