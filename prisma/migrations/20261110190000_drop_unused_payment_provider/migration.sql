-- The type of the payment providers keeps only the providers the app has a module for. Postgres
-- takes no value out of an enum, so the type is made again and the column moves to it. Two things
-- of the sql scripts hold the old type and are dropped here: the policy orders_insert (it reads the
-- column) and the function pay_order (a parameter of the type). The scripts make both again, in the
-- order of a deploy right after the migrations (db/schema/05, then 03, then 01 for its right).
-- Fails if an order still names a provider the type no longer has.
DROP POLICY IF EXISTS "orders_insert" ON "orders";
DROP FUNCTION IF EXISTS "pay_order"(integer, "PaymentProvider", text, numeric);

CREATE TYPE "PaymentProvider_new" AS ENUM ('stripe');

ALTER TABLE "orders"
  ALTER COLUMN "paymentProvider" TYPE "PaymentProvider_new"
  USING ("paymentProvider"::text::"PaymentProvider_new");

DROP TYPE "PaymentProvider";

ALTER TYPE "PaymentProvider_new" RENAME TO "PaymentProvider";
