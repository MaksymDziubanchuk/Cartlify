-- One-time script: transfer ownership of all objects in schema cartlify to cartlify_owner
-- Run as postgres/superuser (or as the current owner of those objects).
BEGIN;

SET
    LOCAL lock_timeout = '10s';

SET
    LOCAL statement_timeout = '5min';

-- 1) Ensure schema exists and is owned by cartlify_owner
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cartlify'
  ) THEN
    EXECUTE 'CREATE SCHEMA cartlify AUTHORIZATION cartlify_owner';
  ELSE
    EXECUTE 'ALTER SCHEMA cartlify OWNER TO cartlify_owner';
  END IF;
END
$do$;

-- 2) Transfer ownership of objects inside schema cartlify
DO $do$
DECLARE
  r record;
BEGIN
  -- Tables (incl. _prisma_migrations), partitioned tables, foreign tables
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS obj_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'cartlify'
      AND c.relkind IN ('r','p','f')  -- r=table, p=partitioned table, f=foreign table
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.schema_name, r.obj_name, 'cartlify_owner');
  END LOOP;

  -- Sequences
  FOR r IN
    SELECT sequence_schema AS schema_name, sequence_name AS obj_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'cartlify'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.schema_name, r.obj_name, 'cartlify_owner');
  END LOOP;

  -- Views + materialized views
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS obj_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'cartlify'
      AND c.relkind IN ('v','m')  -- v=view, m=matview
  LOOP
    IF r.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.schema_name, r.obj_name, 'cartlify_owner');
    ELSE
      EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', r.schema_name, r.obj_name, 'cartlify_owner');
    END IF;
  END LOOP;

  -- Functions
  FOR r IN
    SELECT n.nspname AS schema_name,
           p.proname AS obj_name,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'cartlify'
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',
      r.schema_name, r.obj_name, r.args, 'cartlify_owner'
    );
  END LOOP;

  -- Types (enums, composites)
  FOR r IN
    SELECT n.nspname AS schema_name, t.typname AS obj_name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'cartlify'
      AND t.typtype = 'e'  -- e=enum only
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.schema_name, r.obj_name, 'cartlify_owner');
  END LOOP;
END
$do$;

COMMIT;