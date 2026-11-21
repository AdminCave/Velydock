#!/usr/bin/env bash
# Velydock backup: dumps both databases (Velydock and Keycloak) and saves the configuration.
#
#   ./scripts/backup.sh [target-directory]        default: backups/ in this checkout
#
# A relative target directory is taken from the directory you call the script from.
# The result is one directory per run. It contains every secret of the installation – store it
# encrypted and away from this server. A run that fails leaves no directory behind and ends with
# an exit status other than 0.
set -euo pipefail

# Resolved before changing into the checkout, so "../offsite" means what the caller sees.
target_root=${1:-}
[[ -z $target_root || $target_root == /* ]] || target_root=${PWD%/}/$target_root

cd "$(dirname "$0")/.."
compose=(docker compose)
[[ -n ${VELYDOCK_COMPOSE_ARGS:-} ]] && read -r -a extra <<<"$VELYDOCK_COMPOSE_ARGS" && compose+=("${extra[@]}")

target_root=${target_root:-$PWD/backups}
target=$target_root/velydock-$(date -u +%Y%m%dT%H%M%SZ)
# Everything is written under another name first and renamed at the very end: whatever is called
# velydock-<time stamp> is a complete backup, also after a run that broke off half-way.
partial=$target.partial
if [[ -e $target || -e $partial ]]; then
  echo "error: $target already exists (a second backup within the same second?)." >&2
  exit 1
fi

umask 077
mkdir -p "$partial"
cleanup() {
  local status=$?
  if [[ -d $partial ]]; then
    rm -rf -- "$partial"
    echo "error: the backup failed; no backup was written to $target_root." >&2
  fi
  exit "$status"
}
trap cleanup EXIT

for database in velydock keycloak; do
  echo "dumping database $database …"
  # Custom format: compressed, restorable with pg_restore. Ownership is part of the dump: the
  # tables must belong to the application role again after a restore.
  "${compose[@]}" exec -T postgres pg_dump -U postgres --format=custom "$database" > "$partial/$database.dump"
done

env_file=${VELYDOCK_ENV_FILE:-.env}
if [[ -f $env_file ]]; then
  cp "$env_file" "$partial/env"
else
  echo "warning: $env_file not found; configuration not saved." >&2
fi

( cd "$partial" && sha256sum -- * > SHA256SUMS )
mv -- "$partial" "$target"
echo "backup written to $target"
