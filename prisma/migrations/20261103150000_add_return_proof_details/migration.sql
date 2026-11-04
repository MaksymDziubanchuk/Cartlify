-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "proofCarrier" VARCHAR(100),
ADD COLUMN     "proofTrackingNumber" VARCHAR(100),
ADD COLUMN     "proofTrackingUrl" VARCHAR(500);

