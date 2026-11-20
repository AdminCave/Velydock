#!/usr/bin/env bash
# Installation smoke test: follows docs/installation.md with the production Compose file.
#
#   scripts/install.sh  →  docker compose up -d  →  velydock setup-admin  →  first sign-in
#
# Runs as its own Compose project ("velydock-install") on local ports and removes it afterwards.
# Uses the image velydock:dev (build it first: ./scripts/dev-stack.sh build).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
port=${INSTALL_HTTPS_PORT:-9443}
project=velydock-install

work=$(mktemp -d)
compose=(docker compose -p "$project" --project-directory "$work")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

# Only what an operator gets: the Compose file, the deploy configuration and the scripts.
cp "$repo/docker-compose.yml" "$work/"
cp -r "$repo/deploy" "$repo/scripts" "$work/"
cd "$work"

./scripts/install.sh dock.install.localhost auth.install.localhost sandbox.install.localhost admin@example.com >/dev/null
[[ $(stat -c %a .env) == 600 ]] || { echo "error: .env is readable by others" >&2; exit 1; }
if grep -Eq '^[A-Z_]*(PASSWORD|SECRET|KEY)=$' .env; then echo "error: install.sh left a secret empty" >&2; exit 1; fi
# Refuses to overwrite an existing configuration.
if ./scripts/install.sh a.example b.example c.example >/dev/null 2>&1; then
  echo "error: install.sh overwrote an existing .env" >&2; exit 1
fi

# Local stand-ins for DNS, public ports and Let's Encrypt.
cat >> .env <<ENV
VELYDOCK_IMAGE=velydock:dev
TLS_RESOLVER=
HTTP_BIND=127.0.0.1:$((port - 363))
HTTPS_BIND=127.0.0.1:$port
PUBLIC_PORT_SUFFIX=:$port
ENV
sed -i 's|^VELYDOCK_IMAGE=ghcr.io.*$||' .env

echo "starting the stack as installed …"
"${compose[@]}" up -d --wait >/dev/null
"${compose[@]}" ps --format '  {{.Service}}: {{.State}} {{.Health}}'

output=$("${compose[@]}" exec -T velydock velydock setup-admin --username admin --email admin@example.com)
password=$(sed -nE 's/.*One-time password:\s+(\S+).*/\1/p' <<<"$output")
[[ -n $password ]] || { echo "error: setup-admin printed no one-time password" >&2; echo "$output" >&2; exit 1; }

# No database port and no Keycloak port is published in a production installation.
published=$("${compose[@]}" ps --format '{{.Service}} {{.Ports}}' | grep -E '^(postgres|keycloak|velydock) .*->' || true)
[[ -z $published ]] || { echo "error: internal services publish ports: $published" >&2; exit 1; }

cd "$repo/e2e"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
INSTALL_URL="https://dock.install.localhost:$port" INSTALL_ONE_TIME_PASSWORD="$password" \
  npx playwright test --config playwright.install.config.ts
echo "OK: installation as documented works."
