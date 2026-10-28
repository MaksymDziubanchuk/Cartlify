-- The extensions and the name search of products.
-- It makes sure that:
--  - pg_trgm and unaccent exist and live in the schema cartlify
--  - cartlify.immutable_unaccent(text) exists and is IMMUTABLE and STRICT
--  - the index products_name_unaccent_trgm_idx exists
--  - the roles may run the unaccent functions (the trigram ones are granted in 01)
-- Run it as a superuser (it installs extensions), after the prisma migrations. It can be run
-- again: what is right is left alone. An extension in another schema is moved; a function or an
-- index that exists in another shape is not changed, the script stops with an error instead.
BEGIN;

-- give up instead of waiting: 5 s for a lock, 60 s for a statement
SET
  LOCAL lock_timeout = '5s';

SET
  LOCAL statement_timeout = '60s';

-- the schema is made by 01; this line only keeps the statements below from failing without it
-- (the roles of 01 must exist too: the grants below name them)
CREATE SCHEMA IF NOT EXISTS cartlify;

-- 1) Extensions: create them in cartlify, or move them there if they are installed elsewhere
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

-- 2) Function immutable_unaccent: unaccent that an index may use (unaccent itself is only
-- STABLE). Created only when it is missing. If it exists but is not IMMUTABLE, not STRICT or does
-- not call cartlify.unaccent, the script stops with an error: a difference is never hidden.
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

-- 2a) Function owner: the script runs as a superuser, so the function is handed to cartlify_owner,
-- like the other objects of the shop.
ALTER FUNCTION cartlify.immutable_unaccent (text) OWNER TO cartlify_owner;

-- 3) Index products_name_unaccent_trgm_idx: a GIN trigram index on the product name without
-- accents, for the search of products by name. Created when it is missing. An existing one is
-- only checked (GIN, uses immutable_unaccent and gin_trgm_ops); a different one stops the script.
-- Without the products table the index is skipped with a notice.
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

-- 4) Execute rights on the unaccent functions (the trigram ones are granted in 01). Script 01 takes the public right from every function
-- of the schema, so each role gets its own grant.
GRANT
EXECUTE ON FUNCTION cartlify.unaccent (text) TO cartlify_app;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (regdictionary, text) TO cartlify_app;

GRANT
EXECUTE ON FUNCTION cartlify.immutable_unaccent (text) TO cartlify_app;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (text) TO cartlify_readonly;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (regdictionary, text) TO cartlify_readonly;

GRANT
EXECUTE ON FUNCTION cartlify.immutable_unaccent (text) TO cartlify_readonly;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (text) TO cartlify_owner;

GRANT
EXECUTE ON FUNCTION cartlify.unaccent (regdictionary, text) TO cartlify_owner;

GRANT
EXECUTE ON FUNCTION cartlify.immutable_unaccent (text) TO cartlify_owner;

COMMIT;