-- the kinds of alerts an admin or root turned off become the settings of each kind of an admin:
-- whether it is on and its threshold; a row that was there is a kind turned off and stays off.
-- The policies follow the table (db/03 names them anew), its guard is in db/05
-- RenameTable
ALTER TABLE "admin_alert_mutes" RENAME TO "admin_alert_settings";

-- RenameConstraint
ALTER TABLE "admin_alert_settings" RENAME CONSTRAINT "admin_alert_mutes_pkey" TO "admin_alert_settings_pkey";

ALTER TABLE "admin_alert_settings" RENAME CONSTRAINT "admin_alert_mutes_userId_fkey" TO "admin_alert_settings_userId_fkey";

-- AlterTable
ALTER TABLE "admin_alert_settings" ADD COLUMN "subscribed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "threshold" INTEGER;

ALTER TABLE "admin_alert_settings" ALTER COLUMN "subscribed" SET DEFAULT true;
