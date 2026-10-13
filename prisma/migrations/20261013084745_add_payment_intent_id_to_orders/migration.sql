/*
  Warnings:

  - A unique constraint covering the columns `[paymentIntentId]` on the table `orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "paymentIntentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_paymentIntentId_key" ON "orders"("paymentIntentId");
