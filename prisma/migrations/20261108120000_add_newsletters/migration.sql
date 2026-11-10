-- CreateEnum
CREATE TYPE "NewsletterSource" AS ENUM ('form', 'account');

-- CreateEnum
CREATE TYPE "NewsletterSubscriptionStatus" AS ENUM ('pending', 'active', 'paused_complaint', 'stopped_bounce', 'ended');

-- CreateEnum
CREATE TYPE "NewsletterEndReason" AS ENUM ('unsubscribed', 'account_deleted', 'removed_by_admin', 'expired', 'not_me', 'bounced');

-- CreateEnum
CREATE TYPE "NewsletterEventKind" AS ENUM ('requested', 'confirmed', 'subscribed', 'locale_changed', 'locale_reset', 'unsubscribed', 'complaint', 'restored', 'bounced', 'account_deleted', 'removed_by_admin', 'expired', 'not_me');

-- CreateEnum
CREATE TYPE "NewsletterEventPlace" AS ENUM ('form', 'registration', 'profile', 'manage_page', 'mail_client', 'webhook', 'admin', 'system');

-- CreateEnum
CREATE TYPE "NewsletterCampaignStatus" AS ENUM ('draft', 'scheduled', 'sending', 'finished', 'cancelled', 'stopped');

-- CreateEnum
CREATE TYPE "NewsletterMissingLocale" AS ENUM ('shop_locale', 'skip');

-- CreateEnum
CREATE TYPE "NewsletterRecipientStatus" AS ENUM ('queued', 'sent', 'rejected', 'bounced', 'dropped', 'complained');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "canManageNewsletters" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "legal_documents" ADD COLUMN     "retentionNewsletterConsentDays" INTEGER,
ADD COLUMN     "retentionNewsletterRecipientsDays" INTEGER;

-- CreateTable
CREATE TABLE "newsletter_subscriptions" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "emailHmac" VARCHAR(64),
    "userId" INTEGER,
    "source" "NewsletterSource" NOT NULL,
    "locale" VARCHAR(2),
    "status" "NewsletterSubscriptionStatus" NOT NULL,
    "confirmHash" VARCHAR(64),
    "confirmExpiresAt" TIMESTAMP(3),
    "manageSalt" VARCHAR(128) NOT NULL,
    "manageHash" VARCHAR(64) NOT NULL,
    "lastConfirmMailAt" TIMESTAMP(3),
    "lastAlreadyMailAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" "NewsletterEndReason",
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscription_events" (
    "id" SERIAL NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "event" "NewsletterEventKind" NOT NULL,
    "place" "NewsletterEventPlace" NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "locale" VARCHAR(2),
    "campaignId" INTEGER,
    "privacyVersion" INTEGER,
    "actorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_campaigns" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "NewsletterCampaignStatus" NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "missingLocale" "NewsletterMissingLocale" NOT NULL,
    "content" JSONB NOT NULL,
    "productsSnapshot" JSONB,
    "createdById" INTEGER NOT NULL,
    "updatedById" INTEGER NOT NULL,
    "copiedFromId" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "undeliveredCount" INTEGER NOT NULL DEFAULT 0,
    "complaintCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_recipients" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "status" "NewsletterRecipientStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" VARCHAR(200),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_form_blocklist" (
    "id" SERIAL NOT NULL,
    "emailHmac" VARCHAR(64) NOT NULL,
    "blockedById" INTEGER,
    "byPerson" BOOLEAN NOT NULL DEFAULT false,
    "reason" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_form_blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriptions_manageHash_key" ON "newsletter_subscriptions"("manageHash");

-- CreateIndex
CREATE INDEX "newsletter_subscriptions_userId_idx" ON "newsletter_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "newsletter_subscriptions_status_id_idx" ON "newsletter_subscriptions"("status", "id");

-- CreateIndex
CREATE INDEX "newsletter_subscription_events_subscriptionId_createdAt_idx" ON "newsletter_subscription_events"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "newsletter_campaigns_status_scheduledAt_idx" ON "newsletter_campaigns"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "newsletter_campaigns_createdAt_id_idx" ON "newsletter_campaigns"("createdAt", "id");

-- CreateIndex
CREATE INDEX "newsletter_recipients_campaignId_status_id_idx" ON "newsletter_recipients"("campaignId", "status", "id");

-- CreateIndex
CREATE INDEX "newsletter_recipients_subscriptionId_idx" ON "newsletter_recipients"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_recipients_campaignId_subscriptionId_key" ON "newsletter_recipients"("campaignId", "subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_form_blocklist_emailHmac_key" ON "newsletter_form_blocklist"("emailHmac");

-- AddForeignKey
ALTER TABLE "newsletter_subscriptions" ADD CONSTRAINT "newsletter_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscription_events" ADD CONSTRAINT "newsletter_subscription_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "newsletter_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscription_events" ADD CONSTRAINT "newsletter_subscription_events_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "newsletter_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscription_events" ADD CONSTRAINT "newsletter_subscription_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_campaigns" ADD CONSTRAINT "newsletter_campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_campaigns" ADD CONSTRAINT "newsletter_campaigns_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_campaigns" ADD CONSTRAINT "newsletter_campaigns_copiedFromId_fkey" FOREIGN KEY ("copiedFromId") REFERENCES "newsletter_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_recipients" ADD CONSTRAINT "newsletter_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "newsletter_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_recipients" ADD CONSTRAINT "newsletter_recipients_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "newsletter_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_form_blocklist" ADD CONSTRAINT "newsletter_form_blocklist_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

