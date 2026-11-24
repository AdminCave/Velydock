#!/usr/bin/env bash
# TLS as an installation has it, checked at the real proxy:
#
#   1. certificates the proxy fetches by itself (ACME over HTTP, as with Let's Encrypt - here
#      from Pebble, Let's Encrypt's test server, so that nothing leaves this machine), for the
#      names Velydock asks it to fetch one for,
#   2. own certificates stored with `velydock cert add`: served for a name the proxy holds no
#      certificate for, and never fetched one for afterwards,
#   3. a name the proxy has fetched a certificate for before: the fetched one stays until it is
#      taken out of the proxy's store (`velydock cert prune-fetched`), then the own one is
#      served, also after restarts, and nothing is fetched for that name again,
#   4. removing an own certificate: the proxy fetches one again.
#
#   ./scripts/tests/tls-modes.sh
#
# Runs as its own Compose project ("velydock-tls") on loopback ports and removes it afterwards.
# Uses the image velydock:dev (build it first: ./scripts/dev-stack.sh build), or the one named by
# VELYDOCK_DEV_IMAGE. Needs openssl.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
port=${TLS_TEST_HTTPS_PORT:-9643}
project=velydock-tls
image=${VELYDOCK_DEV_IMAGE:-velydock:dev}
pebble=$(sed -nE 's/^ *image: (ghcr\.io\/letsencrypt\/pebble@sha256:[0-9a-f]+)$/\1/p' "$repo/scripts/tests/tls-modes.compose.yml")
[[ -n $pebble ]] || { echo "error: no Pebble image in tls-modes.compose.yml" >&2; exit 1; }

work=$(mktemp -d)
# Nothing of the caller's environment reaches Compose (see install-smoke.sh).
clean=(env -i "PATH=$PATH" "HOME=$HOME")
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR; do
  [[ -z ${!name:-} ]] || clean+=("$name=${!name}")
done
compose=("${clean[@]}" docker compose -p "$project" --project-directory "$work"
  -f "$work/docker-compose.yml" -f "$work/tls-modes.compose.yml")
cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- proxy log ---" >&2
    "${compose[@]}" logs --tail 40 traefik >&2 2>/dev/null || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

cp "$repo/docker-compose.yml" "$repo/scripts/tests/tls-modes.compose.yml" "$work/"
cp -r "$repo/deploy" "$work/"
# Other tools write their own routes next to ours in a working tree; an installation has none.
find "$work/deploy/traefik/dynamic" -type f ! -name velydock.yml -delete
chmod -R a+rX "$work"

# Pebble: its test root (the proxy must trust the authority's own address) and a configuration
# that validates names on the ports an installation really listens on.
mkdir "$work/pebble"
container=$("${clean[@]}" docker create "$pebble")
"${clean[@]}" docker cp "$container:/test/certs/pebble.minica.pem" "$work/pebble/pebble.minica.pem"
"${clean[@]}" docker cp "$container:/test/config/pebble-config.json" "$work/pebble/default.json"
"${clean[@]}" docker rm "$container" >/dev/null
sed -E 's/"httpPort": *[0-9]+/"httpPort": 80/; s/"tlsPort": *[0-9]+/"tlsPort": 443/' \
  "$work/pebble/default.json" > "$work/pebble/pebble-config.json"
grep -q '"httpPort": 80' "$work/pebble/pebble-config.json" || { echo "error: Pebble's configuration has changed its form" >&2; exit 1; }
chmod -R a+rX "$work/pebble"

secret() { openssl rand -hex 24; }
cat > "$work/.env" <<ENV
VELYDOCK_HOST=dock.tls.test
KEYCLOAK_HOST=auth.tls.test
SANDBOX_HOST=sandbox.tls.test
APPS_HOST=apps.tls.test
ACME_EMAIL=admin@example.com
ACME_CA_SERVER=https://pebble:14000/dir
COMPOSE_PROFILES=proxy
VELYDOCK_IMAGE=$image
HTTP_BIND=127.0.0.1:$((port + 37))
HTTPS_BIND=127.0.0.1:$port
TLS_TEST_DIR=$work
POSTGRES_PASSWORD=$(secret)
VELYDOCK_DB_PASSWORD=$(secret)
KEYCLOAK_DB_PASSWORD=$(secret)
VELYDOCK_SECRET_KEY=$(secret)
VELYDOCK_OIDC_CLIENT_SECRET=$(secret)
VELYDOCK_IDP_ADMIN_CLIENT_SECRET=$(secret)
KEYCLOAK_BOOTSTRAP_SECRET=$(secret)
VELYDOCK_PROXY_SECRET=$(secret)
ENV

# Own certificates: a root of our own, and one certificate per name signed by it. The common
# name is chosen so that the proxy's order of certificates puts the one it fetched itself first
# (it sorts them by their names, see backend/velydock/services/certificates.py): the case in
# which an administrator has to take the fetched one out.
own="$work/own"
mkdir "$own"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=Velydock Test Root" -keyout "$own/root.key" -out "$own/root.crt" 2>/dev/null
issue() { # <file name> <subject alternative names>
  openssl req -newkey rsa:2048 -nodes -subj "/CN=A test certificate for $1" -keyout "$own/$1.key" -out "$own/$1.csr" 2>/dev/null
  openssl x509 -req -in "$own/$1.csr" -CA "$own/root.crt" -CAkey "$own/root.key" -CAcreateserial -days 20 \
    -extfile <(printf 'subjectAltName=%s\n' "$2") -out "$own/$1.crt" 2>/dev/null
}
issue auth "DNS:auth.tls.test"
issue apps "DNS:apps.tls.test,DNS:*.apps.tls.test"

# Who issued the certificate a browser gets for a name (empty while the proxy does not answer).
issuer_of() {
  echo | openssl s_client -connect "127.0.0.1:$port" -servername "$1" 2>/dev/null |
    openssl x509 -noout -issuer 2>/dev/null | sed -E 's/^issuer= *//; s/^.*CN *= *//' || true
}
# <name> <pattern the issuer must match> <what is being waited for>
expect_issuer() {
  local found=""
  for _ in $(seq 1 45); do
    found=$(issuer_of "$1")
    # shellcheck disable=SC2053  # the second argument is a pattern on purpose
    if [[ $found == $2 ]]; then
      echo "  $1: $found"
      return 0
    fi
    sleep 1
  done
  echo "error: $3 - $1 is served with a certificate of '${found:-nobody}', expected '$2'" >&2
  return 1
}
cert() { "${compose[@]}" exec -T velydock velydock cert "$@"; }

echo "starting the stack with an ACME authority of its own …"
"${compose[@]}" up -d --wait >/dev/null

fetched() { # how many certificates for a name are in the proxy's own store
  "${compose[@]}" exec -T traefik sh -c "grep -c '\"main\": \"$1\"' /acme/acme.json || true"
}

echo "1. the proxy fetches certificates for the names Velydock asks it to (ACME, checked over HTTP on port 80)"
for name in dock.tls.test auth.tls.test sandbox.tls.test; do
  expect_issuer "$name" "Pebble Intermediate CA*" "no certificate from the ACME authority"
done
# Nothing is published below the apps host, so nothing was asked for there.
expect_issuer apps.tls.test "TRAEFIK DEFAULT CERT" "a name without a route should get the stand-in"

echo "2. own certificates, stored on the command line as the installer does it"
cat "$own/apps.crt" "$own/root.crt" "$own/apps.key" | cert add --name "Apps" >/dev/null
expect_issuer apps.tls.test "Velydock Test Root" "the own certificate is not served"
expect_issuer wiki.apps.tls.test "Velydock Test Root" "the wildcard is not served for a sub-domain"
expect_issuer dock.tls.test "Pebble Intermediate CA*" "an own certificate changed another name"
listed=$(cert list)
grep -q $'^Apps\tapps.tls.test, \\*.apps.tls.test\t' <<<"$listed" || { echo "error: cert list does not show it: $listed" >&2; exit 1; }
# The key is where only the proxy's group reads it.
modes=$("${compose[@]}" exec -T velydock sh -c 'stat -c "%a %U" /certs/*.key | sort -u')
[[ $modes == "640 velydock" ]] || { echo "error: key files are '$modes', expected '640 velydock'" >&2; exit 1; }

echo "3. a name the proxy has fetched a certificate for before"
cat "$own/auth.crt" "$own/root.crt" "$own/auth.key" | cert add --name "Anmeldung" >/dev/null
sleep 12 # two fetches of the configuration
# Two certificates for one name, and the proxy takes the fetched one: this is why …
expect_issuer auth.tls.test "Pebble Intermediate CA*" "expected the fetched certificate to stay in front"
# … the fetched one is taken out of the proxy's store, while the proxy is stopped.
"${compose[@]}" stop traefik >/dev/null 2>&1
pruned=$("${compose[@]}" run --rm --no-deps --user 0:0 -v "${project}_traefik-acme:/acme" velydock \
  cert prune-fetched /acme/acme.json 2>/dev/null)
[[ $pruned == "Removed the fetched certificate for auth.tls.test." ]] || { echo "error: pruning said: $pruned" >&2; exit 1; }
"${compose[@]}" start traefik >/dev/null 2>&1
expect_issuer auth.tls.test "Velydock Test Root" "the own certificate is not served after pruning"
expect_issuer dock.tls.test "Pebble Intermediate CA*" "pruning took a certificate it should have kept"
# It stays that way: with a certificate of its own, the name is not asked for again.
for round in 1 2; do
  "${compose[@]}" restart traefik >/dev/null 2>&1
  expect_issuer auth.tls.test "Velydock Test Root" "after restart $round the own certificate is not served"
done
sleep 8
[[ $(fetched auth.tls.test) == 0 ]] || { echo "error: the proxy fetched a certificate for auth.tls.test again" >&2; exit 1; }
[[ $(fetched dock.tls.test) == 1 ]] || { echo "error: the certificate for dock.tls.test is gone from the proxy's store" >&2; exit 1; }

echo "4. removed again: the proxy fetches a certificate for the name"
cert remove "Anmeldung" >/dev/null
expect_issuer auth.tls.test "Pebble Intermediate CA*" "no certificate was fetched after the own one was removed"
cert remove "Apps" >/dev/null
expect_issuer apps.tls.test "TRAEFIK DEFAULT CERT" "the removed certificate is still served"
left=$("${compose[@]}" exec -T velydock sh -c 'ls /certs | wc -l')
[[ $left == 0 ]] || { echo "error: $left files are left in the proxy's directory" >&2; exit 1; }

echo "OK: fetched and own certificates are served as described."
