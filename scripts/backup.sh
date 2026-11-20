#!/usr/bin/env bash
# Velydock backup: dumps both databases (Velydock and Keycloak) and saves the configuration.
#
#   ./scripts/backup.sh [target-directory]        default: ./backups
#
# The result is one directory per run. It contains every secret of the installation – store it
# encrypted and away from this server.
set -euo pipefail

cd "$(dirname "$0")/.."
compose=(docker compose)
[[ -n ${VELYDOCK_COMPOSE_ARGS:-} ]] && read -r -a extra <<<"$VELYDOCK_COMPOSE_ARGS" && compose+=("${extra[@]}")

target=${1:-backups}/velydock-$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$target"

for database in velydock keycloak; do
  echo "dumping database $database …"
  # Custom format: compressed, restorable with pg_restore. Ownership is part of the dump: the
  # tables must belong to the application role again after a restore.
  "${compose[@]}" exec -T postgres pg_dump -U postgres --format=custom "$database" > "$target/$database.dump"
done

env_file=${VELYDOCK_ENV_FILE:-.env}
if [[ -f $env_file ]]; then
  cp "$env_file" "$target/env"
else
  echo "warning: $env_file not found; configuration not saved." >&2
fi

( cd "$target" && sha256sum -- * > SHA256SUMS )
echo "backup written to $target"
