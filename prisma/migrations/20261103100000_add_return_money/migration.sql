-- CreateEnum
CREATE TYPE "ReturnRefundFailure" AS ENUM ('card_unavailable', 'shop_balance', 'disputed', 'unknown');

-- CreateEnum
CREATE TYPE "ReturnCloseCode" AS ENUM ('buyer_changed_mind', 'not_buyer', 'goods_not_returned', 'other');

-- CreateEnum
CREATE TYPE "ReturnOutsideMethod" AS ENUM ('bank_transfer', 'cash', 'other');

-- AlterTable
ALTER TABLE "return_items" ADD COLUMN     "amountNote" VARCHAR(500),
ADD COLUMN     "deliveryShare" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "outsideById" INTEGER,
ADD COLUMN     "outsideMethod" "ReturnOutsideMethod",
ADD COLUMN     "outsideNote" VARCHAR(500),
ADD COLUMN     "refundFailure" "ReturnRefundFailure",
ADD COLUMN     "refundFailureText" VARCHAR(500),
ADD COLUMN     "refundId" TEXT,
ADD COLUMN     "refundKey" UUID,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "refusedCode" "ReturnCloseCode";

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "closeCode" "ReturnCloseCode",
ADD COLUMN     "closeNote" VARCHAR(500);

-- CreateIndex
CREATE INDEX "return_items_refundKey_idx" ON "return_items"("refundKey");

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_outsideById_fkey" FOREIGN KEY ("outsideById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

