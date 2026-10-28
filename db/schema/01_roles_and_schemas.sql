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
-- batches, delivery_price, retention_cutoff, trigger functions) stay closed for the app: they
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
    -- product search
    'cartlify.immutable_unaccent(text)',
    -- accounts and login: they run as the owner, each checks the role of the actor first
    'cartlify.auth_get_user_for_login(text)',
    'cartlify.auth_resend_verify(text, text, timestamp with time zone)',
    'cartlify.auth_verify_email(text)',
    'cartlify.users_get_public_profile(integer)',
    'cartlify.remove_user_avatar(integer)',
    'cartlify.migrate_guest_data_to_user(uuid, integer)',
    -- orders and payments: the same; unconfirm_order, pay_order and expire_order_reservation
    -- answer to the system only
    'cartlify.confirm_order(integer, interval, numeric, numeric, numeric)',
    'cartlify.unconfirm_order(integer)',
    'cartlify.cancel_order_payment(integer)',
    'cartlify.cancel_paid_order(integer)',
    'cartlify.pay_order(integer, cartlify."PaymentProvider", text, numeric)',
    'cartlify.expire_order_reservation(integer)',
    -- logins of a deleted account: root or the system
    'cartlify.anonymize_login_logs(integer)',
    -- cleanup of old data for the periodic tasks: the system only
    'cartlify.cleanup_user_tokens(integer)',
    'cartlify.cleanup_login_log_addresses(integer)',
    'cartlify.cleanup_guest_data(integer)',
    'cartlify.cleanup_deleted_accounts_chats(integer)',
    -- admin only: the price journal, deliveries and write-offs of stock
    'cartlify.log_product_price_change(integer, numeric, numeric, cartlify."PriceChangeMode", numeric, text, timestamp without time zone)',
    'cartlify.receive_product_batch(uuid, integer, cartlify."StockSource", integer, numeric, date, text, text, text, text)',
    'cartlify.write_off_product_stock(uuid, integer, integer, integer, text, text)',
    -- helpers: refresh_order_prices, product_current_price, shop_today and log_admin_action run
    -- with the rights of the caller, so row level security applies; product_expired_units and
    -- units_sold_in_period run as the owner, because a buyer cannot read the batches or the orders
    -- of others
    'cartlify.refresh_order_prices(integer)',
    'cartlify.product_current_price(numeric, numeric, timestamp without time zone)',
    'cartlify.shop_today()',
    'cartlify.product_expired_units(integer)',
    'cartlify.units_sold_in_period(timestamp without time zone, timestamp without time zone)',
    'cartlify.log_admin_action(integer, cartlify."Role", cartlify."AdminAuditEntityType", integer, cartlify."AdminAuditAction", text, jsonb)'
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
    'cartlify.is_owner(integer)',
    'cartlify.is_owner_or_admin(integer)',
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