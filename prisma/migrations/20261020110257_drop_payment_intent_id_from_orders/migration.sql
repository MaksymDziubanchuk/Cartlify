/*
  Warnings:

  - You are about to drop the column `paymentIntentId` on the `orders` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "orders_paymentIntentId_key";

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "paymentIntentId";
