-- CreateTable
CREATE TABLE "stock_log" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER,
    "actorRole" "Role",
    "productId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "event" VARCHAR(60) NOT NULL,
    "quantityChange" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "meta" JSONB,
    "deliveryId" UUID,
    "writeOffId" UUID,
    "orderId" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_log_variantId_createdAt_idx" ON "stock_log"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_log_productId_createdAt_idx" ON "stock_log"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_log_event_createdAt_idx" ON "stock_log"("event", "createdAt");

-- CreateIndex
CREATE INDEX "stock_log_createdAt_id_idx" ON "stock_log"("createdAt", "id");

-- CreateIndex
CREATE INDEX "stock_log_actorId_createdAt_idx" ON "stock_log"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "stock_log" ADD CONSTRAINT "stock_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_log" ADD CONSTRAINT "stock_log_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_log" ADD CONSTRAINT "stock_log_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_log" ADD CONSTRAINT "stock_log_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

