
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
-- 1a. SEARCH_PATH + public
------------------------------------------------------------

ALTER ROLE cartlify_owner    SET search_path = 'cartlify', 'public';
ALTER ROLE cartlify_app      SET search_path = 'cartlify';
ALTER ROLE cartlify_readonly SET search_path = 'cartlify';


REVOKE ALL ON SCHEMA public FROM cartlify_app;
REVOKE ALL ON SCHEMA public FROM cartlify_readonly;

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


REVOKE ALL ON SCHEMA cartlify FROM PUBLIC;


GRANT USAGE ON SCHEMA cartlify TO cartlify_app;
GRANT USAGE ON SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4. 
------------------------------------------------------------


GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA cartlify
  TO cartlify_app;

GRANT SELECT
  ON ALL TABLES IN SCHEMA cartlify
  TO cartlify_readonly;


GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA cartlify
  TO cartlify_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify
  TO cartlify_readonly;

------------------------------------------------------------
-- 5. DEFAULT PRIVILEGES 
------------------------------------------------------------


ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT SELECT ON TABLES TO cartlify_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT USAGE, SELECT ON SEQUENCES TO cartlify_readonly;

------------------------------------------------------------
-- 5a. 
------------------------------------------------------------

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify TO cartlify_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify TO cartlify_readonly;


ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT EXECUTE ON FUNCTIONS TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT EXECUTE ON FUNCTIONS TO cartlify_readonly;


COMMIT;