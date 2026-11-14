-- CreateEnum
CREATE TYPE "MoneyPurpose" AS ENUM ('order', 'return', 'late_payment', 'hand', 'dispute', 'shipping', 'compensation');

-- CreateEnum
CREATE TYPE "MoneyPart" AS ENUM ('goods', 'delivery', 'deduction', 'covered', 'whole', 'way_back');

-- CreateEnum
CREATE TYPE "MoneyState" AS ENUM ('in_transit', 'sent');

-- CreateEnum
CREATE TYPE "MoneyUse" AS ENUM ('goods', 'compensation', 'loss');

-- CreateEnum
CREATE TYPE "RefundFailure" AS ENUM ('card_unavailable', 'shop_balance', 'disputed', 'already_refunded', 'unknown');

-- CreateEnum
CREATE TYPE "OutsideMethod" AS ENUM ('bank_transfer', 'cash', 'other');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost', 'prevented');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fraudWarnedAt" TIMESTAMP(3),
ADD COLUMN     "holds" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "refundedTotal" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "return_items" ADD COLUMN     "moneyLogId" INTEGER;

-- CreateTable
CREATE TABLE "money_log" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER,
    "actorRole" "Role",
    "event" VARCHAR(60) NOT NULL,
    "purpose" "MoneyPurpose" NOT NULL,
    "part" "MoneyPart" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3),
    "orderId" INTEGER,
    "userId" INTEGER,
    "returnId" INTEGER,
    "orderShipmentId" INTEGER,
    "disputeId" INTEGER,
    "coversId" INTEGER,
    "provider" "PaymentProvider",
    "paymentId" TEXT,
    "refundId" TEXT,
    "transferKey" VARCHAR(100),
    "stripeTxId" TEXT,
    "bankReference" VARCHAR(100),
    "byDashboard" BOOLEAN NOT NULL DEFAULT false,
    "state" "MoneyState",
    "stateAt" TIMESTAMP(3),
    "failure" "RefundFailure",
    "failureText" VARCHAR(500),
    "method" "OutsideMethod",
    "note" VARCHAR(500),
    "happenedAt" TIMESTAMP(3),
    "moneyUse" "MoneyUse",
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "money_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_disputes" (
    "id" SERIAL NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "stripeId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" INTEGER,
    "userId" INTEGER,
    "reason" VARCHAR(60),
    "status" "DisputeStatus" NOT NULL,
    "evidenceDueBy" TIMESTAMP(3),
    "hasEvidence" BOOLEAN NOT NULL DEFAULT false,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "isChargeRefundable" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "draftedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "money_log_stripeTxId_key" ON "money_log"("stripeTxId");

-- CreateIndex
CREATE INDEX "money_log_orderId_createdAt_idx" ON "money_log"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "money_log_returnId_idx" ON "money_log"("returnId");

-- CreateIndex
CREATE INDEX "money_log_disputeId_idx" ON "money_log"("disputeId");

-- CreateIndex
CREATE INDEX "money_log_paymentId_idx" ON "money_log"("paymentId");

-- CreateIndex
CREATE INDEX "money_log_event_createdAt_idx" ON "money_log"("event", "createdAt");

-- CreateIndex
CREATE INDEX "money_log_createdAt_id_idx" ON "money_log"("createdAt", "id");

-- CreateIndex
CREATE INDEX "money_log_userId_createdAt_idx" ON "money_log"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_disputes_stripeId_key" ON "payment_disputes"("stripeId");

-- CreateIndex
CREATE INDEX "payment_disputes_paymentId_idx" ON "payment_disputes"("paymentId");

-- CreateIndex
CREATE INDEX "payment_disputes_orderId_idx" ON "payment_disputes"("orderId");

-- CreateIndex
CREATE INDEX "payment_disputes_status_evidenceDueBy_idx" ON "payment_disputes"("status", "evidenceDueBy");

-- CreateIndex
CREATE INDEX "return_items_moneyLogId_idx" ON "return_items"("moneyLogId");

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_moneyLogId_fkey" FOREIGN KEY ("moneyLogId") REFERENCES "money_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_orderShipmentId_fkey" FOREIGN KEY ("orderShipmentId") REFERENCES "order_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "payment_disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_log" ADD CONSTRAINT "money_log_coversId_fkey" FOREIGN KEY ("coversId") REFERENCES "money_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

