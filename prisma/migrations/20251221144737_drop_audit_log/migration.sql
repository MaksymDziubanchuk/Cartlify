/*
  Warnings:

  - You are about to drop the `audit_log` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actorId_fkey";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "popularityOverride" INTEGER,
ADD COLUMN     "popularityOverrideUntil" TIMESTAMP(3);

-- DropTable
DROP TABLE "audit_log";

-- DropEnum
DROP TYPE "AuditOperation";
