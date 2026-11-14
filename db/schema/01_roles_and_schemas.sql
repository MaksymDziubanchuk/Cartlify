-- Roles, schema, rights on tables and sequences, and rights to run functions.
-- Run it as a superuser: it creates roles and hands out rights. It can be run again at any time.
-- Order on a new database: this file, the passwords of the roles, the prisma migrations, 02, 05,
-- 03, 04, 06, and this file once more. The second run covers what appeared after the first one:
-- the table of the prisma history and the functions of the lists in section 5a.
BEGIN;

------------------------------------------------------------
-- 1. Roles
------------------------------------------------------------
-- cartlify_owner owns the schema and what is made in it (the functions of the extensions
-- pg_trgm and unaccent stay with their installer), and the system functions run with its rights. cartlify_app is the role the server connects as; row level security limits it.
-- cartlify_readonly only reads. The passwords are set outside of this file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_owner') THEN
    CREATE ROLE cartlify_owner LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_app') THEN
    CREATE ROLE cartlify_app LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_readonly') THEN
    CREATE ROLE cartlify_readonly LOGIN;
  END IF;
END
$$;

------------------------------------------------------------
-- 1a. Search path
------------------------------------------------------------
-- Queries and functions find the objects of the shop without a schema prefix. The owner also
-- sees public.
ALTER ROLE cartlify_owner
SET
  search_path = 'cartlify',
  'public';

ALTER ROLE cartlify_app
SET
  search_path = 'cartlify';

ALTER ROLE cartlify_readonly
SET
  search_path = 'cartlify';

------------------------------------------------------------
-- 1a2. Timeouts of the app
------------------------------------------------------------
-- The timeout of a prisma transaction only stops the waiting of the app, the statement goes on
-- in the database. So the database ends a statement of the app after 15 s, and a transaction
-- left open and idle after 30 s. New sessions get these values.
ALTER ROLE cartlify_app
SET
  statement_timeout = '15s';

ALTER ROLE cartlify_app
SET
  idle_in_transaction_session_timeout = '30s';

-- No JIT for the app: its queries run in milliseconds, and the long ones (the reports, with many
-- ctes) are given a high cost by estimates that cannot see through their filters, so the database
-- compiled them on every call (about 1.7 s, against 57 ms to run one).
ALTER ROLE cartlify_app
SET
  jit = off;

------------------------------------------------------------
-- 1b. Extra rights of the owner
------------------------------------------------------------
-- may create databases
ALTER ROLE cartlify_owner CREATEDB;

-- may read the views of server statistics
GRANT pg_read_all_stats TO cartlify_owner;

------------------------------------------------------------
-- 2. Schema
------------------------------------------------------------
-- The schema belongs to the owner. A schema that exists already is handed over to the owner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'cartlify'
  ) THEN
    EXECUTE 'CREATE SCHEMA cartlify AUTHORIZATION cartlify_owner';
  ELSE
    EXECUTE 'ALTER SCHEMA cartlify OWNER TO cartlify_owner';
  END IF;
END
$$;

------------------------------------------------------------
-- 3. Access to the schema
------------------------------------------------------------
-- Public gets nothing. The app and readonly may look into the schema; what they may do with the
-- objects in it comes below.
REVOKE ALL ON SCHEMA cartlify
FROM
  PUBLIC;

GRANT USAGE ON SCHEMA cartlify TO cartlify_app;

GRANT USAGE ON SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4. Rights on tables and sequences
------------------------------------------------------------
-- the app reads and writes every table; row level security decides which rows
GRANT
SELECT
,
  INSERT,
UPDATE,
DELETE ON ALL TABLES IN SCHEMA cartlify TO cartlify_app;

-- readonly reads every table
GRANT
SELECT
  ON ALL TABLES IN SCHEMA cartlify TO cartlify_readonly;

-- the app takes ids with usage (nextval). It gets no update right: that would let it move a
-- sequence with setval, and a sequence moved back makes every insert of its table fail on a
-- taken id
GRANT USAGE,
SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify TO cartlify_app;

-- readonly only reads a sequence: usage would let it take ids with nextval
GRANT
SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4a. Prisma migration history: owner only
------------------------------------------------------------
-- The table appears after the first prisma migrate, so this file runs again after the migrations.
-- The app and readonly get no right on it.
DO $$
BEGIN
  IF to_regclass('cartlify._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE cartlify._prisma_migrations
    FROM
      cartlify_app,
      cartlify_readonly;
  END IF;
END
$$;

------------------------------------------------------------
-- 5. Default privileges
------------------------------------------------------------
-- The same rights on tables and sequences for the objects that cartlify_owner creates later
-- (new migrations).
ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT
SELECT
,
  INSERT,
UPDATE,
DELETE ON TABLES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT
SELECT
  ON TABLES TO cartlify_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT USAGE,
SELECT
  ON SEQUENCES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT
SELECT
  ON SEQUENCES TO cartlify_readonly;

------------------------------------------------------------
-- 5a. Function execute rights
------------------------------------------------------------
-- Every function starts closed: no right for public, the app or readonly. Each role then gets an
-- explicit list of the functions it calls. Internal functions (recalc_*, the steps of stock and
-- batches, delivery_price, the retention_* helpers, trigger functions) stay closed for the app: they
-- are called by triggers and by other functions (recalc_all_products_popularity is run by hand as
-- the owner until a periodic job exists).
-- The file is one transaction, so the app never sees the moment between the revoke and the grant.

-- close every function that exists now
REVOKE
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify
FROM
  PUBLIC;

REVOKE
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify
FROM
  cartlify_app;

REVOKE
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify
FROM
  cartlify_readonly;

-- close the functions that cartlify_owner creates later too (PostgreSQL would open them to
-- public). A function the app calls has to be added to the list below.
ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner
REVOKE
EXECUTE ON FUNCTIONS
FROM
  PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
REVOKE
EXECUTE ON FUNCTIONS
FROM
  cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
REVOKE
EXECUTE ON FUNCTIONS
FROM
  cartlify_readonly;

-- app: the functions it calls itself, and the ones that policies and search call for it.
-- They appear after 02 and 05, so this file runs again after them; a missing one is skipped.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    -- request context: the server sets it, policies and functions read it
    'cartlify.set_current_context(cartlify."Role", integer, uuid)',
    'cartlify.current_actor_id()',
    'cartlify.current_guest_id()',
    'cartlify.current_actor_role()',
    'cartlify.is_admin()',
    'cartlify.is_root()',
    'cartlify.is_system()',
    'cartlify.is_owner(integer)',
    'cartlify.is_owner_or_admin(integer)',
    -- the policies of the newsletter tables ask it: root, or an admin root allowed to run them
    'cartlify.newsletter_manager()',
    -- the guard of the money routes asks it: root, or an admin root allowed to handle the money
    'cartlify.money_manager()',
    -- product search
    'cartlify.immutable_unaccent(text)',
    -- accounts and login: they run as the owner, each checks the role of the actor first
    'cartlify.auth_get_user_for_login(text)',
    'cartlify.auth_resend_verify(text, text, timestamp with time zone)',
    'cartlify.auth_verify_email(text)',
    'cartlify.users_get_public_profile(integer)',
    'cartlify.remove_user_avatar(integer)',
    'cartlify.migrate_guest_data_to_user(uuid, integer)',
    -- subscriptions to the newsletters: a guest by the link of a mail, an account on its own
    -- address; each checks the actor itself (the helpers they call stay closed)
    'cartlify.newsletter_request(text, text, text, text, text, text, text, text, text)',
    'cartlify.newsletter_request_mail_failed(text, text)',
    'cartlify.newsletter_confirm(text, text, text)',
    'cartlify.newsletter_not_me(text, text, text)',
    'cartlify.newsletter_manage_get(text)',
    'cartlify.newsletter_manage_set_locale(text, text, text, text)',
    'cartlify.newsletter_manage_unsubscribe(text, integer, text, text, text)',
    'cartlify.newsletter_manage_resume(text, text, text)',
    'cartlify.newsletter_unsubscribe_one_click(text, integer, text, text)',
    'cartlify.newsletter_manage_export(text)',
    'cartlify.newsletter_subscribe_account(integer, text, text, text, text, text, text, text)',
    'cartlify.newsletter_profile_get(integer)',
    'cartlify.newsletter_profile_unsubscribe(integer, text, text)',
    'cartlify.newsletter_profile_set_locale(integer, text, text, text)',
    'cartlify.newsletter_profile_resume(integer, text, text)',
    'cartlify.newsletter_profile_export(integer)',
    'cartlify.newsletter_end_for_account(integer)',
    -- the webhook of the newsletters (the system), the people who run them (an address erased, an
    -- address blocked) and root (the right of an admin, the languages); each checks the
    -- actor itself, the helpers they call (newsletter_erase_subscription and the other internal
    -- steps) stay closed
    'cartlify.newsletter_apply_event(integer, text, text)',
    'cartlify.newsletter_admin_erase_address(integer)',
    'cartlify.newsletter_block_add(text, text)',
    'cartlify.newsletter_set_manager(integer, boolean)',
    -- root gives an admin the right to handle the money or takes it away
    'cartlify.money_set_manager(integer, boolean)',
    'cartlify.newsletter_locale_counts()',
    'cartlify.newsletter_reset_locale(text)',
    -- the sending of the newsletters (the system): a campaign started, a portion of the mails taken,
    -- the ones a pass did not try given back
    'cartlify.newsletter_start_campaign(integer, jsonb, text)',
    'cartlify.newsletter_claim_recipients(integer, integer[], integer, integer)',
    'cartlify.newsletter_release_recipients(integer[])',
    -- orders and payments: the same; unconfirm_order, pay_order and expire_order_reservation
    -- answer to the system only
    'cartlify.confirm_order(integer, interval, numeric, numeric, numeric)',
    'cartlify.unconfirm_order(integer)',
    'cartlify.cancel_order_payment(integer)',
    'cartlify.pay_order(integer, cartlify."PaymentProvider", text, numeric, text)',
    -- the cancel of the system locks the payment before the order, as every change of its money
    'cartlify.lock_money_payment(text)',
    -- the money journal: a payment the order could not take, the refunds of a payment and what the
    -- provider made by hand; each one checks the actor itself
    'cartlify.record_late_payment(cartlify."PaymentProvider", text, integer, integer, numeric, text, text)',
    'cartlify.begin_payment_refund(text, text, numeric, text)',
    'cartlify.settle_money_refund(text, text, text, cartlify."RefundFailure", text, boolean)',
    'cartlify.record_hand_refund(cartlify."PaymentProvider", text, text, numeric, text, text)',
    'cartlify.record_refund_bank_reference(text, text)',
    'cartlify.mark_payment_refund_outside(integer, cartlify."OutsideMethod", text, timestamp without time zone)',
    -- the compensation root gives, and the money the shop got back outside the app: each one checks
    -- the actor itself
    'cartlify.begin_compensation(integer, text, numeric, text)',
    'cartlify.record_money_received(integer, jsonb, cartlify."OutsideMethod", text, timestamp without time zone)',
    'cartlify.record_carrier_money(integer, numeric, cartlify."OutsideMethod", text, timestamp without time zone)',
    -- what a statement still owes and what money already with the buyer gave too much, for the card
    -- and the alerts: admin and root, checked by each one
    'cartlify.return_money_left(integer)',
    'cartlify.order_money_overpaid(integer)',
    -- what is overpaid: the money the buyer gave back, the rest given up, the goods kept; each one
    -- checks the actor itself
    'cartlify.record_overpaid_received(integer, numeric, cartlify."OutsideMethod", text, timestamp without time zone)',
    'cartlify.lose_overpaid(integer)',
    'cartlify.keep_return_goods(integer, jsonb)',
    -- the disputes, the holds of an order and what root decides on them, the cost of a send to a
    -- buyer: each one checks the actor itself (add_order_hold and remove_order_hold stay closed)
    'cartlify.sync_payment_dispute(cartlify."PaymentProvider", text, text, cartlify."DisputeStatus", text, timestamp without time zone, boolean, integer, boolean, timestamp without time zone, timestamp without time zone, jsonb)',
    'cartlify.mark_dispute_drafted(integer)',
    'cartlify.hold_payment_review(text, text)',
    'cartlify.release_payment_review(text, text)',
    'cartlify.hold_fraud_warning(text, text)',
    'cartlify.decide_order_hold(integer, text, text, text)',
    'cartlify.decide_money_use(integer, jsonb, numeric, text)',
    'cartlify.share_money_line(integer)',
    'cartlify.record_order_shipment_cost(integer, numeric)',
    'cartlify.expire_order_reservation(integer)',
    -- logins of a deleted account: root or the system
    'cartlify.anonymize_login_logs(integer)',
    -- cleanup of old data for the periodic tasks: the system only
    'cartlify.cleanup_user_tokens(integer)',
    'cartlify.cleanup_login_log_addresses()',
    'cartlify.cleanup_guest_data()',
    'cartlify.cleanup_deleted_accounts_chats()',
    'cartlify.cleanup_return_addresses()',
    'cartlify.cleanup_return_personal()',
    'cartlify.cleanup_deleted_accounts_recipients()',
    'cartlify.cleanup_newsletter_pending()',
    'cartlify.cleanup_newsletter_consent()',
    'cartlify.cleanup_newsletter_recipients()',
    -- admin only: the price journal, deliveries and write-offs of stock
    'cartlify.log_variant_price_change(integer, numeric, numeric, cartlify."PriceChangeMode", numeric, text, timestamp without time zone)',
    'cartlify.receive_variant_batch(uuid, integer, cartlify."StockSource", integer, numeric, date, text, text, text, text)',
    'cartlify.write_off_variant_stock(uuid, integer, integer, integer, text, text)',
    -- helpers: refresh_order_prices, product_current_price, variant_display_name, variant_names,
    -- shop_today, withdrawal_ends_at (reads no table) and log_admin_action run with the rights of
    -- the caller, so row level security applies;
    -- variant_expired_units and units_sold_in_period run as the owner, because a buyer cannot read
    -- the batches or the orders of others; product_withdrawals runs as the owner too, it reads
    -- the rule of a product a buyer may no longer see in the catalog
    'cartlify.refresh_order_prices(integer)',
    'cartlify.product_current_price(numeric, numeric, timestamp without time zone)',
    'cartlify.variant_display_name(integer)',
    'cartlify.variant_names(integer[])',
    'cartlify.shop_today()',
    'cartlify.withdrawal_ends_at(timestamp without time zone, integer, integer, text)',
    'cartlify.product_withdrawals(integer[])',
    -- the statements of withdrawal and of return: they check the actor themselves
    'cartlify.create_return(integer, jsonb, cartlify."ReturnSource", cartlify."ReturnBasis", cartlify."ReturnReason", text, text, text, timestamp without time zone, integer, integer, text)',
    'cartlify.receive_return_items(integer, jsonb, jsonb)',
    'cartlify.confirm_return_proof(integer, numeric, numeric)',
    'cartlify.accept_return(integer)',
    'cartlify.provide_return_proof(integer, text, text, text, numeric, jsonb)',
    'cartlify.split_return(integer, jsonb)',
    'cartlify.record_return_shipment(integer, text, text, text, numeric, timestamp without time zone)',
    'cartlify.send_return_goods_back(integer, jsonb, text, text, text, numeric, timestamp without time zone)',
    'cartlify.set_return_shipment_cost(integer, numeric)',
    'cartlify.set_return_parcel_buyer_paid(integer, numeric)',
    -- the money of the statements: they check the actor themselves
    'cartlify.begin_return_refund(integer, integer[], jsonb, numeric)',
    'cartlify.mark_return_refunded_outside(integer, integer[], cartlify."OutsideMethod", text, timestamp without time zone, numeric)',
    'cartlify.close_return_without_refund(integer, integer[], cartlify."ReturnCloseCode", text)',
    'cartlify.variant_expired_units(integer)',
    'cartlify.units_sold_in_period(timestamp without time zone, timestamp without time zone)',
    'cartlify.log_admin_action(integer, cartlify."Role", cartlify."AdminAuditEntityType", integer, cartlify."AdminAuditAction", text, jsonb)',
    -- the shape of the value of a setting of the data of the shop (db/06, shop_settings_value_chk):
    -- a CHECK constraint cannot hold a subquery, these run instead, as the role that writes the
    -- row (shop_settings_insert, db/03)
    'cartlify.shop_setting_value_valid(text, jsonb)',
    'cartlify.shop_setting_list_valid(jsonb, text)'
  ]
  LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cartlify_app', v_fn);
    END IF;
  END LOOP;
END
$$;

-- app: the functions of the extensions in this schema (pg_trgm, unaccent), used by the product
-- search. They are library code that reads no table, so every one is opened.
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    JOIN pg_depend AS d
      ON d.classid = 'pg_proc'::regclass
     AND d.objid = p.oid
     AND d.deptype = 'e'
    WHERE p.pronamespace = 'cartlify'::regnamespace
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cartlify_app', v_fn);
  END LOOP;
END
$$;

-- readonly: the readers of the request context that policies call, and the search helpers.
-- They appear after 02 and 05, so this file runs again after them; a missing one is skipped.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'cartlify.current_actor_id()',
    'cartlify.current_guest_id()',
    'cartlify.current_actor_role()',
    'cartlify.is_admin()',
    'cartlify.is_root()',
    'cartlify.is_system()',
    'cartlify.is_owner(integer)',
    'cartlify.is_owner_or_admin(integer)',
    -- the policies of the newsletter tables ask these two; with no context both answer false, so the
    -- role reads the tables without any row being opened to it
    'cartlify.newsletter_manager()',
    'cartlify.unaccent(text)',
    'cartlify.unaccent(regdictionary, text)',
    'cartlify.immutable_unaccent(text)'
  ]
  LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cartlify_readonly', v_fn);
    END IF;
  END LOOP;
END
$$;

COMMIT;