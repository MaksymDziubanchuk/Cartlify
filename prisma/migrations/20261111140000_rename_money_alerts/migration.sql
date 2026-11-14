-- The alerts of the money of the payments: each kind of refund has an
-- alert of its own, so two kinds are renamed and one is gone. admin_alert_settings.kind is text, no
-- type changes: the setting an admin or root kept for a renamed kind (followed or not, the threshold)
-- goes on under the new name, the rows of the kind that is gone are deleted.
-- The table forces its policies on its owner too (db/03: each admin reads and changes only their own
-- rows) and its guard lets an update change no kind (trg_admin_alert_settings_update_columns, db/05):
-- the owner lifts the force for this step only, writes the rows of the new names and deletes the old
-- ones, and puts the force back (db/03 puts it again too).

ALTER TABLE "admin_alert_settings" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "admin_alert_settings" ("userId", "kind", "subscribed", "threshold")
SELECT s."userId", 'late_refunds', s."subscribed", s."threshold"
FROM "admin_alert_settings" AS s
WHERE s."kind" = 'refunded_payments'
ON CONFLICT ("userId", "kind") DO NOTHING;

INSERT INTO "admin_alert_settings" ("userId", "kind", "subscribed", "threshold")
SELECT s."userId", 'late_refunds_in_transit', s."subscribed", s."threshold"
FROM "admin_alert_settings" AS s
WHERE s."kind" = 'refunded_payments_not_sent'
ON CONFLICT ("userId", "kind") DO NOTHING;

DELETE FROM "admin_alert_settings"
WHERE "kind" IN ('refunded_payments', 'refunded_payments_not_sent', 'failed_refunds');

ALTER TABLE "admin_alert_settings" FORCE ROW LEVEL SECURITY;
