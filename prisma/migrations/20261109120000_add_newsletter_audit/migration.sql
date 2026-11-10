-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditEntityType" ADD VALUE 'newsletter_campaign';
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'newsletter_subscriber';
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'newsletter_block';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'NEWSLETTER_MANAGER_CHANGE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'NEWSLETTER_CAMPAIGN_CHANGE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'NEWSLETTER_SUBSCRIBER_DELETE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'NEWSLETTER_BLOCK_CHANGE';

