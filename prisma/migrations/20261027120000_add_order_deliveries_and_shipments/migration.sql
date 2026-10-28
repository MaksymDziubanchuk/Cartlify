-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('manual', 'pickup');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "heightMm" INTEGER,
ADD COLUMN     "lengthMm" INTEGER,
ADD COLUMN     "weightGrams" INTEGER,
ADD COLUMN     "widthMm" INTEGER;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "note",
DROP COLUMN "recipientFirstName",
DROP COLUMN "recipientLastName",
DROP COLUMN "recipientPhone",
DROP COLUMN "shippingAddress";

-- CreateTable
CREATE TABLE "order_deliveries" (
    "orderId" INTEGER NOT NULL,
    "method" "DeliveryMethod" NOT NULL,
    "recipientFirstName" VARCHAR(100) NOT NULL,
    "recipientLastName" VARCHAR(100) NOT NULL,
    "recipientPhone" VARCHAR(16) NOT NULL,
    "country" VARCHAR(2),
    "postalCode" VARCHAR(16),
    "city" VARCHAR(100),
    "street" VARCHAR(150),
    "house" VARCHAR(20),
    "apartment" VARCHAR(40),
    "note" VARCHAR(500),
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_deliveries_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "order_shipments" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "carrier" VARCHAR(100),
    "trackingNumber" VARCHAR(100),
    "trackingUrl" VARCHAR(500),
    "cost" DECIMAL(10,2),
    "expense" BOOLEAN NOT NULL DEFAULT true,
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_deliveries_method_idx" ON "order_deliveries"("method");

-- CreateIndex
CREATE INDEX "order_deliveries_country_city_idx" ON "order_deliveries"("country", "city");

-- CreateIndex
CREATE INDEX "order_shipments_orderId_shippedAt_idx" ON "order_shipments"("orderId", "shippedAt");

-- CreateIndex
CREATE INDEX "order_shipments_shippedAt_idx" ON "order_shipments"("shippedAt");

-- AddForeignKey
ALTER TABLE "order_deliveries" ADD CONSTRAINT "order_deliveries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

