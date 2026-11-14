-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE 'MONEY_MANAGER_CHANGE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "canManageMoney" BOOLEAN NOT NULL DEFAULT false;

