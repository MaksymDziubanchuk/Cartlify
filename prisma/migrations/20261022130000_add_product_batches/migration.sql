-- CreateEnum
CREATE TYPE "StockSource" AS ENUM ('supplier', 'surplus', 'customer_return');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'STOCK_DELIVERY';
ALTER TYPE "AdminAuditAction" ADD VALUE 'STOCK_WRITE_OFF';

-- CreateTable
CREATE TABLE "product_batches" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "deliveryId" UUID NOT NULL,
    "source" "StockSource" NOT NULL,
    "supplierBatchNumber" TEXT,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_batch_allocations" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "batchId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_batch_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_productId_expiresAt_createdAt_id_idx" ON "product_batches"("productId", "expiresAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "product_batches_createdAt_id_idx" ON "product_batches"("createdAt", "id");

-- CreateIndex
CREATE INDEX "product_batches_deliveryId_idx" ON "product_batches"("deliveryId");

-- CreateIndex
CREATE INDEX "order_batch_allocations_batchId_idx" ON "order_batch_allocations"("batchId");

-- CreateIndex
CREATE INDEX "order_batch_allocations_productId_idx" ON "order_batch_allocations"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "order_batch_allocations_orderId_batchId_key" ON "order_batch_allocations"("orderId", "batchId");

-- CreateIndex
CREATE INDEX "orders_cancelledAt_idx" ON "orders"("cancelledAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_createdAt_idx" ON "admin_audit_log"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_allocations" ADD CONSTRAINT "order_batch_allocations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_allocations" ADD CONSTRAINT "order_batch_allocations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_allocations" ADD CONSTRAINT "order_batch_allocations_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
