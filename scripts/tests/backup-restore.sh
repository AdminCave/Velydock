#!/usr/bin/env bash
# Backup and restore round trip against the running development stack:
# back up, destroy data in both databases, restore, and compare with the state before.
#
#   ./scripts/dev-stack.sh up -d --build --wait      (and some data, e.g. after the browser tests)
#   ./scripts/tests/backup-restore.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

export VELYDOCK_COMPOSE_ARGS="-p velydock-dev --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml"
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
echo "before:"; echo "$before" | sed 's/^/  /'
if ! grep -q 'velydock [1-9]' <<<"$before"; then
  echo "error: the stack holds no data to test with (create an administrator first)." >&2
  exit 1
fi

./scripts/backup.sh "$work" >/dev/null
backup=$(find "$work" -mindepth 1 -maxdepth 1 -type d)
for file in velydock.dump keycloak.dump env SHA256SUMS; do
  [[ -s $backup/$file ]] || { echo "error: backup lacks $file" >&2; exit 1; }
done
echo "backup: $(du -sh "$backup" | cut -f1) in $(ls "$backup" | tr '\n' ' ')"

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

./scripts/restore.sh "$backup"
"${stack[@]}" up -d --wait >/dev/null

after=$(fingerprint)
echo "after restore:"; echo "$after" | sed 's/^/  /'
if [[ $after != "$before" ]]; then
  echo "FAILED: data after the restore differs from the data before the backup." >&2
  exit 1
fi

# The application works again with the restored databases (it signs in to Keycloak at start).
"${stack[@]}" exec -T velydock python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=5).read().decode())"
echo "OK: backup and restore round trip succeeded."
