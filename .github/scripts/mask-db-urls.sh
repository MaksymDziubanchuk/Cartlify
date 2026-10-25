#!/usr/bin/env bash
# The repo is public and so are its logs. psql and prisma print parts of a database address
# (prisma: 'PostgreSQL database "<name>", schema "cartlify" at "<host>:<port>"'), and github
# hides only whole secrets. This masks every part of every address in DB_URLS (separated by
# spaces): user, password, host, port, database name, and the addresses the host resolves to,
# which connection errors may quote. Run it before any step that connects.
set -u

mask() {
  if [ -n "$1" ]; then echo "::add-mask::$1"; fi
}

# a user or password with special characters is percent-encoded in the address, tools print
# it decoded
decoded() {
  printf '%b' "${1//%/\\x}"
}

for url in ${DB_URLS:-}; do
  rest="${url#*://}"

  creds=""
  case "$rest" in
    *@*) creds="${rest%%@*}"; rest="${rest#*@}" ;;
  esac
  user="${creds%%:*}"
  password=""
  case "$creds" in
    *:*) password="${creds#*:}" ;;
  esac

  hostport="${rest%%[/?]*}"
  host="${hostport%%:*}"
  port=""
  case "$hostport" in
    *:*) port="${hostport#*:}" ;;
  esac

  path="${rest#"$hostport"}"
  database="${path#/}"
  database="${database%%\?*}"

  for part in "$user" "$(decoded "$user")" "$password" "$(decoded "$password")" \
    "$host" "$port" "$database" "$(decoded "$database")"; do
    mask "$part"
  done

  if [ -n "$host" ]; then
    for ip in $(getent ahosts "$host" 2>/dev/null | awk '{ print $1 }' | sort -u); do
      mask "$ip"
    done
  fi
done
