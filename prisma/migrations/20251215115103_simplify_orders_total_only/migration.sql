/*
  Warnings:

  - You are about to drop the column `discount` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `shipping` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `subtotal` on the `orders` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "orders" DROP COLUMN "discount",
DROP COLUMN "shipping",
DROP COLUMN "subtotal",
ADD COLUMN     "confirmed" BOOLEAN NOT NULL DEFAULT false;
