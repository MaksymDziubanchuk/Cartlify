-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'waiting';

-- DropIndex
DROP INDEX "products_createdAt_idx";

-- DropIndex
DROP INDEX "products_name_idx";

-- DropIndex
DROP INDEX "products_popularity_idx";

-- DropIndex
DROP INDEX "products_price_idx";

-- DropIndex
DROP INDEX "products_views_idx";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "reservationExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "reservedStock" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "orders_confirmed_reservationExpiresAt_idx" ON "orders"("confirmed", "reservationExpiresAt");

-- CreateIndex
CREATE INDEX "products_price_id_idx" ON "products"("price", "id");

-- CreateIndex
CREATE INDEX "products_createdAt_id_idx" ON "products"("createdAt", "id");

-- CreateIndex
CREATE INDEX "products_name_id_idx" ON "products"("name", "id");

-- CreateIndex
CREATE INDEX "products_popularity_id_idx" ON "products"("popularity", "id");

-- CreateIndex
CREATE INDEX "products_views_id_idx" ON "products"("views", "id");

-- CreateIndex
CREATE INDEX "products_stock_id_idx" ON "products"("stock", "id");

-- CreateIndex
CREATE INDEX "products_updatedAt_id_idx" ON "products"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "products_avgRating_id_idx" ON "products"("avgRating", "id");

-- CreateIndex
CREATE INDEX "products_reviewsCount_id_idx" ON "products"("reviewsCount", "id");
