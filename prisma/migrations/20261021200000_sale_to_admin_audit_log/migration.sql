-- a sale is no mode of a change of a price any more: the log of prices names how a change was given
-- (percent or fixed), a line with endsAt is the start of a sale; the sale itself goes to the admin
-- log (PRODUCT_SALE). What names the old type goes first and db/05, db/06 make it again: the
-- function of the log of prices (every version it had) and the check that gave an end only to a
-- line of mode sale. A line of mode sale left in the log stops the cast below, nothing is changed
BEGIN;
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (integer, numeric, numeric, cartlify."PriceChangeMode", numeric, timestamp without time zone);
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (integer, numeric, numeric, cartlify."PriceChangeMode", numeric);
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (integer, integer, numeric, numeric, cartlify."PriceChangeMode", numeric);
ALTER TABLE "product_price_change_logs" DROP CONSTRAINT IF EXISTS "price_change_ends_at_sale_only";

-- AlterEnum
CREATE TYPE "PriceChangeMode_new" AS ENUM ('percent', 'fixed');
ALTER TABLE "product_price_change_logs" ALTER COLUMN "mode" TYPE "PriceChangeMode_new" USING ("mode"::text::"PriceChangeMode_new");
ALTER TYPE "PriceChangeMode" RENAME TO "PriceChangeMode_old";
ALTER TYPE "PriceChangeMode_new" RENAME TO "PriceChangeMode";
DROP TYPE "PriceChangeMode_old";
COMMIT;

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE 'PRODUCT_SALE';
