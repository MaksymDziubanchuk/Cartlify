-- AlterEnum
ALTER TYPE "PriceChangeMode" ADD VALUE 'sale';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "saleEndsAt" TIMESTAMP(3),
ADD COLUMN     "salePrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "product_price_change_logs" ADD COLUMN     "endsAt" TIMESTAMP(3);
