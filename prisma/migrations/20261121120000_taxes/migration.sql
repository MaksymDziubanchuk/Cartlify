-- The taxes of a sale, its documents and fiscal receipts: the countries the shop sells to with the
-- rule of their tax, their rates and what the rule needs (shop_countries), the tax groups of the
-- products (tax_groups, products.taxGroupId and taxExceptions), the tax an order item and the
-- delivery hold as the confirmation fixed it (order_items, order_deliveries), the invoice a buyer
-- asked for (orders.invoiceRequested), the documents and receipts (tax_documents), and the alerts a
-- person subscribes to by themselves, with a second number for a window (admin_alert_settings), and
-- the term the privacy policy keeps the copy of the buyer in the tax documents (legal_documents), and
-- the tax a line of the money journal holds, share by share of the copy of its order (money_log), and
-- how the commercial invoice of a parcel with the tax number of the shop reaches the customs
-- (order_shipments.customsInvoice), and the units of the rows of a statement money already with the
-- buyer pays, which the reception marks (return_items.paidUnits, paidDelivery, splitFromId), in
-- place of the part covered of the money journal (MoneyPart) and of the line a row named
-- (return_items.moneyLogId).

-- CreateEnum
CREATE TYPE "CustomsInvoiceMode" AS ENUM ('electronic', 'print');

-- CreateEnum
CREATE TYPE "TaxRule" AS ENUM ('seller', 'recipient', 'none', 'buyer_at_receipt');

-- CreateEnum
CREATE TYPE "TaxNumberKind" AS ENUM ('ioss', 'other');

-- CreateEnum
CREATE TYPE "ThresholdPeriod" AS ENUM ('year', 'rolling_12');

-- CreateEnum
CREATE TYPE "DeliveryVatRule" AS ENUM ('main', 'proportional');

-- CreateEnum
CREATE TYPE "ExportPriceRule" AS ENUM ('same', 'without_seller_vat');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('invoice', 'credit_note', 'receipt', 'return_receipt');

-- CreateEnum
CREATE TYPE "ReceiptState" AS ENUM ('pending', 'registered', 'refused', 'manual');

-- AlterEnum
-- The part covered goes from the money journal: the check of the shape names the part and is made
-- again by db/06, the view of the statistics reads the column and is made again by db/04.
ALTER TABLE "money_log" DROP CONSTRAINT IF EXISTS "money_log_shape_chk";
DROP VIEW IF EXISTS "admin_stats_view";

BEGIN;
CREATE TYPE "MoneyPart_new" AS ENUM ('goods', 'delivery', 'deduction', 'way_back', 'whole');
ALTER TABLE "money_log" ALTER COLUMN "part" TYPE "MoneyPart_new" USING ("part"::text::"MoneyPart_new");
ALTER TYPE "MoneyPart" RENAME TO "MoneyPart_old";
ALTER TYPE "MoneyPart_new" RENAME TO "MoneyPart";
DROP TYPE "MoneyPart_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_moneyLogId_fkey";

-- DropIndex
DROP INDEX "return_items_moneyLogId_idx";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "taxExceptions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "taxGroupId" INTEGER;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "invoiceRequested" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "order_deliveries" ADD COLUMN     "taxAmount" DECIMAL(10,2),
ADD COLUMN     "taxLines" JSONB,
ADD COLUMN     "taxRule" "TaxRule";

-- AlterTable
ALTER TABLE "order_shipments" ADD COLUMN     "customsInvoice" "CustomsInvoiceMode";

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "listUnitPrice" DECIMAL(10,2),
ADD COLUMN     "taxAmount" DECIMAL(10,2),
ADD COLUMN     "taxCountry" VARCHAR(2),
ADD COLUMN     "taxGroupId" INTEGER,
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "taxRule" "TaxRule";

-- AlterTable
ALTER TABLE "return_items" DROP COLUMN "moneyLogId",
ADD COLUMN     "paidDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "splitFromId" INTEGER;

-- AlterTable
ALTER TABLE "money_log" ADD COLUMN     "taxShares" JSONB;

-- AlterTable
ALTER TABLE "admin_alert_settings" ADD COLUMN     "window" INTEGER,
ALTER COLUMN "subscribed" SET DEFAULT false;

-- AlterTable
ALTER TABLE "legal_documents" ADD COLUMN     "retentionTaxDocumentsDays" INTEGER;

-- CreateTable
CREATE TABLE "shop_countries" (
    "country" VARCHAR(2) NOT NULL,
    "customsFree" BOOLEAN NOT NULL,
    "rule" "TaxRule",
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "taxNumber" VARCHAR(50),
    "taxNumberLabel" VARCHAR(30),
    "taxNumberKind" "TaxNumberKind",
    "parcelLimit" DECIMAL(10,2),
    "parcelLimitWithDelivery" BOOLEAN,
    "parcelLimitWithVat" BOOLEAN,
    "thresholdAmount" DECIMAL(10,2),
    "thresholdWithVat" BOOLEAN,
    "thresholdGroup" VARCHAR(50),
    "thresholdPeriod" "ThresholdPeriod",
    "thresholdStartMonth" INTEGER,
    "thresholdInitialFrom" TIMESTAMP(3),
    "thresholdHeldAt" TIMESTAMP(3),
    "deliveryVat" "DeliveryVatRule",
    "exportPrice" "ExportPriceRule",
    "exemptionText" VARCHAR(500),
    "rates" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_countries_pkey" PRIMARY KEY ("country")
);

-- CreateTable
CREATE TABLE "tax_groups" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_documents" (
    "id" SERIAL NOT NULL,
    "kind" "TaxDocumentKind" NOT NULL,
    "series" VARCHAR(20),
    "number" INTEGER,
    "orderId" INTEGER NOT NULL,
    "moneyLogId" INTEGER NOT NULL,
    "correctsId" INTEGER,
    "documentId" INTEGER,
    "locale" VARCHAR(2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "net" DECIMAL(10,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "taxCountry" VARCHAR(2),
    "taxRule" "TaxRule",
    "provider" VARCHAR(30),
    "receiptState" "ReceiptState",
    "receiptStateAt" TIMESTAMP(3),
    "receiptNumber" VARCHAR(100),
    "receiptUrl" VARCHAR(2048),
    "receiptCode" TEXT,
    "receiptText" VARCHAR(500),
    "receiptAttempts" INTEGER NOT NULL DEFAULT 0,
    "receiptError" VARCHAR(500),
    "receiptNextAt" TIMESTAMP(3),
    "receiptConfirmedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_countries_thresholdGroup_idx" ON "shop_countries"("thresholdGroup");

-- CreateIndex
CREATE UNIQUE INDEX "tax_groups_name_key" ON "tax_groups"("name");

-- CreateIndex
CREATE INDEX "tax_documents_orderId_idx" ON "tax_documents"("orderId");

-- CreateIndex
CREATE INDEX "tax_documents_moneyLogId_idx" ON "tax_documents"("moneyLogId");

-- CreateIndex
CREATE INDEX "tax_documents_kind_createdAt_idx" ON "tax_documents"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tax_documents_series_number_key" ON "tax_documents"("series", "number");

-- CreateIndex
CREATE INDEX "products_taxGroupId_idx" ON "products"("taxGroupId");

-- CreateIndex
CREATE INDEX "return_items_splitFromId_idx" ON "return_items"("splitFromId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_taxGroupId_fkey" FOREIGN KEY ("taxGroupId") REFERENCES "tax_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES "return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_moneyLogId_fkey" FOREIGN KEY ("moneyLogId") REFERENCES "money_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_correctsId_fkey" FOREIGN KEY ("correctsId") REFERENCES "tax_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "tax_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_receiptConfirmedById_fkey" FOREIGN KEY ("receiptConfirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

