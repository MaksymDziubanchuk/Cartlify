#!/usr/bin/env bash
# Runs one sql script on the database of DATABASE_URL. The scripts of db/schema wait at most 5 s
# for a lock (lock_timeout) so that a busy table does not queue every request of the app behind
# them; a script stopped that way rolls back (03, 04 and 05 are one transaction, 06 is written
# to run again), and it runs again after a pause, up to 3 times. Any other failure stops at once.
# A connection error of psql quotes the host: the workflow masks every part of the address first
# (mask-db-urls.sh). The url goes last so psql reads every option before it
set -uo pipefail

script="$1"
attempts=3
pause="${SQL_RETRY_PAUSE_SECONDS:-20}"
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT

for attempt in $(seq 1 "$attempts"); do
  if psql -v ON_ERROR_STOP=1 -f "$script" "$DATABASE_URL" 2> "$errors"; then
    cat "$errors" >&2
    exit 0
  fi

  cat "$errors" >&2

  if ! grep -q 'lock timeout' "$errors"; then
    exit 1
  fi

  if [ "$attempt" -lt "$attempts" ]; then
    echo "a table was busy, the script runs again in ${pause} s (attempt $attempt of $attempts)"
    sleep "$pause"
  fi
done

echo "the tables stayed busy for $attempts attempts, the script did not run"
exit 1
