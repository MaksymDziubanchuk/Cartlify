#!/usr/bin/env bash

set -euo pipefail

: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is not set}"

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <csv_path> <table_name>"
  exit 1
fi

CSV_PATH="$1"
TABLE_NAME="$2"
SCHEMA_NAME="cartlify"

if [[ ! -f "$CSV_PATH" ]]; then
  echo "CSV file not found: $CSV_PATH"
  exit 1
fi

if [[ ! "$TABLE_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "Invalid table name: $TABLE_NAME"
  exit 1
fi

CSV_PATH_ESCAPED="${CSV_PATH//\'/\'\'}"

# removes Prisma-only schema parameter because psql does not support it
PSQL_DATABASE_URL="$(
  printf '%s' "$MIGRATION_DATABASE_URL" |
    sed -E \
      -e 's/([?&])schema=[^&]*&/\1/' \
      -e 's/([?&])schema=[^&]*$//' \
      -e 's/\?&/?/' \
      -e 's/\?$//'
)"

RLS_STATE="$(
  psql \
    --dbname="$PSQL_DATABASE_URL" \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --command="
      SELECT
        c.relrowsecurity,
        c.relforcerowsecurity
      FROM pg_class AS c
      JOIN pg_namespace AS n
        ON n.oid = c.relnamespace
      WHERE n.nspname = '${SCHEMA_NAME}'
        AND c.relname = '${TABLE_NAME}'
        AND c.relkind = 'r';
    "
)"

if [[ -z "$RLS_STATE" ]]; then
  echo "Table not found: ${SCHEMA_NAME}.${TABLE_NAME}"
  exit 1
fi

read -r RLS_ENABLED RLS_FORCED <<< "$RLS_STATE"

RLS_RESTORE_COMMAND="DISABLE ROW LEVEL SECURITY"
FORCE_RESTORE_COMMAND="NO FORCE ROW LEVEL SECURITY"

if [[ "$RLS_ENABLED" == "t" ]]; then
  RLS_RESTORE_COMMAND="ENABLE ROW LEVEL SECURITY"
fi

if [[ "$RLS_FORCED" == "t" ]]; then
  FORCE_RESTORE_COMMAND="FORCE ROW LEVEL SECURITY"
fi

psql \
  --set=ON_ERROR_STOP=1 \
  --dbname="$PSQL_DATABASE_URL" <<SQL
BEGIN;

ALTER TABLE "${SCHEMA_NAME}"."${TABLE_NAME}"
  DISABLE ROW LEVEL SECURITY;

\copy "${SCHEMA_NAME}"."${TABLE_NAME}" FROM '${CSV_PATH_ESCAPED}' WITH (FORMAT csv, HEADER true)

DO \$\$
DECLARE
  sequence_name text;
  max_id bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${SCHEMA_NAME}'
      AND table_name = '${TABLE_NAME}'
      AND column_name = 'id'
  ) THEN
    sequence_name := pg_get_serial_sequence(
      format('%I.%I', '${SCHEMA_NAME}', '${TABLE_NAME}'),
      'id'
    );

    IF sequence_name IS NOT NULL THEN
      EXECUTE format(
        'SELECT MAX(%I) FROM %I.%I',
        'id',
        '${SCHEMA_NAME}',
        '${TABLE_NAME}'
      )
      INTO max_id;

      IF max_id IS NOT NULL THEN
        PERFORM setval(sequence_name::regclass, max_id, true);
      END IF;
    END IF;
  END IF;
END
\$\$;

ALTER TABLE "${SCHEMA_NAME}"."${TABLE_NAME}"
  ${FORCE_RESTORE_COMMAND};

ALTER TABLE "${SCHEMA_NAME}"."${TABLE_NAME}"
  ${RLS_RESTORE_COMMAND};

COMMIT;
SQL

echo "CSV imported into ${SCHEMA_NAME}.${TABLE_NAME}"

# Usage: MIGRATION_DATABASE_URL="postgresql://..." bash db/import_csv.sh <path/to/file.csv> <table_name>