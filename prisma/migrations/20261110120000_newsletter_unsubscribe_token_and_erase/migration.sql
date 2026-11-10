-- The newsletter tables hold no rows on any database yet (the first newsletter migration was never
-- applied with data), so the column "unsubscribeHash" is added NOT NULL without a default.

-- CreateEnum
CREATE TYPE "NewsletterCancelReason" AS ENUM ('limit');

-- AlterTable
ALTER TABLE "newsletter_subscriptions" ADD COLUMN     "endedUserId" INTEGER,
ADD COLUMN     "unsubscribeHash" VARCHAR(64) NOT NULL;

-- AlterTable
ALTER TABLE "newsletter_campaigns" ADD COLUMN     "cancelReason" "NewsletterCancelReason";

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriptions_unsubscribeHash_key" ON "newsletter_subscriptions"("unsubscribeHash");

-- CreateIndex
CREATE INDEX "newsletter_subscriptions_endedUserId_idx" ON "newsletter_subscriptions"("endedUserId");

-- AddForeignKey
ALTER TABLE "newsletter_subscriptions" ADD CONSTRAINT "newsletter_subscriptions_endedUserId_fkey" FOREIGN KEY ("endedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

