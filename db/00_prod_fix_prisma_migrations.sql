-- Run on PROD as postgres/superuser (one-time).
-- Goal: make Prisma migrate deploy work with owner user.
BEGIN;

SET
    LOCAL lock_timeout = '10s';

SET
    LOCAL statement_timeout = '60s';

-- 1) schema access
GRANT USAGE,
CREATE ON SCHEMA cartlify TO cartlify_owner;

-- 2) ensure owner can read/write prisma table
GRANT
SELECT
,
    INSERT,
UPDATE,
DELETE ON TABLE cartlify._prisma_migrations TO cartlify_owner;

-- 3) if the table is owned by postgres, better transfer ownership (Prisma is happier)
ALTER TABLE cartlify._prisma_migrations OWNER TO cartlify_owner;

COMMIT;