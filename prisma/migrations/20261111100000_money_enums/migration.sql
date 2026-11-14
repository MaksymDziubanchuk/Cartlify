-- AlterEnum
ALTER TYPE "ReturnSource" ADD VALUE 'system';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReturnReason" ADD VALUE 'dispute_lost';
ALTER TYPE "ReturnReason" ADD VALUE 'stripe_refund';

-- AlterEnum
ALTER TYPE "ReturnMoney" ADD VALUE 'failed';

