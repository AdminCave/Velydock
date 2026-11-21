#!/usr/bin/env bash
# Velydock restore: replaces both databases with the content of a backup made by backup.sh.
#
#   ./scripts/restore.sh backups/velydock-20260101T000000Z
#
# A relative path is taken from the directory you call the script from.
# Everything currently stored is overwritten. The .env of the backup is NOT restored
# automatically: copy <backup>/env to .env first if you rebuild a server (the databases only
# work together with the secrets they were created with).
#
# Nothing is stopped or dropped before the backup has proven usable: the checksums must match and
# PostgreSQL must be able to read both dumps to their end. The script asks before it starts;
# where nobody can answer (cron, no terminal) set VELYDOCK_RESTORE_CONFIRM=yes instead.
set -euo pipefail

if [[ $# -ne 1 || -z $1 ]]; then
  echo "usage: $0 <backup-directory>" >&2
  exit 2
fi
# Resolved before changing into the checkout, so a relative path means what the caller sees.
source_dir=$1
[[ $source_dir == /* ]] || source_dir=${PWD%/}/$source_dir

cd "$(dirname "$0")/.."
compose=(docker compose)
[[ -n ${VELYDOCK_COMPOSE_ARGS:-} ]] && read -r -a extra <<<"$VELYDOCK_COMPOSE_ARGS" && compose+=("${extra[@]}")

for file in velydock.dump keycloak.dump SHA256SUMS; do
  [[ -f $source_dir/$file ]] || { echo "error: $source_dir/$file is missing." >&2; exit 1; }
done
( cd "$source_dir" && sha256sum --check --quiet SHA256SUMS ) || { echo "error: backup is damaged." >&2; exit 1; }

if [[ ${VELYDOCK_RESTORE_CONFIRM:-} != yes ]]; then
  if ! read -r -p "This overwrites all current Velydock and Keycloak data. Type 'restore' to continue: " answer; then
    echo >&2
    echo "error: no answer could be read (no terminal?). Nothing was changed." >&2
    echo "To restore without being asked, set VELYDOCK_RESTORE_CONFIRM=yes." >&2
    exit 1
  fi
  [[ $answer == restore ]] || { echo "aborted."; exit 1; }
fi

# The checksums prove that these are the files backup.sh wrote, not that they are complete dumps.
# PostgreSQL reads both to their end while everything is still running: the step after this one
# drops the databases.
"${compose[@]}" up -d --wait postgres
for database in velydock keycloak; do
  echo "checking $database.dump …"
  if ! "${compose[@]}" exec -T postgres pg_restore --file=/dev/null < "$source_dir/$database.dump"; then
    echo "error: PostgreSQL cannot read $database.dump (see its message above). Nothing was changed." >&2
    exit 1
  fi
done

echo "stopping Velydock and Keycloak …"
"${compose[@]}" stop velydock keycloak

# From here on the databases are being replaced. Should a step fail they are left half restored –
# and started like that, Keycloak would set up an empty realm in which nobody can sign in.
unfinished=1
warn_unfinished() {
  if [[ $unfinished == 1 ]]; then
    echo >&2
    echo "error: the restore did not finish; the databases are incomplete." >&2
    echo "Do not start the stack now (no 'docker compose up -d'). Run this script again, with this" >&2
    echo "or another intact backup, until it reports 'restore finished'." >&2
  fi
}
trap warn_unfinished EXIT

for database in velydock keycloak; do
  echo "restoring database $database …"
  "${compose[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 --quiet -d postgres \
    -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" \
    -c "CREATE DATABASE $database OWNER $database" \
    -c "REVOKE ALL ON DATABASE $database FROM PUBLIC"
  # Restored as superuser: row-level security would otherwise reject the rows being loaded.
  "${compose[@]}" exec -T postgres pg_restore -U postgres --exit-on-error -d "$database" < "$source_dir/$database.dump"
done
unfinished=0

echo "starting Velydock and Keycloak …"
"${compose[@]}" up -d
echo "restore finished. Sessions are as they were when the backup was made; whoever signed in later signs in again."
