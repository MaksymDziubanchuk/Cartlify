#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"

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

psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  --command="\copy \"${SCHEMA_NAME}\".\"${TABLE_NAME}\" FROM '${CSV_PATH_ESCAPED}' WITH (FORMAT csv, HEADER true)"

echo "CSV imported into ${SCHEMA_NAME}.${TABLE_NAME}"