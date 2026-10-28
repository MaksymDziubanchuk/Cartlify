# Commands

## Run Commands

```bash
# development
npm run dev

# build: tsc, then tsc-alias puts relative paths in place of the @… aliases in dist
npm run build

# start the built app with node (dist/index.js); the mail templates, the logo and /static
# are read from src/ in the working directory, so src/ stays next to dist/
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

# tests: pick test parts in a checkbox list (all parts without an interactive terminal);
# integration parts rebuild the Docker test database first and remove it after the run,
# Docker must be running;
# every answer of the app in the integration tests is held against the Swagger document: a status,
# an error code or a field it does not describe fails the test (tests/helpers/contract.ts)
npm test

# keep the test database running after the tests to look inside
npm test -- api:orders --keep-db

# tests by part name or group (all, unit, integration, api)
npm test -- unit api:orders

# rerun only the tests that failed last time
npm test -- --failed

# integration files run at the same time, one more than the cores docker has, at most one per
# core and at most 6 (they share the database); when docker keeps cores of its own (Docker Desktop),
# at most the cores of the machine but docker's and two more; one by one:
npm test -- --workers=1
# a file that changes what the whole shop sees and cannot undo it (a version of the terms in
# force) is named *.shopwide.test.ts: it runs after the others and alone
# (tests/setup/sequencer.mjs, tests/setup/integration.shopState.ts)

# external services answer from mocks unless the run names them (the Services checkboxes,
# or service:<name>). Real SendGrid takes SENDGRID_API_TEST_KEY and EMAIL_FROM, EMAIL_FROM_NAME,
# EMAIL_REPLY_TO from .env (never SENDGRID_API_KEY); the tests send every mail in sandbox mode,
# SendGrid checks it and delivers nothing. GitHub Actions takes the secrets of the same names
npm test -- api:auth service:sendgrid

# real Cloudinary takes CLOUDINARY_* from .env: Cloudinary has no test mode, the upload tests
# upload into the test/ folder of the account and delete what they uploaded. GitHub Actions
# takes the CLOUDINARY_URL secret
npm test -- api:users api:products service:cloudinary

# Stripe answers from a mock of the test sandbox unless the run takes it for real: then the
# payment tests use Stripe in test mode with STRIPE_TEST_SECRET_KEY from .env (never
# STRIPE_SECRET_KEY). Either way they open payment pages, pay them with a test card and deliver
# the events to the webhook themselves, so the sandbox needs no webhook endpoint. Keep `stripe
# listen` off during a real run, it would forward their events to a dev server. The answers the
# mock gives are checked against the sandbox by tests/integration/api/payments/stripeAnswers.test.ts
# in both modes. GitHub Actions takes the STRIPE_TEST_SECRET_KEY secret
npm test -- api:payments api:orders service:stripe

# the bot tests answer as the model themselves; the tests of the model itself
# (api/chat/model.test.ts, and the check of a review comment in api/products/reviewCheck.test.ts)
# ask OpenAI for real with OPENAI_API_TEST_KEY from .env (never OPENAI_API_KEY), a few cents a
# run, and check the form of the answer, not its words. GitHub Actions takes the
# OPENAI_API_TEST_KEY secret
npm test -- api:chat api:products service:openai

# unit or integration tests only
npm run test:unit
npm run test:integration

# demo data through the routes of a running api: a tree of categories, 16 products with images,
# their stock by a delivery, sales, three buyers with carts, orders, reviews and favorites; what
# is there stays, a run adds only what is missing. The shop lets a buyer in only with a confirmed
# email: the first run registers the buyers, confirm the mails, the next run gives them their
# orders. DEMO_EMAIL_DOMAIN is the domain of their addresses (example.com reaches nobody)
DEMO_API_URL='<api url>' DEMO_ADMIN_EMAIL='<admin email>' DEMO_ADMIN_PASSWORD='<password>' \
  DEMO_USERS_PASSWORD='<password of the buyers>' node db/tools/demo_data.mjs

# a copy of prod for dev with made-up people, not a backup: prod is read into a throwaway
# postgres container, its buyers, orders, chats and logs are anonymized there, the dump goes to
# db/restore/ (git ignores it) and into dev with the owners and rights of the scripts. Both urls
# of a superuser, given on the command only; Docker must be running. --dump-only makes the dump
# only, --from <dump> restores dev from one; DEV_USERS_PASSWORD gives the buyers of the copy a
# password
PROD_URL='<prod superuser url>' DEV_URL='<dev superuser url>' node db/tools/dev_restore_from_prod.mjs
```
