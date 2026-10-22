-- Clears the orders and the stock of the shop and keeps everything else: the accounts, the
-- categories, the products with their prices and images, the reviews and their votes, the
-- favorites, the chats, the sessions and the logs of logins and prices.
--
-- Removed:
--   - every order with its items (carts too) and what the paid ones took from the batches;
--   - every batch; the stock and the reserved units of every product become 0, new stock comes
--     only with a delivery (POST /api/products/stock/deliveries);
--   - the lines of the admin log about them: the deliveries and the write-offs of the stock and
--     every line of an order (status changes, refunds). Other lines stay.
--
-- Run it under the superuser with psql: row level security hides the rows from every other role,
-- and the logs refuse deletes to the roles of the app. It runs again without harm, and on a
-- database without the batches yet (before the migration that adds them) it clears the orders.
-- Redis may keep timers and payment page links of the removed orders: the worker and the payment
-- code find no order behind them and do nothing.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  has_batches boolean := to_regclass('cartlify.product_batches') IS NOT NULL;
  has_allocations boolean := to_regclass('cartlify.order_batch_allocations') IS NOT NULL;
  n bigint;
BEGIN
  IF current_setting('is_superuser') <> 'on' THEN
    RAISE EXCEPTION 'run this script as the superuser: row level security would hide the rows';
  END IF;

  -- what the paid orders took from the batches holds both the orders and the batches
  IF has_allocations THEN
    EXECUTE 'DELETE FROM cartlify.order_batch_allocations';
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'batch allocations removed: %', n;
  END IF;

  -- the items go with their orders; the triggers count the popularity of their products again
  DELETE FROM cartlify.orders;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'orders removed: %', n;

  IF has_batches THEN
    EXECUTE 'DELETE FROM cartlify.product_batches';
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'batches removed: %', n;
  END IF;

  -- the stock is what the batches have left: none; no order holds units any more. The check of
  -- the stock against the batches runs at the commit and finds 0 on both sides
  UPDATE cartlify.products
  SET stock = 0, "reservedStock" = 0
  WHERE stock <> 0 OR "reservedStock" <> 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'products set to no stock: %', n;

  -- the lines about the removed stock and orders; the reports would count them otherwise
  DELETE FROM cartlify.admin_audit_log
  WHERE action::text IN ('STOCK_DELIVERY', 'STOCK_WRITE_OFF')
     OR "entityType" = 'order';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'admin log lines removed: %', n;
END
$$;

COMMIT;
