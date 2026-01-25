-- CreateEnum
CREATE TYPE "PriceChangeMode" AS ENUM ('percent', 'fixed');

-- CreateTable
CREATE TABLE "product_price_change_logs" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "actorId" INTEGER NOT NULL,
    "oldPrice" DECIMAL(10,2) NOT NULL,
    "newPrice" DECIMAL(10,2) NOT NULL,
    "mode" "PriceChangeMode" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_price_change_logs_productId_createdAt_idx" ON "product_price_change_logs"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "product_price_change_logs_actorId_createdAt_idx" ON "product_price_change_logs"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "product_price_change_logs" ADD CONSTRAINT "product_price_change_logs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_change_logs" ADD CONSTRAINT "product_price_change_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
