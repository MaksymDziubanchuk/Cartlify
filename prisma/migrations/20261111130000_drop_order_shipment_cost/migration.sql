-- What the shop pays the carrier for a send of an order leaves the send: the money journal is the
-- one source of the costs of the delivery (money.shipping_cost and its corrections money.correction,
-- by orderShipmentId, written by record_order_shipment_cost in db/schema/05), as it is for the
-- parcels back of the statements. Nothing of the sql scripts depends on the column (the check of
-- db/06 that held it goes with it); the costs of old sends are not carried over (the data of dev
-- are not kept, prod is not live).
-- AlterTable
ALTER TABLE "order_shipments" DROP COLUMN "cost";
