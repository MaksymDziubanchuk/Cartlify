-- One-time fix. Run as postgres/superuser through psql.
-- Goal: bring search functions on PROD to the same state a fresh database gets from db/02:
--  - functions of pg_trgm and unaccent are owned by the owner of their extension again
--    (on PROD they ended up owned by cartlify_owner)
--  - cartlify.immutable_unaccent(text) has the same text as db/02 creates
-- Safe to rerun: on a database that is already in order it changes nothing.
BEGIN;

SET
  LOCAL lock_timeout = '5s';

SET
  LOCAL statement_timeout = '60s';

-- 1) Extension functions: give them back to the owner of their extension.
DO $do$
DECLARE
  r record;
  v_changed integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, pg_get_userbyid(e.extowner) AS ext_owner
    FROM pg_proc p
    JOIN pg_depend d
      ON d.classid = 'pg_proc'::regclass
     AND d.objid = p.oid
     AND d.refclassid = 'pg_extension'::regclass
     AND d.deptype = 'e'
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE e.extname IN ('pg_trgm', 'unaccent')
      AND p.proowner <> e.extowner
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.fn, r.ext_owner);
    v_changed := v_changed + 1;
  END LOOP;

  RAISE NOTICE 'extension functions returned to the extension owner: %', v_changed;
END
$do$;

-- 2) Function text: same statement and layout as in db/02, so the definition is identical everywhere.
-- CREATE OR REPLACE keeps the owner and the grants and does not touch the index that uses the function.
DO $do$
BEGIN
  EXECUTE $sql$
      CREATE OR REPLACE FUNCTION cartlify.immutable_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $fn$
        SELECT cartlify.unaccent($1)
      $fn$;
    $sql$;
END
$do$;

-- 3) Grants: cartlify_owner no longer owns unaccent, so it needs the same explicit grant db/02 gives.
GRANT
EXECUTE ON FUNCTION cartlify.unaccent (text) TO cartlify_owner;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (regdictionary, text) TO cartlify_owner;

COMMIT;
