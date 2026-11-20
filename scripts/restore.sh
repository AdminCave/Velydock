#!/usr/bin/env bash
# Velydock restore: replaces both databases with the content of a backup made by backup.sh.
#
#   ./scripts/restore.sh backups/velydock-20260101T000000Z
#
# Everything currently stored is overwritten. The .env of the backup is NOT restored
# automatically: copy <backup>/env to .env first if you rebuild a server (the databases only
# work together with the secrets they were created with).
set -euo pipefail

cd "$(dirname "$0")/.."
compose=(docker compose)
[[ -n ${VELYDOCK_COMPOSE_ARGS:-} ]] && read -r -a extra <<<"$VELYDOCK_COMPOSE_ARGS" && compose+=("${extra[@]}")

source_dir=${1:?usage: $0 <backup-directory>}
for file in velydock.dump keycloak.dump SHA256SUMS; do
  [[ -f $source_dir/$file ]] || { echo "error: $source_dir/$file is missing." >&2; exit 1; }
done
( cd "$source_dir" && sha256sum --check --quiet SHA256SUMS ) || { echo "error: backup is damaged." >&2; exit 1; }

if [[ ${VELYDOCK_RESTORE_CONFIRM:-} != yes ]]; then
  read -r -p "This overwrites all current Velydock and Keycloak data. Type 'restore' to continue: " answer
  [[ $answer == restore ]] || { echo "aborted."; exit 1; }
fi

echo "stopping Velydock and Keycloak …"
"${compose[@]}" stop velydock keycloak
"${compose[@]}" up -d --wait postgres

for database in velydock keycloak; do
  echo "restoring database $database …"
  "${compose[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 --quiet -d postgres \
    -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" \
    -c "CREATE DATABASE $database OWNER $database" \
    -c "REVOKE ALL ON DATABASE $database FROM PUBLIC"
  "${compose[@]}" exec -T postgres pg_restore -U postgres --no-owner --role="$database" --exit-on-error \
    -d "$database" < "$source_dir/$database.dump"
done

echo "starting Velydock and Keycloak …"
"${compose[@]}" up -d
echo "restore finished. Sessions from before the backup are gone; users sign in again."
