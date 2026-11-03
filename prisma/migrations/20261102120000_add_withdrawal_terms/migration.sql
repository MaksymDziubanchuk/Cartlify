-- CreateEnum
CREATE TYPE "ReturnShippingPayer" AS ENUM ('buyer', 'shop');

-- AlterEnum
ALTER TYPE "LegalDocumentKind" ADD VALUE 'privacy';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "returnShippingPaidBy" "ReturnShippingPayer",
ADD COLUMN     "withdrawalDays" INTEGER;

-- AlterTable
ALTER TABLE "legal_documents" ADD COLUMN     "retentionDeletedChatsDays" INTEGER,
ADD COLUMN     "retentionGuestDataDays" INTEGER,
ADD COLUMN     "retentionLoginAddressesDays" INTEGER,
ADD COLUMN     "retentionRecipientDays" INTEGER,
ADD COLUMN     "retentionReturnAddressesDays" INTEGER,
ADD COLUMN     "retentionReturnPersonalDays" INTEGER,
ADD COLUMN     "returnAddress" VARCHAR(500),
ADD COLUMN     "returnShippingPaidBy" "ReturnShippingPayer",
ADD COLUMN     "withdrawalDays" INTEGER;

