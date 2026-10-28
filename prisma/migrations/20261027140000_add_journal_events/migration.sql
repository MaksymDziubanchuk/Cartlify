-- Every line of the four journals names what made it (event). The lines that are there already
-- get legacy.unknown for a moment: the journals take no update, so the default fills the column
-- and is dropped at once, and a new line has to name its event

-- AlterTable
ALTER TABLE "login_logs" ADD COLUMN     "event" VARCHAR(60) NOT NULL DEFAULT 'legacy.unknown';
ALTER TABLE "login_logs" ALTER COLUMN "event" DROP DEFAULT;

-- AlterTable
ALTER TABLE "product_price_change_logs" ADD COLUMN     "event" VARCHAR(60) NOT NULL DEFAULT 'legacy.unknown';
ALTER TABLE "product_price_change_logs" ALTER COLUMN "event" DROP DEFAULT;

-- AlterTable
ALTER TABLE "admin_audit_log" ADD COLUMN     "event" VARCHAR(60) NOT NULL DEFAULT 'legacy.unknown';
ALTER TABLE "admin_audit_log" ALTER COLUMN "event" DROP DEFAULT;

-- AlterTable
ALTER TABLE "legal_acceptances" ADD COLUMN     "event" VARCHAR(60) NOT NULL DEFAULT 'legacy.unknown';
ALTER TABLE "legal_acceptances" ALTER COLUMN "event" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "login_logs_event_createdAt_idx" ON "login_logs"("event", "createdAt");

-- CreateIndex
CREATE INDEX "product_price_change_logs_event_createdAt_idx" ON "product_price_change_logs"("event", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_event_createdAt_idx" ON "admin_audit_log"("event", "createdAt");

-- CreateIndex
CREATE INDEX "legal_acceptances_event_createdAt_idx" ON "legal_acceptances"("event", "createdAt");
