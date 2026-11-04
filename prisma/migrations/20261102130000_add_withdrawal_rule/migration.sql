-- CreateEnum
CREATE TYPE "WithdrawalRule" AS ENUM ('allowed', 'sealed_hygiene', 'sealed_media', 'mixed', 'perishable', 'personalised', 'periodical');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "withdrawal" "WithdrawalRule";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "withdrawal" "WithdrawalRule";

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "withdrawal" "WithdrawalRule" NOT NULL DEFAULT 'allowed';

