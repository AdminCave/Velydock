#!/usr/bin/env bash
# Backup and restore round trip against the running development stack:
# back up, destroy data in both databases, restore, and compare with the state before.
#
#   ./scripts/dev-stack.sh up -d --build --wait      (and some data, e.g. after the browser tests)
#   ./scripts/tests/backup-restore.sh
#
# It destroys and restores the data of the stack it runs against: the development stack, or the
# one named by VELYDOCK_DEV_PROJECT (see dev-stack.sh) - never a real installation.
set -euo pipefail
cd "$(dirname "$0")/../.."

project=${VELYDOCK_DEV_PROJECT:-velydock-dev}
export VELYDOCK_COMPOSE_ARGS="-p $project --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml"
export VELYDOCK_ENV_FILE=.env.dev
export VELYDOCK_RESTORE_CONFIRM=yes
stack=(./scripts/dev-stack.sh)

sql() { "${stack[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -d "$1" -Atc "$2"; }

fingerprint() {
  sql velydock "SELECT 'velydock ' || (SELECT count(*) FROM tenants) || ' tenants, ' || (SELECT count(*) FROM users) || ' users, '
                || (SELECT count(*) FROM apps) || ' apps, ' || (SELECT count(*) FROM audit_log) || ' audit entries, users '
                || coalesce((SELECT md5(string_agg(username || first_name || coalesce(email, ''), ',' ORDER BY username)) FROM users), '-')"
  sql keycloak "SELECT 'keycloak ' || (SELECT count(*) FROM user_entity) || ' users, ' || (SELECT count(*) FROM credential)
                || ' credentials, ' || (SELECT count(*) FROM org) || ' organizations'"
  sql velydock "SELECT 'owner ' || tableowner || ', policies ' || (SELECT count(*) FROM pg_policies) FROM pg_tables WHERE tablename = 'users'"
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

before=$(fingerprint)
echo "before:"; echo "  ${before//$'\n'/$'\n'  }"
if ! grep -q 'velydock [1-9]' <<<"$before"; then
  echo "error: the stack holds no data to test with (create an administrator first)." >&2
  exit 1
fi

./scripts/backup.sh "$work" >/dev/null
backup=$(find "$work" -mindepth 1 -maxdepth 1 -type d)
for file in velydock.dump keycloak.dump env SHA256SUMS; do
  [[ -s $backup/$file ]] || { echo "error: backup lacks $file" >&2; exit 1; }
done
echo "backup: $(du -sh "$backup" | cut -f1) in $(cd "$backup" && echo *)"

echo "destroying data in both databases …"
sql velydock "TRUNCATE apps, groups, memberships, audit_log CASCADE; UPDATE users SET first_name = 'zerstört'" >/dev/null
sql keycloak "DELETE FROM credential" >/dev/null
damaged=$(fingerprint)
[[ $damaged != "$before" ]] || { echo "error: the damage did not change anything" >&2; exit 1; }

# A damaged backup must be refused before anything is touched.
cp -r "$backup" "$work/damaged" && echo corrupt >> "$work/damaged/velydock.dump"
if ./scripts/restore.sh "$work/damaged" >/dev/null 2>&1; then
  echo "error: a corrupted backup was accepted" >&2; exit 1
fi
[[ $(fingerprint) == "$damaged" ]] || { echo "error: a refused restore changed data" >&2; exit 1; }

# So must a dump that is cut off but carries matching checksums: the checksums only prove that
# the files are the ones backup.sh wrote. restore.sh lets PostgreSQL read both dumps to their end
# before it stops or drops anything.
cp -r "$backup" "$work/cut-off"
head -c -2000 "$backup/keycloak.dump" > "$work/cut-off/keycloak.dump"
( cd "$work/cut-off" && sha256sum -- env keycloak.dump velydock.dump > SHA256SUMS )
if ./scripts/restore.sh "$work/cut-off" >/dev/null 2>&1; then
  echo "error: a cut-off dump was accepted" >&2; exit 1
fi
[[ $(fingerprint) == "$damaged" ]] || { echo "error: a refused restore changed data" >&2; exit 1; }
"${stack[@]}" exec -T velydock true || { echo "error: a refused restore stopped Velydock" >&2; exit 1; }

# A backup that fails leaves nothing behind that could be taken for a backup. Here it fails
# because the project it is pointed at has no containers, as if the stack were not running.
if VELYDOCK_COMPOSE_ARGS="${VELYDOCK_COMPOSE_ARGS/-p $project /-p $project-not-running }" \
   ./scripts/backup.sh "$work/failed" >/dev/null 2>&1; then
  echo "error: backup.sh reported success without a running stack" >&2; exit 1
fi
if find "$work/failed" -mindepth 1 2>/dev/null | grep -q .; then
  echo "error: a failed backup left files behind" >&2; exit 1
fi

./scripts/restore.sh "$backup"
"${stack[@]}" up -d --wait >/dev/null

after=$(fingerprint)
echo "after restore:"; echo "  ${after//$'\n'/$'\n'  }"
if [[ $after != "$before" ]]; then
  echo "FAILED: data after the restore differs from the data before the backup." >&2
  exit 1
fi

# The application works again with the restored databases (it signs in to Keycloak at start).
"${stack[@]}" exec -T velydock python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=5).read().decode())"
echo "OK: backup and restore round trip succeeded."
