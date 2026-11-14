-- The money of the statements moves into the money journal (money_log): the part of the delivery,
-- the deduction of the way back, the transfer, its failure and the money sent outside the app leave
-- the rows, the money of the way back paid back leaves the statement, the cost of a parcel back
-- leaves the parcel; the old types of a failure and of a way outside the app go with them (the
-- journal has RefundFailure and OutsideMethod). What of the sql scripts holds the old columns or
-- types is dropped first: the view of the statistics reads the columns, four functions take or
-- return the old types or are no longer there (the scripts make the view and the two functions that
-- stay again, in the order of a deploy right after the migrations: db/schema/05, then 04, then 01
-- for their rights). The rows of old statements kept their money in the columns that go: a row
-- whose money was on its way or back starts again as not refunded (the data of dev are not kept,
-- prod is not live).
DROP VIEW IF EXISTS "admin_stats_view";
DROP FUNCTION IF EXISTS "finish_return_refund"(uuid, text, text, "ReturnRefundFailure", text);
DROP FUNCTION IF EXISTS "mark_return_refunded_outside"(integer, integer[], "ReturnOutsideMethod", text, timestamp without time zone);
DROP FUNCTION IF EXISTS "record_return_reimbursement"(integer, numeric, "ReturnOutsideMethod", text, timestamp without time zone);
DROP FUNCTION IF EXISTS "settle_return_dispute"(integer, boolean, text, timestamp without time zone);

-- DropForeignKey
ALTER TABLE "returns" DROP CONSTRAINT "returns_shippingReimbursedById_fkey";

-- DropForeignKey
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_outsideById_fkey";

-- DropIndex
DROP INDEX "return_items_refundKey_idx";

-- AlterTable
ALTER TABLE "returns" DROP COLUMN "shippingReimbursed",
DROP COLUMN "shippingReimbursedAt",
DROP COLUMN "shippingReimbursedById",
DROP COLUMN "shippingReimbursedMethod",
DROP COLUMN "shippingReimbursedNote";

-- AlterTable
ALTER TABLE "return_items" DROP COLUMN "deliveryShare",
DROP COLUMN "outsideById",
DROP COLUMN "outsideMethod",
DROP COLUMN "outsideNote",
DROP COLUMN "refundFailure",
DROP COLUMN "refundFailureText",
DROP COLUMN "refundId",
DROP COLUMN "refundKey",
DROP COLUMN "refundedAt",
DROP COLUMN "shippingDeduction";

-- AlterTable
ALTER TABLE "return_shipments" DROP COLUMN "cost";

-- DropEnum
DROP TYPE "ReturnRefundFailure";

-- DropEnum
DROP TYPE "ReturnOutsideMethod";

-- the rows of old statements: no line of the journal stands for their money
UPDATE "return_items" SET "money" = 'not_refunded' WHERE "money" IN ('pending', 'refunded') AND "moneyLogId" IS NULL;
