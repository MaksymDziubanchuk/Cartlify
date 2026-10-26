BEGIN;

------------------------------------------------------------
-- 1. Roles
------------------------------------------------------------
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
-- 1a. SEARCH_PATH
------------------------------------------------------------
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
-- 1a2. TIMEOUTS of the app
------------------------------------------------------------
-- the timeout of a prisma transaction only stops the waiting of the app, the statement goes on
-- in the database: a statement of the app ends after 15 s (the reports take 15 s for their whole
-- transaction too), a transaction left open and idle after 30 s. New sessions take them
ALTER ROLE cartlify_app
SET
  statement_timeout = '15s';

ALTER ROLE cartlify_app
SET
  idle_in_transaction_session_timeout = '30s';

------------------------------------------------------------
-- 1b. owner role extras (were set by hand on railway)
------------------------------------------------------------
-- may create databases
ALTER ROLE cartlify_owner CREATEDB;

-- read access to server statistics views
GRANT pg_read_all_stats TO cartlify_owner;

------------------------------------------------------------
-- 2. 
------------------------------------------------------------
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
-- 3. 
------------------------------------------------------------
REVOKE ALL ON SCHEMA cartlify
FROM
  PUBLIC;

GRANT USAGE ON SCHEMA cartlify TO cartlify_app;

GRANT USAGE ON SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4. 
------------------------------------------------------------
GRANT
SELECT
,
  INSERT,
UPDATE,
DELETE ON ALL TABLES IN SCHEMA cartlify TO cartlify_app;

GRANT
SELECT
  ON ALL TABLES IN SCHEMA cartlify TO cartlify_readonly;

-- the app takes ids with usage (nextval); update would let it move a sequence with setval,
-- and a sequence moved back makes every insert of its table fail on a taken id
GRANT USAGE,
SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify TO cartlify_app;

-- readonly only reads a sequence; usage would let it take ids with nextval
GRANT
SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4a. prisma migration history: owner only
------------------------------------------------------------
-- table appears after the first prisma migrate, so rerun this file after it
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
-- 5. DEFAULT PRIVILEGES
------------------------------------------------------------
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
-- 5a. FUNCTION EXECUTE RIGHTS
------------------------------------------------------------
-- every function starts closed: no right for public, app or readonly.
-- each role then gets an explicit list of what it calls; internal functions
-- (recalc_*, *_product_stock, trigger functions, maintenance) stay closed for the app,
-- they run only from triggers or from system functions, as the owner.
-- the whole file is one transaction, so the app never sees the moment between revoke and grant
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

-- new functions start closed too: a function the app calls has to be added to the list below
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

-- app: functions it calls itself, and the ones rls policies and search call on its behalf.
-- functions appear after db/02 and db/05, so rerun this file after them; a missing one is skipped
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    -- request context and its readers, used by every rls policy
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
    -- system functions: each checks the actor role itself before it acts as the owner
    'cartlify.auth_get_user_for_login(text)',
    'cartlify.auth_resend_verify(text, text, timestamp with time zone)',
    'cartlify.auth_verify_email(text)',
    'cartlify.users_get_public_profile(integer)',
    'cartlify.remove_user_avatar(integer)',
    'cartlify.migrate_guest_data_to_user(uuid, integer)',
    'cartlify.confirm_order(integer, interval)',
    'cartlify.unconfirm_order(integer)',
    'cartlify.cancel_order_payment(integer)',
    'cartlify.cancel_paid_order(integer)',
    'cartlify.pay_order(integer, cartlify."PaymentProvider", text, numeric)',
    'cartlify.expire_order_reservation(integer)',
    'cartlify.anonymize_login_logs(integer)',
    -- maintenance the periodic tasks run as the system, each checks it is the system
    'cartlify.cleanup_user_tokens(integer)',
    'cartlify.cleanup_login_log_addresses(integer)',
    'cartlify.cleanup_guest_data(integer)',
    'cartlify.cleanup_deleted_accounts_chats(integer)',
    'cartlify.log_product_price_change(integer, numeric, numeric, cartlify."PriceChangeMode", numeric, timestamp without time zone)',
    'cartlify.receive_product_batch(uuid, integer, cartlify."StockSource", integer, numeric, date, text, text, text, text)',
    'cartlify.write_off_product_stock(uuid, integer, integer, integer, text, text)',
    -- functions that run with the app rights, under its rls
    'cartlify.refresh_order_prices(integer)',
    'cartlify.product_current_price(numeric, numeric, timestamp without time zone)',
    'cartlify.shop_today()',
    'cartlify.product_expired_units(integer)',
    'cartlify.log_admin_action(integer, cartlify."Role", cartlify."AdminAuditEntityType", integer, cartlify."AdminAuditAction", jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cartlify_app', v_fn);
    END IF;
  END LOOP;
END
$$;

-- app: functions of the extensions in this schema (pg_trgm, unaccent) used by product search;
-- they are library code without data access, so all of them are open
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

-- readonly: context readers used by rls policies and search helpers
-- functions appear after db/02 and db/05, so rerun this file after them on a fresh database
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