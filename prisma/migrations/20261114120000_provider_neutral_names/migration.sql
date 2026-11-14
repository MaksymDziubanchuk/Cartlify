-- The names of the database name no provider: the transaction of the balance a dispute moved
-- (money_log."balanceTxId"), the id of a dispute at its provider (payment_disputes."providerDisputeId"),
-- the reason of the statement of the system for a payment given back whole by hand in the dashboard
-- of its provider (provider_refund) and the setting of how long the payment page stays open after
-- the reservation (paymentPageMinutes). Renames only: every row keeps its value.
-- The data of the shop is only added to (db/05, trg_shop_settings_append_only; the policies of
-- db/03 forbid an update to the owner as well) and its check knows only the keys the server knows
-- (db/06, shop_settings_value_chk, with shop_setting_value_valid of db/05, which knows the new key
-- only once db/05 runs): for this step the owner lifts the force of the policies, the guard and the
-- check, renames the key in its rows and puts the force and the guard back; db/06 adds the check
-- again.

ALTER TABLE "money_log" RENAME COLUMN "stripeTxId" TO "balanceTxId";
ALTER INDEX "money_log_stripeTxId_key" RENAME TO "money_log_balanceTxId_key";

ALTER TABLE "payment_disputes" RENAME COLUMN "stripeId" TO "providerDisputeId";
ALTER INDEX "payment_disputes_stripeId_key" RENAME TO "payment_disputes_providerDisputeId_key";

ALTER TYPE "ReturnReason" RENAME VALUE 'stripe_refund' TO 'provider_refund';

ALTER TABLE "shop_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS "shop_settings_value_chk";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_shop_settings_append_only' AND tgrelid = '"shop_settings"'::regclass
  ) THEN
    ALTER TABLE "shop_settings" DISABLE TRIGGER trg_shop_settings_append_only;
    UPDATE "shop_settings" SET "key" = 'paymentPageMinutes' WHERE "key" = 'stripePageMinutes';
    ALTER TABLE "shop_settings" ENABLE TRIGGER trg_shop_settings_append_only;
  ELSE
    UPDATE "shop_settings" SET "key" = 'paymentPageMinutes' WHERE "key" = 'stripePageMinutes';
  END IF;
END $$;

ALTER TABLE "shop_settings" FORCE ROW LEVEL SECURITY;
