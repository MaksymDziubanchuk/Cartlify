set -euo pipefail

: "${PROD_URL:?Need PROD_URL}"
: "${DEV_URL:?Need DEV_URL}"

STAMP="$(date +%Y%m%d_%H%M%S)"
DUMP="db/restore/prod_${STAMP}.dump"

mkdir -p db/restore

# 1) dump prod
pg_dump --format=custom --no-owner --no-privileges --dbname="$PROD_URL" -f "$DUMP"

# 2) restore into dev (full overwrite)
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DEV_URL" "$DUMP"

# 3) re-apply dev grants/policies
psql "$DEV_URL" -v ON_ERROR_STOP=1 -f db/01_roles_and_schemas.sql
psql "$DEV_URL" -v ON_ERROR_STOP=1 -f db/04_policies_and_rls.sql

echo "OK: restored $DUMP into DEV"

# PROD_URL="..." DEV_URL="..." bash src/db/restore/dev_restore_from_prod.sh