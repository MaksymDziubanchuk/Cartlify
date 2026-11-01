/*
  Variants: the price, the sale, the stock, the article number, the weight and the size move from
  products to product_variants; favorites, batches, batch allocations, order items and the lines of
  the price log name a variant (together with its product).

  The tables that get a variant column must hold no row (the shop data of dev is cleared before this
  migration); a table with rows stops it at the NOT NULL column.
*/

-- The objects of the database scripts that stand on the columns dropped below. A fresh database has
-- none of them yet; db/03, db/04 and db/05 make them again.
DROP VIEW IF EXISTS admin_stats_view;

DROP POLICY IF EXISTS products_insert ON products;

DROP TRIGGER IF EXISTS trg_products_stock_batches ON products;

DROP TRIGGER IF EXISTS trg_products_before_price_change ON products;

DROP TRIGGER IF EXISTS trg_product_batches_stock ON product_batches;

-- AlterEnum
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'variant';

-- DropIndex
DROP INDEX "favorites_guestId_productId_key";

-- DropIndex
DROP INDEX "favorites_userId_productId_key";

-- DropIndex
DROP INDEX "product_batches_productId_expiresAt_createdAt_id_idx";

-- DropIndex
DROP INDEX "products_price_id_idx";

-- DropIndex
DROP INDEX "products_stock_id_idx";

-- AlterTable
ALTER TABLE "favorites" ADD COLUMN     "variantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "order_batch_allocations" ADD COLUMN     "variantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "variantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "product_batches" ADD COLUMN     "variantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "product_images" DROP COLUMN "isPrimary";

-- AlterTable
ALTER TABLE "product_price_change_logs" ADD COLUMN     "variantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "products" DROP COLUMN "heightMm",
DROP COLUMN "lengthMm",
DROP COLUMN "price",
DROP COLUMN "reservedStock",
DROP COLUMN "saleEndsAt",
DROP COLUMN "salePrice",
DROP COLUMN "salePriorPrice",
DROP COLUMN "sku",
DROP COLUMN "stock",
DROP COLUMN "weightGrams",
DROP COLUMN "widthMm";

-- CreateTable
CREATE TABLE "product_variants" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "sku" VARCHAR(64),
    "barcode" VARCHAR(14),
    "price" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reservedStock" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "salePrice" DECIMAL(10,2),
    "saleEndsAt" TIMESTAMP(3),
    "salePriorPrice" DECIMAL(10,2),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_images" (
    "id" SERIAL NOT NULL,
    "variantId" INTEGER NOT NULL,
    "imageId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_variants_productId_deletedAt_idx" ON "product_variants"("productId", "deletedAt");

-- CreateIndex
CREATE INDEX "product_variants_price_id_idx" ON "product_variants"("price", "id");

-- CreateIndex
CREATE INDEX "product_variants_stock_id_idx" ON "product_variants"("stock", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_id_productId_key" ON "product_variants"("id", "productId");

-- CreateIndex
CREATE INDEX "variant_images_imageId_idx" ON "variant_images"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_images_variantId_imageId_key" ON "variant_images"("variantId", "imageId");

-- CreateIndex
CREATE INDEX "favorites_variantId_idx" ON "favorites"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_variantId_key" ON "favorites"("userId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_guestId_variantId_key" ON "favorites"("guestId", "variantId");

-- CreateIndex
CREATE INDEX "order_batch_allocations_variantId_idx" ON "order_batch_allocations"("variantId");

-- CreateIndex
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- CreateIndex
CREATE INDEX "product_batches_variantId_expiresAt_createdAt_id_idx" ON "product_batches"("variantId", "expiresAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "product_batches_productId_idx" ON "product_batches"("productId");

-- CreateIndex
CREATE INDEX "product_price_change_logs_variantId_createdAt_idx" ON "product_price_change_logs"("variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_images" ADD CONSTRAINT "variant_images_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_images" ADD CONSTRAINT "variant_images_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "product_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_allocations" ADD CONSTRAINT "order_batch_allocations_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_change_logs" ADD CONSTRAINT "product_price_change_logs_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

