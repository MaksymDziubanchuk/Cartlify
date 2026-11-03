-- CreateEnum
CREATE TYPE "ReturnSource" AS ENUM ('account', 'form_code', 'form_manual', 'admin');

-- CreateEnum
CREATE TYPE "ReturnBasis" AS ENUM ('withdrawal', 'other');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('defect', 'wrong_item', 'damaged', 'goodwill', 'shop_cancel', 'refused', 'other');

-- CreateEnum
CREATE TYPE "ReturnGoods" AS ENUM ('expected', 'to_stock', 'written_off', 'not_accepted', 'lost', 'not_arrived');

-- CreateEnum
CREATE TYPE "ReturnMoney" AS ENUM ('not_refunded', 'pending', 'refunded', 'refused');

-- CreateEnum
CREATE TYPE "ReturnNotAcceptedReason" AS ENUM ('unsealed', 'mixed', 'used', 'damaged', 'other');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('none', 'open', 'open_partial', 'partial', 'full', 'declined');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "returnStatus" "ReturnStatus" NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "order_batch_allocations" ADD COLUMN     "returned" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_log" ADD COLUMN     "returnItemId" INTEGER;

-- CreateTable
CREATE TABLE "returns" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "extendsId" INTEGER,
    "statedAt" TIMESTAMP(3) NOT NULL,
    "source" "ReturnSource" NOT NULL,
    "createdById" INTEGER,
    "basis" "ReturnBasis" NOT NULL,
    "reason" "ReturnReason",
    "description" VARCHAR(2000),
    "contactName" VARCHAR(200) NOT NULL,
    "contactEmail" VARCHAR(320) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "proofProvidedAt" TIMESTAMP(3),
    "proofConfirmedAt" TIMESTAMP(3),
    "proofConfirmedById" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_items" (
    "id" SERIAL NOT NULL,
    "returnId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "goods" "ReturnGoods" NOT NULL DEFAULT 'expected',
    "notAcceptedReason" "ReturnNotAcceptedReason",
    "money" "ReturnMoney" NOT NULL DEFAULT 'not_refunded',
    "amount" DECIMAL(10,2) NOT NULL,
    "goodsSetAt" TIMESTAMP(3),
    "goodsSetById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "returns_orderId_idx" ON "returns"("orderId");

-- CreateIndex
CREATE INDEX "returns_extendsId_idx" ON "returns"("extendsId");

-- CreateIndex
CREATE INDEX "returns_createdAt_id_idx" ON "returns"("createdAt", "id");

-- CreateIndex
CREATE INDEX "returns_closedAt_idx" ON "returns"("closedAt");

-- CreateIndex
CREATE INDEX "return_items_returnId_idx" ON "return_items"("returnId");

-- CreateIndex
CREATE INDEX "return_items_orderItemId_idx" ON "return_items"("orderItemId");

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_extendsId_fkey" FOREIGN KEY ("extendsId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_proofConfirmedById_fkey" FOREIGN KEY ("proofConfirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_goodsSetById_fkey" FOREIGN KEY ("goodsSetById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_log" ADD CONSTRAINT "stock_log_returnItemId_fkey" FOREIGN KEY ("returnItemId") REFERENCES "return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

