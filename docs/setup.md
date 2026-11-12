# Local setup

## Requirements

- Node.js 24 (`engines` of `package.json`) with the npm it comes with
- PostgreSQL 17 and Redis 8 (the test containers run 17.11 and 8.2)
- `psql` on the `PATH`, for the scripts of the database and `npm run db:apply`
- Docker, for the integration tests: `npm test` builds their database and Redis in containers ([commands](commands.md))

## 1. Clone and install

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm install
```

## 2. Create local environment file

```bash
cp .env.example .env
```

Then update `.env` using the example in [configuration](configuration.md).

The start stops without the variables of the newsletters and the captcha (`SENDGRID_NEWSLETTER_API_KEY`, `SENDGRID_NEWSLETTER_WEBHOOK_KEY`, `NEWSLETTER_EMAIL_FROM`, `NEWSLETTER_BLOCK_SECRET`, `NEWSLETTER_LINK_SECRET`, `NEWSLETTER_DAILY_LIMIT`, `TURNSTILE_SECRET_KEY`), also on your machine. The rules of each are in [configuration](configuration.md): the two secrets are random and differ, the key of the webhook is a P-256 public key (base64 of its DER form; the Verification Key of an Event Webhook of SendGrid is one), and for the captcha locally you can use the public test secret of Cloudflare written there. `API_ORIGIN` (the address the API is reached on from outside, an https address without a path in production) is required in development and production too, the start stops without it; the header `List-Unsubscribe` of a newsletter names it. How the newsletters work and what to set up outside the code: [newsletters](newsletters.md).

## 3. Create PostgreSQL databases

You need:

- main database for development
- shadow database for Prisma dev migrations
- Redis instance for the order timeout worker (and for the lock of the pass of the newsletters)

Example:

```bash
createdb cartlify_dev
createdb cartlify_shadow
```

## 4. Initialize DB roles and schema

The database is built in the same order as the test database (`db/tools/test_db_build.mjs`);
the order differs from the file numbers. Run the bootstrap script as a superuser before the
Prisma migrations, so the `cartlify` schema and the roles exist, then give the roles their
passwords (as the superuser too):

```bash
psql -v ON_ERROR_STOP=1 -f "db/schema/01_roles_and_schemas.sql" "$SUPERUSER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -c "ALTER ROLE cartlify_owner PASSWORD '<owner password>'; ALTER ROLE cartlify_app PASSWORD '<app password>'; ALTER ROLE cartlify_readonly PASSWORD '<readonly password>';" "$SUPERUSER_DATABASE_URL"
```

## 5. Generate Prisma client

```bash
npm run prisma:generate
```

## 6. Run Prisma migrations

The tables are created by the owner role, the way migrations run on the hosted databases:

```bash
DATABASE_URL="$OWNER_DATABASE_URL" npm run migrate:deploy
```

## 7. Apply PostgreSQL hardening layer

These scripts add extensions, RLS, functions, triggers, views, and additional indexes that go beyond basic Prisma migrations. Run them in this order: `02` needs the tables, the policies of `03` call functions from `05`, and the second run of `01` grants rights on everything created after its first run:

```bash
psql -v ON_ERROR_STOP=1 -f "db/schema/02_extensions.sql" "$SUPERUSER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/05_fn_and_triggers.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/03_policies_and_rls.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/04_views.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/06_indexes_and_constraints.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/01_roles_and_schemas.sql" "$SUPERUSER_DATABASE_URL"
```

Compare the result with the reference of the structure (read only): `DATABASE_URL="$APP_DATABASE_URL" npm run db:snapshot:check:db`.

## 8. Start Redis

Example with a local Redis server:

```bash
redis-server
```

## 9. Start the app

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

## 10. Fill the catalog

An empty shop has no products. Either load the demo data through the routes of the running API (see [commands](commands.md): a tree of categories, 16 products with one to three variants each, the stock, three buyers with orders), or fill the catalog by hand as an admin. The order that works, with the rules of each step in [Products, variants and characteristics](variants.md):

1. the directory of characteristics: groups, characteristics (mark the ones that tell variants apart as main) and the values of the lists (`/api/admin/attribute-groups`, `/api/admin/attributes`, `.../options`);
2. the categories, and for each the characteristics it asks for (`PUT /api/categories/:categoryId/attributes`);
3. the manufacturers and the persons responsible in the EU, and the documents of the products (`/api/admin/parties`, `/api/admin/documents`);
4. the products with their variants and pictures (`POST /api/products`), then the stock of the variants by a delivery (`POST /api/products/stock/deliveries`). A variant is shown to buyers when it shows a picture; its free units are what a delivery took in.
