-- The parcels of an order in one table: order_shipments
-- keeps the sends of the order and now the parcels of the statements too (returnId, direction, who
-- recorded a parcel, who confirmed a parcel to the shop and what the buyer paid the carrier for
-- it); return_shipments and the columns of the proof of a statement go, and the cost of a parcel of
-- a statement is a line of the money journal that names the parcel by orderShipmentId. A row of a
-- statement may name the parcel that carried it back to the buyer, a statement the one it was split
-- from. The rows of the old table and the proof of the statements are not carried over: the data of
-- dev and prod is not of value (prod is not live), as in the migrations of the payments.

-- CreateEnum
CREATE TYPE "ShipmentDirection" AS ENUM ('to_buyer', 'to_shop');

-- DropForeignKey
ALTER TABLE "returns" DROP CONSTRAINT "returns_proofConfirmedById_fkey";

-- DropForeignKey
ALTER TABLE "return_shipments" DROP CONSTRAINT "return_shipments_returnId_fkey";

-- DropForeignKey
ALTER TABLE "return_shipments" DROP CONSTRAINT "return_shipments_recordedById_fkey";

-- AlterTable
ALTER TABLE "order_shipments" ADD COLUMN     "buyerPaid" DECIMAL(10,2),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "direction" "ShipmentDirection" NOT NULL DEFAULT 'to_buyer',
ADD COLUMN     "recordedById" INTEGER,
ADD COLUMN     "returnId" INTEGER;

-- AlterTable
ALTER TABLE "returns" DROP COLUMN "proofCarrier",
DROP COLUMN "proofConfirmedAt",
DROP COLUMN "proofConfirmedById",
DROP COLUMN "proofProvidedAt",
DROP COLUMN "proofTrackingNumber",
DROP COLUMN "proofTrackingUrl",
ADD COLUMN     "splitFromId" INTEGER;

-- AlterTable
ALTER TABLE "return_items" ADD COLUMN     "backShipmentId" INTEGER;

-- DropTable
DROP TABLE "return_shipments";

-- CreateIndex
CREATE INDEX "order_shipments_returnId_idx" ON "order_shipments"("returnId");

-- CreateIndex
CREATE INDEX "returns_splitFromId_idx" ON "returns"("splitFromId");

-- CreateIndex
CREATE INDEX "return_items_backShipmentId_idx" ON "return_items"("backShipmentId");

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_backShipmentId_fkey" FOREIGN KEY ("backShipmentId") REFERENCES "order_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

