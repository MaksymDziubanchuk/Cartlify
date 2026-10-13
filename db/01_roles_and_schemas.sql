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

GRANT USAGE,
SELECT
,
UPDATE ON ALL SEQUENCES IN SCHEMA cartlify TO cartlify_app;

GRANT USAGE,
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
,
UPDATE ON SEQUENCES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT USAGE,
SELECT
  ON SEQUENCES TO cartlify_readonly;

------------------------------------------------------------
-- 5a. 
------------------------------------------------------------
REVOKE
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify
FROM
  PUBLIC;

GRANT
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify TO cartlify_app;

-- readonly: no functions, except read-only helpers granted below
REVOKE
EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify
FROM
  cartlify_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner
REVOKE
EXECUTE ON FUNCTIONS
FROM
  PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
GRANT
EXECUTE ON FUNCTIONS TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
REVOKE
EXECUTE ON FUNCTIONS
FROM
  cartlify_readonly;

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