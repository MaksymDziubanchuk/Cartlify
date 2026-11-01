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

# the structure of a database against the reference db/tools/structure_snapshot.txt (read only):
# check compares the test container, check:db the database of DATABASE_URL; save writes a new
# reference from the test container and is committed together with the change of a script or a
# migration
npm run db:snapshot:check
npm run db:snapshot:check:db
npm run db:snapshot:save

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

# the test database alone, built from the Prisma migrations and the SQL scripts exactly as a
# deployment does it (then compared with the reference of the structure); the integration tests
# connect only to it, a run stops before the app is imported if the addresses are others
npm run db:test:up
npm run db:test:down

# tests by part name or group (all, unit, integration, api)
npm test -- unit api:orders

# options of Jest go after a second --; one file or a few: the path is taken as it is
# (--runTestsByPath), without it a path is joined with the folder of the part and runs the whole part
npm test -- api:products --workers=2 -- --runTestsByPath tests/integration/api/products/variantCard.test.ts

# the whole suite on two workers, with the deprecation notices traced to the line that causes them
NODE_OPTIONS=--trace-deprecation npm test -- all --workers=2

# rerun only the tests that failed last time
npm test -- --failed

# integration files run at the same time, one more than the cores docker has, at most one per
# core and at most 6 (they share the database); when docker keeps cores of its own (Docker Desktop),
# at most the cores of the machine but docker's and two more; one by one:
npm test -- --workers=1
# a file that changes what the whole shop sees and cannot undo it (a version of the terms in
# force) is named *.shopwide.test.ts: it runs after the others and alone
# (tests/setup/sequencer.mjs, tests/setup/integration.shopState.ts)

# Jest gives every test file its own copy of the modules, and V8 keeps the copy of a finished file
# reachable from its caches of compiled code until a last resort collection: without one a worker
# grew by the size of the app (about 70 MB) a file and met the heap limit of Node after some forty
# files. tests/setup/integration.gc.ts makes that collection after every integration file (the
# runner starts node with --expose-gc), so a worker stays at the size of a file or two. A worker
# over 1500 MB (workerIdleMemoryLimit in jest.config.js) is still replaced after its file, the
# fallback for Jest started without --expose-gc; one worker is --maxWorkers=1 for this reason
# (a runner told --runInBand has no worker to replace)

# the driver of postgres takes one statement at a time on a connection and a transaction has one
# connection: statements of one transaction sent side by side (Promise.all over its queries, or a
# query of Prisma that asks for three relations or more) make the driver give a deprecation notice
# (pg 8; pg 9 refuses the statement). tests/setup/integration.driver.ts fails the test that got
# the notice, so a place of this kind is found by the test that runs it

# external services answer from mocks unless the run names them (the Services checkboxes,
# or service:<name>). Real SendGrid takes SENDGRID_API_TEST_KEY and EMAIL_FROM, EMAIL_FROM_NAME,
# EMAIL_REPLY_TO from .env (never SENDGRID_API_KEY); the tests send every mail in sandbox mode,
# SendGrid checks it and delivers nothing. GitHub Actions takes the secrets of the same names
npm test -- api:auth service:sendgrid

# real Cloudinary takes CLOUDINARY_* from .env: Cloudinary has no test mode, the upload tests
# upload into the test/ folder of the account and delete what they uploaded. GitHub Actions
# takes the CLOUDINARY_URL secret. The tests read the files they check through the admin api,
# which answers a few hundred calls an hour (500 on the free plan): the launcher asks what is
# left before the run, stops when a run of the same parts took more the last time, and names
# what the run took in the summary
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

# demo data through the routes of a running api: a tree of categories, 16 products with one, two or
# three variants each (26 in all, every variant with its pictures, price and article number), the
# stock of each variant by a delivery, sales, three buyers with carts, orders, reviews and
# favorites of variants; what is there stays, a run adds only what is missing. The shop lets a buyer in only with a confirmed
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
