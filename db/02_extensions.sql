-- db/02_extensions_search_safe.sql
-- Goal: replicate existing migration behavior safely:
--  - ensure pg_trgm + unaccent exist
--  - ensure extension objects live in schema cartlify
--  - ensure cartlify.immutable_unaccent(text) exists with expected definition
--  - ensure products_name_unaccent_trgm_idx exists with expected expression/opclass
-- If already in desired state -> do nothing.
BEGIN;

SET
  LOCAL lock_timeout = '5s';

SET
  LOCAL statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS cartlify;

-- 1) Extensions: ensure they exist; if exist but not in cartlify -> move (same intent as your migration)
DO $do$
DECLARE
  s text;
BEGIN
  -- pg_trgm
  SELECT n.nspname INTO s
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  IF s IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA cartlify';
  ELSIF s <> 'cartlify' THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA cartlify';
  END IF;

  -- unaccent
  SELECT n.nspname INTO s
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';

  IF s IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA cartlify';
  ELSIF s <> 'cartlify' THEN
    EXECUTE 'ALTER EXTENSION unaccent SET SCHEMA cartlify';
  END IF;
END
$do$;

-- 2) Function: create ONLY if missing.
-- If exists but differs -> error (to avoid silently masking mismatch).
DO $do$
DECLARE
  fn_oid oid;
  fn_def text;
BEGIN
  SELECT p.oid INTO fn_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'cartlify'
    AND p.proname = 'immutable_unaccent'
    AND pg_get_function_identity_arguments(p.oid) = 'text';

  IF fn_oid IS NULL THEN
    EXECUTE $sql$
      CREATE FUNCTION cartlify.immutable_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $fn$
        SELECT cartlify.unaccent($1)
      $fn$;
    $sql$;
  ELSE
    IF (SELECT provolatile FROM pg_proc WHERE oid = fn_oid) <> 'i' THEN
      RAISE EXCEPTION 'immutable_unaccent exists but is not IMMUTABLE';
    END IF;

    IF (SELECT proisstrict FROM pg_proc WHERE oid = fn_oid) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'immutable_unaccent exists but is not STRICT';
    END IF;

    SELECT pg_get_functiondef(fn_oid) INTO fn_def;

    IF position('SELECT cartlify.unaccent($1)' IN fn_def) = 0 THEN
      RAISE EXCEPTION 'immutable_unaccent exists but definition differs: %', fn_def;
    END IF;
  END IF;
END
$do$;

-- 3) Index: create if missing. If exists but not matching -> error.
DO $do$
DECLARE
  idxdef text;
BEGIN
  IF to_regclass('cartlify.products') IS NULL THEN
    RAISE NOTICE 'cartlify.products does not exist yet; skipping index creation';
    RETURN;
  END IF;

  SELECT pg_get_indexdef(i.indexrelid)
  INTO idxdef
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE tn.nspname = 'cartlify'
    AND tc.relname = 'products'
    AND ic.relname = 'products_name_unaccent_trgm_idx';

  IF idxdef IS NULL THEN
    EXECUTE $idx$
      CREATE INDEX products_name_unaccent_trgm_idx
      ON cartlify.products
      USING gin (cartlify.immutable_unaccent(name) cartlify.gin_trgm_ops)
    $idx$;
  ELSE
    IF position('USING gin' IN idxdef) = 0 THEN
      RAISE EXCEPTION 'products_name_unaccent_trgm_idx exists but is not GIN: %', idxdef;
    END IF;

    IF position('cartlify.immutable_unaccent' IN idxdef) = 0 THEN
      RAISE EXCEPTION 'index exists but does not use cartlify.immutable_unaccent: %', idxdef;
    END IF;

    IF position('cartlify.gin_trgm_ops' IN idxdef) = 0 THEN
      RAISE EXCEPTION 'index exists but does not use cartlify.gin_trgm_ops: %', idxdef;
    END IF;
  END IF;
END
$do$;

COMMIT;