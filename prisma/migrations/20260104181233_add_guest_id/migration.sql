/*
  Warnings:

  - A unique constraint covering the columns `[guestId,productId]` on the table `favorites` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'GUEST';

-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN     "guestId" UUID,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "favorites" ADD COLUMN     "guestId" UUID,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "chat_threads_guestId_status_type_lastMessageAt_idx" ON "chat_threads"("guestId", "status", "type", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_guestId_productId_key" ON "favorites"("guestId", "productId");
