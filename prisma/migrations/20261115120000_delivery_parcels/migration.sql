-- The delivery by the carriers of a delivery provider: the method carrier and the carrier the buyer
-- picked (order_deliveries), the parcels of the provider with their id there, their label and where
-- they stand (order_shipments; the time of a send is empty until the carrier takes the parcel), the
-- boxes of a parcel with what is in them (shipment_boxes), and what customs need of a product.
-- The price, the free threshold and the countries of the delivery are the zones of the shop
-- (deliveryZones): the rows of the three settings they take the place of (deliveryFlatPrice,
-- deliveryFreeFrom, deliveryCountries) leave the data of the shop, whose check knows only the keys
-- the server knows (db/06, shop_settings_value_chk). The data of the shop is only added to (db/05,
-- trg_shop_settings_append_only; the policies of db/03 forbid a delete to the owner as well): for
-- this step the owner lifts the force of the policies, the guard and the check, deletes the rows and
-- puts the force and the guard back; db/06 adds the check again, over every row left.

-- CreateEnum
CREATE TYPE "ParcelState" AS ENUM ('created', 'void_pending', 'voided', 'sent', 'delivered', 'returning', 'returned', 'lost');

-- AlterEnum
ALTER TYPE "DeliveryMethod" ADD VALUE 'carrier';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "hsCode" VARCHAR(10),
ADD COLUMN     "originCountry" VARCHAR(2);

-- AlterTable
ALTER TABLE "order_deliveries" ADD COLUMN     "carrierConnection" VARCHAR(100),
ADD COLUMN     "carrierName" VARCHAR(100),
ADD COLUMN     "carrierService" VARCHAR(100);

-- AlterTable
ALTER TABLE "order_shipments" ADD COLUMN     "labelUrl" VARCHAR(500),
ADD COLUMN     "providerParcelId" VARCHAR(100),
ADD COLUMN     "state" "ParcelState" NOT NULL DEFAULT 'sent',
ALTER COLUMN "shippedAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "shipment_boxes" (
    "id" SERIAL NOT NULL,
    "shipmentId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "trackingNumber" VARCHAR(100),
    "labelUrl" VARCHAR(500),
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_boxes_number_uidx" ON "shipment_boxes"("shipmentId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "order_shipments_providerParcelId_key" ON "order_shipments"("providerParcelId");

-- CreateIndex
CREATE INDEX "order_shipments_state_idx" ON "order_shipments"("state");

-- AddForeignKey
ALTER TABLE "shipment_boxes" ADD CONSTRAINT "shipment_boxes_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "order_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The settings the zones take the place of
ALTER TABLE "shop_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS "shop_settings_value_chk";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_shop_settings_append_only' AND tgrelid = '"shop_settings"'::regclass
  ) THEN
    ALTER TABLE "shop_settings" DISABLE TRIGGER trg_shop_settings_append_only;
    DELETE FROM "shop_settings"
    WHERE "key" IN ('deliveryFlatPrice', 'deliveryFreeFrom', 'deliveryCountries');
    ALTER TABLE "shop_settings" ENABLE TRIGGER trg_shop_settings_append_only;
  ELSE
    DELETE FROM "shop_settings"
    WHERE "key" IN ('deliveryFlatPrice', 'deliveryFreeFrom', 'deliveryCountries');
  END IF;
END $$;

ALTER TABLE "shop_settings" FORCE ROW LEVEL SECURITY;
