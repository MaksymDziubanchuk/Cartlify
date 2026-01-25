-- Extensions (ensure they exist)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Put extension objects into cartlify schema (so Prisma schema=cartlify sees them)
ALTER EXTENSION pg_trgm
SET SCHEMA cartlify;

ALTER EXTENSION unaccent
SET SCHEMA cartlify;

-- Immutable wrapper for index expression
CREATE OR REPLACE FUNCTION cartlify.immutable_unaccent (text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT cartlify.unaccent($1)
$$;

-- GIN trigram index for accent-insensitive search
CREATE INDEX IF NOT EXISTS products_name_unaccent_trgm_idx ON cartlify.products USING gin (
    cartlify.immutable_unaccent (name) cartlify.gin_trgm_ops
);