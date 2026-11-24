#!/usr/bin/env bash
# Installer test: install.sh and the management command "velydock", from a local release.
#
#   docker build -t velydock:dev .          (or name another image with VELYDOCK_DEV_IMAGE)
#   ./scripts/tests/installer.sh
#
# In this order:
#
#   1. options, messages and the checks of an own certificate - nothing is started;
#   2. the management command against a stand-in for docker: what "cert add" sends, that the
#      caller's environment stays away from Compose, which backups "--keep" removes, what
#      "doctor" says about the certificate a TLS server really serves - and what is left when
#      things go wrong: "cert takeover" interrupted, an update whose images cannot be fetched,
#      one that fails or is cut off while it replaces the program files;
#   3. a local release: a registry on a loopback port with two versions of the image, and an
#      HTTP server with install.sh, the bundles and SHA256SUMS (scripts/make-bundle.sh);
#   4. a bundle that does not match its checksum is refused; the questions are answered through
#      a terminal (pty), with wrong answers that are asked again;
#   5. install.sh --yes, the first sign-in in a browser, then status, doctor, backup, update to
#      the second version, the way back to the first by hand with the backup made before the
#      update, the update again, uninstall, and uninstall --purge;
#   6. a "new server": a fresh installation that takes over the backup of the old one, as
#      docs/betrieb.md describes it.
#   7. install.sh --yes --tls own: a fresh installation with an own certificate; every name of
#      the installation is served with it afterwards (TLS handshakes with the proxy).
#
# Without root (the default) everything stays in a temporary directory (--no-system), on
# loopback ports and under a Compose project of its own. Other projects are never touched.
#
# INSTALLER_TEST_MODE=system is for CI (needs sudo and systemd): the installer runs as root with
# its defaults - /opt/velydock, ports 80 and 443, /usr/local/bin/velydock, the backup timer.
# Never use it on a machine that is in use.
#
# Settings (environment), with their defaults:
#   VELYDOCK_DEV_IMAGE             velydock:dev   the image to install
#   INSTALLER_TEST_PROJECT         velydock-itest (must start with "velydock-itest")
#   INSTALLER_TEST_REGISTRY_PORT   9550
#   INSTALLER_TEST_RELEASE_PORT    9551
#   INSTALLER_TEST_HTTPS_PORT      9543   (the questions test uses the port after it)
#   INSTALLER_TEST_HTTP_PORT       9580   (likewise)
#   INSTALLER_TEST_PULL_POLICY     missing: public images are not fetched anew, which on a
#                                  shared machine would move tags other projects run on;
#                                  "always" in system mode
#   INSTALLER_TEST_ONLY=quick      stop after part 2 (no container is started)
#
# The browser step on a machine shared with other Docker users: Chromium drops running requests
# when a network interface of the machine changes (net::ERR_NETWORK_CHANGED), and one changes
# whenever anybody starts or stops a container. If the trace of a failed sign-in shows exactly
# that error, the sign-in is tried again with a further administrator, three times at most.
#
# It removes what it started - containers, volumes, networks, the registry, its images and its
# files - also when it fails.
set -euo pipefail
export LC_ALL=C

repo=$(cd "$(dirname "$0")/../.." && pwd)
mode=${INSTALLER_TEST_MODE:-user}
source_image=${VELYDOCK_DEV_IMAGE:-velydock:dev}
registry_port=${INSTALLER_TEST_REGISTRY_PORT:-9550}
release_port=${INSTALLER_TEST_RELEASE_PORT:-9551}
https_port=${INSTALLER_TEST_HTTPS_PORT:-9543}
http_port=${INSTALLER_TEST_HTTP_PORT:-9580}
registry_name=velydock-itest-registry
registry=127.0.0.1:$registry_port
base_url=http://127.0.0.1:$release_port
first=0.1.0
second=0.1.1
admin=chef
http_pid=""
tls_pid=""
files_pid=""
started=0
passed=""

work=$(mktemp -d)
release=$work/release

case $mode in
  user)
    root=()
    project=${INSTALLER_TEST_PROJECT:-velydock-itest}
    [[ $project == velydock-itest* ]] || { echo "error: INSTALLER_TEST_PROJECT must start with velydock-itest." >&2; exit 2; }
    dir=$work/velydock
    tool=$dir/scripts/velydock
    url=https://dock.itest.localhost:$https_port
    https_endpoint=127.0.0.1:$https_port
    pull_policy=${INSTALLER_TEST_PULL_POLICY:-missing}
    install_options=(--no-system --dir "$dir" --http-bind "127.0.0.1:$http_port"
      --https-bind "127.0.0.1:$https_port" --public-port-suffix ":$https_port" --project-name "$project")
    question_options=(--no-system --dir "$work/questions" --http-bind "127.0.0.1:$((http_port + 1))"
      --https-bind "127.0.0.1:$((https_port + 1))" --public-port-suffix ":$((https_port + 1))"
      --project-name "$project-questions")
    question_url=https://dock.pty.itest.localhost:$((https_port + 1))
    ;;
  system)
    if [[ ${GITHUB_ACTIONS:-} != true && ${INSTALLER_TEST_ALLOW_SYSTEM:-} != yes ]]; then
      echo "error: system mode installs to /opt/velydock as root; it is meant for CI." >&2
      exit 2
    fi
    root=(sudo)
    project=velydock
    dir=/opt/velydock
    tool=/usr/local/bin/velydock
    url=https://dock.itest.localhost
    https_endpoint=127.0.0.1:443
    pull_policy=${INSTALLER_TEST_PULL_POLICY:-always}
    install_options=()
    question_options=()
    question_url=https://dock.pty.itest.localhost
    sudo test ! -e "$dir" || { echo "error: $dir already exists." >&2; exit 2; }
    ;;
  *)
    echo "error: INSTALLER_TEST_MODE must be user or system." >&2
    exit 2
    ;;
esac

# Nothing of the caller's environment reaches the installer - except three values that must
# not have any effect: the configuration of an installation comes from its .env alone.
clean=(env -i "PATH=$PATH" "HOME=$HOME" LC_ALL=C)
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR; do
  [[ -z ${!name:-} ]] || clean+=("$name=${!name}")
done
released=("${clean[@]}" "VELYDOCK_RELEASE_BASE_URL=$base_url" "VELYDOCK_PULL_POLICY=$pull_policy"
  PUBLIC_PORT_SUFFIX=:1 VELYDOCK_HOST=wrong.localhost COMPOSE_PROJECT_NAME=velydock-itest-wrong)

section() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

# expect <status> <pattern> <command ...>: the command ends with that status and says that.
expect() {
  local want=$1 pattern=$2 status=0 output
  shift 2
  output=$("$@" 2>&1 </dev/null) || status=$?
  if [[ $status != "$want" ]]; then
    printf '%s\n' "$output" >&2
    fail "status $status instead of $want: $*"
  fi
  if ! grep -Eq -- "$pattern" <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail "the output lacks '$pattern': $*"
  fi
}

installer() { "${root[@]}" "${released[@]}" bash "$work/install.sh" "$@"; }
velydock() { "${root[@]}" "${released[@]}" "$tool" "$@"; }
as_root() { "${root[@]}" "$@"; }
# The same command where nobody can be asked: without a terminal, also when the test itself
# was started from one.
unattended_velydock() { setsid -w "${root[@]}" "${released[@]}" "$tool" "$@"; }

remove_project() {
  local name=$1 found
  found=$(docker ps -aq --filter "label=com.docker.compose.project=$name")
  # shellcheck disable=SC2086  # a list of IDs
  [[ -z $found ]] || docker rm -f -v $found >/dev/null
  found=$(docker volume ls -q --filter "label=com.docker.compose.project=$name")
  # shellcheck disable=SC2086
  [[ -z $found ]] || docker volume rm $found >/dev/null
  found=$(docker network ls -q --filter "label=com.docker.compose.project=$name")
  # shellcheck disable=SC2086
  [[ -z $found ]] || docker network rm $found >/dev/null
}

test_images() {
  docker images --digests --format '{{.Repository}} {{.Tag}} {{.Digest}}' | while read -r name tag digest; do
    [[ $name == "$registry/velydock" ]] || continue
    if [[ $tag != "<none>" ]]; then printf '%s:%s\n' "$name" "$tag"; fi
    if [[ $digest == sha256:* ]]; then printf '%s@%s\n' "$name" "$digest"; fi
  done | sort -u
}

cleanup() {
  local status=$? reference
  trap - EXIT
  set +e
  if (( status != 0 && started )); then
    echo "--- containers of $project" >&2
    docker ps -a --filter "label=com.docker.compose.project=$project" --format '  {{.Names}}: {{.Status}}' >&2
    echo "--- end of the installer's log" >&2
    as_root tail -n 40 "$dir/install.log" /var/log/velydock-install.log 2>/dev/null >&2
  fi
  [[ -z $http_pid ]] || kill "$http_pid" 2>/dev/null
  [[ -z $tls_pid ]] || kill "$tls_pid" 2>/dev/null
  [[ -z $files_pid ]] || kill "$files_pid" 2>/dev/null
  if (( started )); then
    as_root test -x "$dir/scripts/velydock" && velydock uninstall --purge --yes >/dev/null 2>&1
    remove_project "$project"
    if [[ $mode == system ]]; then
      sudo rm -f /usr/local/bin/velydock /etc/systemd/system/velydock-backup.service /etc/systemd/system/velydock-backup.timer
    fi
  fi
  docker rm -f -v "$registry_name" >/dev/null 2>&1
  while read -r reference; do
    [[ -z $reference ]] || docker rmi "$reference" >/dev/null 2>&1
  done < <(test_images)
  as_root rm -rf -- "$work"
  if (( status == 0 )); then echo "OK: the installer test passed$passed."; fi
  exit "$status"
}
trap cleanup EXIT

# ---- 1. options, messages, certificate checks ------------------------------------------------

section "options and messages"
plain=("${clean[@]}" bash "$repo/install.sh")
never=$work/never
unattended=("${plain[@]}" --lang en --yes --no-system --dir "$never")

expect 2 'Unknown option: --frobnicate' "${plain[@]}" --lang en --frobnicate
expect 2 'Unbekannte Option: --frobnicate' "${plain[@]}" --lang de --frobnicate
expect 2 'Unbekannte Option' env -i "PATH=$PATH" LANG=de_DE.UTF-8 bash "$repo/install.sh" --frobnicate
expect 2 'Unknown option' env -i "PATH=$PATH" LANG=fr_FR.UTF-8 bash "$repo/install.sh" --frobnicate
expect 2 'Option --domain needs a value' "${plain[@]}" --lang en --domain
expect 2 'is not a host name.*--velydock-host' "${plain[@]}" --lang en --velydock-host 'https://dock.example.com'
expect 2 'must be de or en' "${plain[@]}" --lang fr
expect 0 'Ohne Optionen fragt der Installer' "${plain[@]}" --lang de --help
expect 0 'Without options the installer asks' "${plain[@]}" --lang en --help
if (( EUID != 0 )); then
  expect 1 'must run as root' "${plain[@]}" --lang en --yes --domain itest.localhost
fi
expect 2 'every answer must be given: --domain' "${unattended[@]}"
expect 2 'every answer must be given: .*--sandbox-host' "${unattended[@]}" --velydock-host a.itest.localhost --keycloak-host b.itest.localhost
expect 2 'every answer must be given: --acme-email' "${unattended[@]}" --domain itest.localhost
expect 2 'every answer must be given: --admin-email' "${unattended[@]}" --domain itest.localhost --tls selfsigned
expect 2 'every answer must be given: --cert' "${unattended[@]}" --domain itest.localhost --tls own --admin-email a@example.com
for same in "--sandbox-host dock.itest.localhost" "--keycloak-host dock.itest.localhost" "--sandbox-host auth.itest.localhost"; do
  # shellcheck disable=SC2086  # an option and its value
  expect 2 'host names must differ' "${unattended[@]}" --domain itest.localhost $same --tls selfsigned --admin-email a@example.com
done
expect 2 'dock.itest.localhost must not be or lie below the host for published apps \(itest.localhost\)' \
  "${unattended[@]}" --domain itest.localhost --apps-host itest.localhost --tls selfsigned --admin-email a@example.com
expect 2 'cannot be a user name.*--admin-user' "${unattended[@]}" --domain itest.localhost --tls selfsigned --admin-email a@example.com --admin-user 'A B'
# An address that Compose would rewrite in .env is refused.
# shellcheck disable=SC2016  # the dollar sign is meant literally
expect 2 'cannot be used as an e-mail address here.*--acme-email' "${unattended[@]}" --domain itest.localhost --acme-email 'a$b@example.com'
expect 2 'Give a number from 1 to 999.*--backup-keep' "${unattended[@]}" --domain itest.localhost --tls selfsigned --admin-email a@example.com --backup-keep 0
expect 2 'cannot be the directory.*--dir' "${plain[@]}" --lang en --yes --no-system --dir 'relative/path' --domain itest.localhost
mkdir "$work/occupied" && touch "$work/occupied/something"
expect 1 'is not empty and holds no Velydock installation' "${plain[@]}" --lang en --yes --no-system --dir "$work/occupied" \
  --domain itest.localhost --tls selfsigned --admin-email a@example.com
[[ ! -e $never ]] || fail "a refused run created $never"

section "own certificate: what the installer checks before anything is started"
certs=$work/certs
mkdir "$certs"
# make_cert <name> <days> <subjectAltName or ""> - a self-signed certificate and its key
make_cert() {
  local name=$1 days=$2 names=$3 extension=()
  [[ -z $names ]] || extension=(-addext "subjectAltName=$names")
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days "$days" -subj "/CN=$name" \
    "${extension[@]}" -keyout "$certs/$name.key" -out "$certs/$name.pem" 2>/dev/null
}
make_cert wildcard 30 'DNS:*.itest.localhost'
make_cert named 30 'DNS:dock.itest.localhost,DNS:auth.itest.localhost,DNS:sandbox.itest.localhost'
make_cert two 30 'DNS:dock.itest.localhost,DNS:auth.itest.localhost'
make_cert deep 30 'DNS:*.pty.itest.localhost'
make_cert nonames 30 ''
# The same with chosen dates, for a certificate that has expired and one that is not valid yet.
make_dated_cert() {
  local name=$1 from=$2 until=$3 names=$4 ca=$certs/ca-$1
  mkdir "$ca"
  : > "$ca/index.txt"
  echo 01 > "$ca/serial"
  cat > "$ca/openssl.cnf" <<CONFIG
[ca]
default_ca = test
[test]
database = $ca/index.txt
new_certs_dir = $ca
serial = $ca/serial
default_md = sha256
policy = policy
unique_subject = no
[policy]
commonName = supplied
[extensions]
subjectAltName = $names
CONFIG
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$name" \
    -keyout "$certs/$name.key" -out "$ca/request.csr" 2>/dev/null
  openssl ca -batch -selfsign -config "$ca/openssl.cnf" -extensions extensions -keyfile "$certs/$name.key" \
    -in "$ca/request.csr" -out "$certs/$name.pem" -startdate "$from" -enddate "$until" -notext 2>/dev/null
}
make_dated_cert expired 20200101000000Z 20200201000000Z 'DNS:*.itest.localhost'
make_dated_cert future 20990101000000Z 20990201000000Z 'DNS:*.itest.localhost'
openssl genrsa -out "$certs/rsa.key" 2048 2>/dev/null
openssl req -x509 -key "$certs/rsa.key" -days 30 -subj /CN=rsa -addext 'subjectAltName=DNS:*.itest.localhost' -out "$certs/rsa.pem" 2>/dev/null
openssl pkey -in "$certs/wildcard.key" -aes256 -passout pass:secret -out "$certs/encrypted.key"
echo "this is not a certificate" > "$certs/text.pem"

own=("${unattended[@]}" --tls own --admin-email a@example.com)
expect 2 'does not cover sandbox.itest.localhost.*It names: dock.itest.localhost auth.itest.localhost' \
  "${own[@]}" --domain itest.localhost --cert "$certs/two.pem" --key "$certs/two.key"
expect 2 'does not cover apps.itest.localhost' \
  "${own[@]}" --domain itest.localhost --cert "$certs/named.pem" --key "$certs/named.key"
# A wildcard stands for one label: *.itest.localhost does not cover dock.a.itest.localhost.
expect 2 'does not cover dock.a.itest.localhost' \
  "${own[@]}" --domain a.itest.localhost --cert "$certs/wildcard.pem" --key "$certs/wildcard.key"
expect 2 'does not cover itest.localhost' \
  "${own[@]}" --velydock-host itest.localhost --keycloak-host auth.itest.localhost --sandbox-host sandbox.itest.localhost \
  --cert "$certs/wildcard.pem" --key "$certs/wildcard.key"
expect 2 'The certificate expired on Feb  1 00:00:00 2020 GMT.*--cert' "${own[@]}" --domain itest.localhost --cert "$certs/expired.pem" --key "$certs/expired.key"
expect 2 'The certificate is not valid before Jan  1 00:00:00 2099 GMT' "${own[@]}" --domain itest.localhost --cert "$certs/future.pem" --key "$certs/future.key"
expect 2 'names no host \(subjectAltName is missing\)' "${own[@]}" --domain itest.localhost --cert "$certs/nonames.pem" --key "$certs/nonames.key"
expect 2 'does not start with a certificate in PEM format' "${own[@]}" --domain itest.localhost --cert "$certs/text.pem" --key "$certs/wildcard.key"
expect 2 'cannot be read' "${own[@]}" --domain itest.localhost --cert "$certs/missing.pem" --key "$certs/wildcard.key"
expect 2 'The key does not belong to the certificate.*--key' "${own[@]}" --domain itest.localhost --cert "$certs/wildcard.pem" --key "$certs/named.key"
expect 2 'The key does not belong to the certificate' "${own[@]}" --domain itest.localhost --cert "$certs/wildcard.pem" --key "$certs/rsa.key"
expect 2 'holds no private key that can be read' "${own[@]}" --domain itest.localhost --cert "$certs/wildcard.pem" --key "$certs/encrypted.key"
expect 2 'holds no private key that can be read' "${own[@]}" --domain itest.localhost --cert "$certs/wildcard.pem" --key "$certs/wildcard.pem"
[[ ! -e $never ]] || fail "a refused certificate created $never"
echo "refused: host not covered (named, wildcard one label too deep, bare domain), expired, not valid yet,"
echo "         no names, not PEM, unreadable, key of another certificate (EC and RSA), encrypted key, no key"

# ---- 2. the management command against a stand-in for docker ---------------------------------

section "management command: contract and housekeeping, with a stand-in for docker"
"$repo/scripts/make-bundle.sh" "$first" "example.invalid/velydock:$first" "$work/plain-release" >/dev/null
stage=$work/stage
mkdir "$stage"
tar -xzf "$work/plain-release/velydock-$first.tar.gz" -C "$stage"
fake=$work/fake
mkdir -m 755 "$fake"
bash "$stage/velydock-$first/scripts/velydock" __place-files "$fake" "$stage/velydock-$first"
( cd "$fake" && sha256sum --check --quiet --strict MANIFEST ) || fail "__place-files did not place what the bundle holds"
[[ -x $fake/scripts/velydock && -x $fake/scripts/backup.sh && ! -x $fake/docker-compose.yml ]] || fail "file modes after __place-files"
cat > "$fake/.env" <<ENV
VELYDOCK_HOST=dock.fake.localhost
KEYCLOAK_HOST=auth.fake.localhost
SANDBOX_HOST=sandbox.fake.localhost
COMPOSE_PROFILES=proxy
COMPOSE_PROJECT_NAME=velydock-itest-fake
VELYDOCK_IMAGE=example.invalid/velydock:$first
ENV
chmod 600 "$fake/.env"

# The stand-in records how it was called, with which environment and what it was sent. Files
# in its directory make it fail or take its time where a test needs that.
stub=$work/stub
mkdir "$stub"
cat > "$stub/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/calls"
env > "$STUB_DIR/environment"
case "$*" in
  *"cert add"*) cat > "$STUB_DIR/stdin" ;;
  *prune-fetched*)
    if [[ -s $STUB_DIR/slow-prune ]]; then
      : > "$STUB_DIR/prune-running"
      sleep "$(cat "$STUB_DIR/slow-prune")"
    fi
    ;;
  *pg_dump*) echo "dump of ${*: -1}" ;;
  "compose config --services") printf '%s\n' keycloak postgres theme traefik velydock ;;
  "compose config")
    if [[ -e $STUB_DIR/fail-config ]]; then
      echo "stand-in: the Compose file cannot be read" >&2
      exit 15
    fi
    printf 'name: velydock-itest-fake\nservices: {}\n'
    ;;
  *" config --images")
    printf '%s\n' "${VELYDOCK_IMAGE:-}" > "$STUB_DIR/image-asked"
    printf '%s\n' example.invalid/postgres:1 "${VELYDOCK_IMAGE:-example.invalid/velydock:none}"
    ;;
  "image inspect "*) [[ ! -e $STUB_DIR/images-missing ]] || exit 1 ;;
  "pull "* | *" pull --quiet")
    if [[ -e $STUB_DIR/fail-pull ]]; then
      echo "stand-in: the registry does not answer" >&2
      exit 1
    fi
    ;;
  "compose ps --all -q "*) echo "id-${*: -1}" ;;
  "inspect --format {{.Config.Image}} "*) cat "$STUB_DIR/running-image" 2>/dev/null ;;
  "inspect --format "*)
    case ${*: -1} in
      id-theme) echo 'exited||0|no' ;;
      id-traefik) echo 'running||0|unless-stopped' ;;
      *) echo 'running|healthy|0|unless-stopped' ;;
    esac
    ;;
  "info --format {{.DockerRootDir}}") echo "$STUB_DIR" ;;
esac
exit 0
STUB
chmod +x "$stub/docker"
stubbed=("${clean[@]}" "PATH=$stub:$PATH" "STUB_DIR=$stub" "VELYDOCK_RELEASE_BASE_URL=http://127.0.0.1:9/none"
  PUBLIC_PORT_SUFFIX=:1 VELYDOCK_HOST=wrong.localhost COMPOSE_PROJECT_NAME=velydock-itest-wrong
  COMPOSE_FILE=/nonexistent.yml "$fake/scripts/velydock")

"${stubbed[@]}" cert add "$certs/wildcard.pem" "$certs/wildcard.key" >/dev/null
grep -qxF 'compose exec -T velydock velydock cert add --name wildcard-itest-localhost' "$stub/calls" ||
  fail "cert add did not call the contract: $(tail -n1 "$stub/calls")"
[[ $(grep -c -- '-----BEGIN' "$stub/stdin") == 2 && $(grep -c -- '-----END' "$stub/stdin") == 2 ]] ||
  fail "cert add did not send certificate and key as one PEM stream"
[[ $(head -n1 "$stub/stdin") == "-----BEGIN CERTIFICATE-----" ]] || fail "the PEM stream does not start with the certificate"
openssl x509 -in "$stub/stdin" -noout || fail "the certificate in the stream does not parse"
openssl pkey -in "$stub/stdin" -noout || fail "the key in the stream does not parse"
if grep -Eq '^(PUBLIC_PORT_SUFFIX|VELYDOCK_HOST|COMPOSE_PROJECT_NAME|COMPOSE_FILE)=' "$stub/environment"; then
  fail "the caller's environment reached docker compose: $(grep -E '^(PUBLIC_PORT_SUFFIX|VELYDOCK_HOST|COMPOSE)' "$stub/environment" | tr '\n' ' ')"
fi
# A certificate file without a final line break must not run into the key.
printf '%s' "$(cat "$certs/wildcard.pem")" > "$certs/unterminated.pem"
"${stubbed[@]}" cert add "$certs/unterminated.pem" "$certs/wildcard.key" --name main --replace >/dev/null
grep -qxF 'compose exec -T velydock velydock cert add --name main --replace' "$stub/calls" || fail "cert add --name --replace"
openssl pkey -in "$stub/stdin" -noout || fail "the key after an unterminated certificate file does not parse"
"${stubbed[@]}" cert list >/dev/null
grep -qxF 'compose exec -T velydock velydock cert list' "$stub/calls" || fail "cert list"
"${stubbed[@]}" cert remove main >/dev/null
grep -qxF 'compose exec -T velydock velydock cert remove main' "$stub/calls" || fail "cert remove"
expect 1 'cannot read the key file' "${stubbed[@]}" cert add "$certs/wildcard.pem" "$certs/missing.key"
expect 1 'usage: velydock cert add' "${stubbed[@]}" cert add "$certs/wildcard.pem"
"${stubbed[@]}" admin --username someone --email someone@example.com >/dev/null
grep -qxF 'compose exec -T velydock velydock setup-admin --username someone --email someone@example.com' "$stub/calls" || fail "admin"

# Backups: --keep removes complete backups made by backup.sh beyond the newest N, nothing else.
vault=$work/vault
mkdir "$vault"
old_backup() {
  mkdir "$vault/$1"
  echo data > "$vault/$1/velydock.dump"
  echo data > "$vault/$1/keycloak.dump"
  echo env > "$vault/$1/env"
  ( cd "$vault/$1" && sha256sum velydock.dump keycloak.dump env > SHA256SUMS )
}
old_backup velydock-20200101T000000Z
old_backup velydock-20200102T000000Z
old_backup velydock-20200103T000000Z
old_backup velydock-20190101T000000Z && echo mine > "$vault/velydock-20190101T000000Z/notes.txt"
old_backup velydock-20180101T000000Z && rm "$vault/velydock-20180101T000000Z/SHA256SUMS"
mkdir "$vault/velydock-20170101T000000Z.partial" "$vault/photos" "$vault/velydock-2020"
touch "$vault/velydock-readme"
ln -s "$vault/photos" "$vault/velydock-20160101T000000Z"
expect 1 'must be 1 or more' "${stubbed[@]}" backup "$vault" --keep 0
"${stubbed[@]}" backup "$vault" --keep 2 > "$work/backup.out"
grep -q 'removed old backup .*velydock-20200101T000000Z' "$work/backup.out" || fail "--keep did not remove the oldest backup"
left=$(cd "$vault" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')
new_backup=$(cd "$vault" && find . -maxdepth 1 -name "velydock-$(date -u +%Y)*Z" -printf '%f\n' | sort | tail -n1)
[[ -n $new_backup && -s $vault/$new_backup/velydock.dump && -s $vault/$new_backup/SHA256SUMS ]] || fail "no new backup in $vault"
want=$(printf '%s\n' photos velydock-2020 velydock-20160101T000000Z velydock-20170101T000000Z.partial velydock-20180101T000000Z \
  velydock-20190101T000000Z velydock-20200103T000000Z "$new_backup" velydock-readme | sort | tr '\n' ' ')
[[ $left == "$want" ]] || fail "after --keep 2 the directory holds: $left   expected: $want"
[[ $(stat -c %a "$vault/$new_backup") == 700 ]] || fail "a backup is readable by others"
echo "kept: the two newest, the one with a foreign file, the incomplete ones, everything not a backup"

# Updates that are none.
expect 0 'Nothing to do' "${stubbed[@]}" update --version "$first" --yes
expect 1 'is older than the installed' "${stubbed[@]}" update --version 0.0.9 --yes
expect 1 "is older than the installed" "${stubbed[@]}" update --version "$first-rc.1" --yes
expect 1 'could not download' "${stubbed[@]}" update --version 9.9.9 --yes
expect 1 'could not find out the latest release' "${stubbed[@]}" update --yes
expect 1 'unknown command' "${stubbed[@]}" frobnicate
expect 0 "Velydock $first" "${stubbed[@]}" version
expect 0 'velydock uninstall' "${stubbed[@]}" help
( cd "$fake" && sha256sum --check --quiet --strict MANIFEST ) || fail "a refused update changed program files"
expect 1 'is not a Velydock installation' "${clean[@]}" "$repo/scripts/velydock" status

# doctor names the certificate that is really served: a TLS server on a free loopback port
# stands in for the proxy and serves one certificate after the other.
make_cert soon 5 'DNS:*.itest.localhost'
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj '/CN=TRAEFIK DEFAULT CERT' \
  -addext 'subjectAltName=DNS:0123456789abcdef.traefik.default' -keyout "$certs/standin.key" -out "$certs/standin.pem" 2>/dev/null
cat > "$work/tls-server.py" <<'PY'
"""Serves one certificate on a free loopback port and answers every GET like /api/health.

argv: <certificate> <key> <file that receives the port>
"""
import http.server
import ssl
import sys


class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"status": "ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Health)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
with open(sys.argv[3], "w", encoding="ascii") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
PY
# doctor_with <certificate> <line for TLS_RESOLVER, or ""> - leaves what doctor said in doctor.out
doctor_with() {
  local name=$1 resolver=$2 port
  rm -f "$work/tls-port"
  python3 "$work/tls-server.py" "$certs/$name.pem" "$certs/$name.key" "$work/tls-port" &
  tls_pid=$!
  for _ in $(seq 1 100); do
    [[ -s $work/tls-port ]] && break
    python3 -c 'import time; time.sleep(0.1)'
  done
  port=$(cat "$work/tls-port")
  cat > "$fake/.env" <<ENV
VELYDOCK_HOST=dock.itest.localhost
KEYCLOAK_HOST=auth.itest.localhost
SANDBOX_HOST=sandbox.itest.localhost
COMPOSE_PROFILES=proxy
HTTP_BIND=127.0.0.1:$port
HTTPS_BIND=127.0.0.1:$port
VELYDOCK_IMAGE=example.invalid/velydock:$first
$resolver
ENV
  "${stubbed[@]}" doctor > "$work/doctor.out" 2>&1 || true
  kill "$tls_pid" 2>/dev/null
  wait "$tls_pid" 2>/dev/null || true
  tls_pid=""
}
said() {
  grep -Eq -- "$1" "$work/doctor.out" || {
    cat "$work/doctor.out" >&2
    fail "doctor did not say: $1"
  }
}
doctor_with wildcard 'TLS_RESOLVER='
said '^\[ ok \] dock\.itest\.localhost: certificate valid until .* GMT, (29|30) days left \(issuer: CN=wildcard\)$'
said '^\[ ok \] sandbox\.itest\.localhost: certificate valid until'
said '^\[ ok \] Velydock answers through the proxy'
said ', 0 failures$'
doctor_with two 'TLS_RESOLVER='
said '^\[ ok \] auth\.itest\.localhost: certificate valid until'
said '^\[FAIL\] sandbox\.itest\.localhost: the certificate served does not cover this name \(it names: dock\.itest\.localhost auth\.itest\.localhost'
said ', 1 failures$'
doctor_with expired 'TLS_RESOLVER='
said '^\[FAIL\] dock\.itest\.localhost: the certificate expired on Feb  1 00:00:00 2020 GMT'
doctor_with soon 'TLS_RESOLVER='
said '^\[warn\] dock\.itest\.localhost: the certificate expires on .*, in less than 14 days'
doctor_with standin 'TLS_RESOLVER='
said "^\\[warn\\] dock\\.itest\\.localhost: served with the proxy's self-signed certificate"
doctor_with standin ''
said "^\\[FAIL\\] dock\\.itest\\.localhost: served with the proxy's self-signed stand-in - Let's Encrypt has not issued"
echo "doctor: valid, not covering, expired, expiring and stand-in certificates are told apart"

section "management command: when things go wrong (still with the stand-in)"
# The line of the first call that matches, in the stand-in's record; nothing if there is none.
call_line() { { grep -n -- "$1" "$stub/calls" || true; } | sed -n 1p | cut -d: -f1; }

# cert takeover stops the proxy, changes its store and starts it again - and starts it again
# also when it is interrupted in between.
: > "$stub/calls"
"${stubbed[@]}" cert takeover > "$work/takeover.out" 2>&1 || {
  cat "$work/takeover.out" >&2
  fail "cert takeover failed"
}
grep -qxF 'compose run --rm --no-deps --user 0:0 -v velydock-itest-fake_traefik-acme:/acme velydock cert prune-fetched /acme/acme.json' "$stub/calls" ||
  fail "cert takeover did not prune the store of this installation's proxy: $(tr '\n' ';' < "$stub/calls")"
stopped=$(call_line '^compose stop traefik$')
pruned=$(call_line 'prune-fetched')
started_again=$(call_line '^compose start traefik$')
if [[ -z $stopped || -z $pruned || -z $started_again ]] || (( stopped > pruned || pruned > started_again )); then
  fail "cert takeover: expected stop, prune, start - got: $(tr '\n' ';' < "$stub/calls")"
fi
# The configuration cannot be read: said so, and the proxy is not touched.
: > "$stub/calls"
touch "$stub/fail-config"
expect 1 'cannot read the configuration of this installation' "${stubbed[@]}" cert takeover
if grep -q 'traefik' "$stub/calls"; then fail "cert takeover touched the proxy although the configuration could not be read"; fi
rm "$stub/fail-config"
# Interrupted while the store is being changed, the way a closed terminal does it: the signal
# goes to the command and everything it started.
interrupt_takeover() {
  local signal=$1 whom=$2 status=0 pid
  : > "$stub/calls"
  rm -f "$stub/prune-running"
  if [[ $whom == group ]]; then
    setsid "${stubbed[@]}" cert takeover > "$work/takeover.out" 2>&1 &
  else
    "${stubbed[@]}" cert takeover > "$work/takeover.out" 2>&1 &
  fi
  pid=$!
  for _ in $(seq 1 100); do
    [[ -e $stub/prune-running ]] && break
    python3 -c 'import time; time.sleep(0.1)'
  done
  [[ -e $stub/prune-running ]] || fail "cert takeover never got as far as changing the store"
  if [[ $whom == group ]]; then kill "-$signal" -- "-$pid"; else kill "-$signal" "$pid"; fi
  wait "$pid" || status=$?
  [[ $status == "$3" ]] || { cat "$work/takeover.out" >&2; fail "cert takeover interrupted by $signal ended with status $status instead of $3"; }
  pruned=$(call_line 'prune-fetched')
  started_again=$(call_line '^compose start traefik$')
  if [[ -z $started_again ]] || (( started_again < pruned )); then
    fail "cert takeover interrupted by $signal left the proxy stopped: $(tr '\n' ';' < "$stub/calls")"
  fi
  grep -q 'The proxy is running again' "$work/takeover.out" || fail "cert takeover interrupted by $signal did not say that the proxy runs again"
}
echo 30 > "$stub/slow-prune"
interrupt_takeover HUP group 129
# Only the command itself is told to end; what it started finishes first (here after 3 seconds).
echo 3 > "$stub/slow-prune"
interrupt_takeover TERM command 143
rm "$stub/slow-prune"
echo "cert takeover: stop, prune, start; interrupted by HUP and by TERM, the proxy is started again"

# Retention never removes the backup just made - also when older ones carry later times,
# because the clock was ahead when they were written.
vault=$work/vault-ahead
mkdir "$vault"
old_backup velydock-20200101T000000Z
old_backup velydock-20990101T000000Z
old_backup velydock-20990102T000000Z
"${stubbed[@]}" backup "$vault" --keep 2 > "$work/backup.out"
made=$(sed -n 's/^backup written to //p' "$work/backup.out")
[[ -n $made && -d $made && -s $made/velydock.dump ]] || { cat "$work/backup.out" >&2; fail "with later-dated backups present, the backup just made is gone"; }
left=$(cd "$vault" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')
[[ $left == "velydock-20990102T000000Z ${made##*/} " || $left == "${made##*/} velydock-20990102T000000Z " ]] ||
  fail "after --keep 2 with later-dated backups the directory holds: $left"
python3 -c 'import time; time.sleep(1.1)'
"${stubbed[@]}" backup "$vault" --keep 1 > "$work/backup.out"
made=$(sed -n 's/^backup written to //p' "$work/backup.out")
left=$(cd "$vault" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | tr '\n' ' ')
[[ $left == "${made##*/} " ]] || fail "after --keep 1 the directory holds: $left   expected only ${made##*/}"
echo "retention: the backup just made stays, whatever the names of the others"

# Updates. A second release, served from a loopback port of its own.
"$repo/scripts/make-bundle.sh" "$second" "example.invalid/velydock:$second" "$work/quick-release/download/v$second" >/dev/null
mkdir "$work/quick-release/latest" "$work/stage2"
cp -r "$work/quick-release/download/v$second" "$work/quick-release/latest/download"
tar -xzf "$work/quick-release/download/v$second/velydock-$second.tar.gz" -C "$work/stage2"
cat > "$work/file-server.py" <<'PY'
"""Serves a directory on a free loopback port. argv: <directory> <file that receives the port>"""
import http.server
import os
import sys


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


os.chdir(sys.argv[1])
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
with open(sys.argv[2], "w", encoding="ascii") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
PY
python3 "$work/file-server.py" "$work/quick-release" "$work/files-port" &
files_pid=$!
for _ in $(seq 1 100); do
  [[ -s $work/files-port ]] && break
  python3 -c 'import time; time.sleep(0.1)'
done
updating=("${clean[@]}" "PATH=$stub:$PATH" "STUB_DIR=$stub" "VELYDOCK_RELEASE_BASE_URL=http://127.0.0.1:$(cat "$work/files-port")")
old_image=example.invalid/velydock:$first
new_image=example.invalid/velydock:$second
# fresh_installation <directory>: the program files of the first release and a small .env
fresh_installation() {
  mkdir -m 755 "$1"
  bash "$stage/velydock-$first/scripts/velydock" __place-files "$1" "$stage/velydock-$first"
  cat > "$1/.env" <<ENV
VELYDOCK_HOST=dock.fake.localhost
KEYCLOAK_HOST=auth.fake.localhost
SANDBOX_HOST=sandbox.fake.localhost
COMPOSE_PROFILES=
COMPOSE_PROJECT_NAME=velydock-itest-fake
VELYDOCK_IMAGE=$old_image
ENV
  chmod 600 "$1/.env"
}
# Everything in an installation directory but the lock, with checksums.
fingerprint() { ( cd "$1" && find . -type f ! -name .lock -exec sha256sum {} + | sort -k 2 ); }
# True if the program files are exactly those of a release (given as its unpacked bundle).
is_release() { [[ $(cat "$1/VERSION") == "$(cat "$2/VERSION")" ]] && ( cd "$1" && sha256sum --check --quiet --strict MANIFEST >/dev/null 2>&1 ) && cmp -s "$1/MANIFEST" "$2/MANIFEST"; }

# 1. The images cannot be fetched: nothing is changed, and the update can simply be repeated.
one=$work/update-one
fresh_installation "$one"
echo "version=$first" > "$one/.install-state"
before=$(fingerprint "$one")
touch "$stub/fail-pull" "$stub/images-missing"
: > "$stub/calls"
expect 1 "images of version $second could not be fetched.*Nothing was changed" \
  "${updating[@]}" VELYDOCK_PULL_POLICY=missing "$one/scripts/velydock" update --yes
[[ $(fingerprint "$one") == "$before" ]] || fail "an update whose images could not be fetched (only missing ones) changed the installation"
[[ $(cat "$stub/image-asked") == "$new_image" ]] || fail "the images were not asked for with the image of the new release"
grep -q -- "-f .*/velydock-$second/docker-compose.yml config --images\$" "$stub/calls" || fail "the images were not taken from the Compose file of the new release"
rm "$stub/images-missing"
: > "$stub/calls"
expect 1 "images of version $second could not be fetched.*Nothing was changed" "${updating[@]}" "$one/scripts/velydock" update --yes
[[ $(fingerprint "$one") == "$before" ]] || fail "an update whose images could not be fetched changed the installation"
grep -q -- "^compose --project-directory $one --env-file $one/.env -f .*/velydock-$second/docker-compose.yml pull --quiet\$" "$stub/calls" ||
  fail "the images were not fetched with the Compose file of the new release: $(tr '\n' ';' < "$stub/calls")"
if grep -q 'pg_dump\|compose up' "$stub/calls"; then fail "an update whose images could not be fetched went on to back up or to start"; fi
expect 0 "Velydock $first in" "${updating[@]}" "$one/scripts/velydock" status
rm "$stub/fail-pull"
: > "$stub/calls"
"${updating[@]}" "$one/scripts/velydock" update --yes > "$work/update.out" 2>&1 || { cat "$work/update.out" >&2; fail "the repeated update failed"; }
grep -q "Velydock was updated: $first -> $second" "$work/update.out" || fail "the repeated update did not report $first -> $second"
is_release "$one" "$work/stage2/velydock-$second" || fail "after the update the program files are not those of $second"
grep -qxF "VELYDOCK_IMAGE=$new_image" "$one/.env" || fail "after the update .env does not name the new image"
[[ ! -e $one/.update-state && $(cat "$one/.previous/$first/VERSION") == "$first" && $(cat "$one/.previous/$first.image") == "$old_image" ]] ||
  fail "after the update: .update-state left, or .previous is not the first release"
fetched=$(call_line ' pull --quiet$')
dumped=$(call_line 'pg_dump')
up=$(call_line '^compose up -d --wait')
if [[ -z $fetched || -z $dumped || -z $up ]] || (( fetched > dumped || dumped > up )); then
  fail "update: expected images, backup, start in this order - got: $(tr '\n' ';' < "$stub/calls")"
fi
# An installer run that never finished has nothing left to finish after an update.
[[ ! -e $one/.install-state ]] || fail "the update left the stale .install-state"
grep -q "removed $one/.install-state" "$work/update.out" || fail "the update did not say that it removed .install-state"
echo "update: images first; when they cannot be fetched nothing is changed, and the update can be repeated"

# 2. What runs is compared with what .env names; a leftover of the installer is reported.
echo "example.invalid/velydock:0.0.1" > "$stub/running-image"
expect 1 'runs the image example.invalid/velydock:0.0.1' "${updating[@]}" "$one/scripts/velydock" status
"${updating[@]}" "$one/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said '^\[FAIL\] the container velydock runs the image example.invalid/velydock:0.0.1, but .env names'
echo "$new_image" > "$stub/running-image"
expect 0 'Everything is running' "${updating[@]}" "$one/scripts/velydock" status
touch "$one/.install-state"
"${updating[@]}" "$one/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said '^\[ ok \] the container velydock runs the image .env names'
said '^\[warn\] the installer did not finish here'
said '^\[ ok \] the installation directory can be changed by its owner only'
chmod 777 "$one"
"${updating[@]}" "$one/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said '^\[FAIL\] the installation directory .* has mode 777'
chmod 755 "$one"
rm "$stub/running-image" "$one/.install-state"

# 3. Replacing the program files fails half-way (here: a directory where a file belongs): what
#    was replaced is put back, with the image line, and after the repair the update works.
two=$work/update-two
fresh_installation "$two"
rm "$two/scripts/restore.sh"
mkdir "$two/scripts/restore.sh"
before=$(fingerprint "$two")
expect 1 "files and the image of $first are back in place" "${updating[@]}" "$two/scripts/velydock" update --yes
[[ $(fingerprint "$two" | grep -v ' \./\.previous/\| \./backups/') == "$before" ]] ||
  fail "after a failed replacement the installation is not as before: $(diff <(echo "$before") <(fingerprint "$two") | grep -v previous | head -n 5)"
[[ $(cat "$two/VERSION") == "$first" && $(cat "$two/IMAGE") == "$old_image" && ! -e $two/.update-state ]] || fail "after a failed replacement: VERSION, IMAGE or .update-state"
[[ -z $(find "$two" -name '*.new.*') ]] || fail "a failed replacement left half-written files: $(find "$two" -name '*.new.*')"
rmdir "$two/scripts/restore.sh"
install -m 755 "$stage/velydock-$first/scripts/restore.sh" "$two/scripts/restore.sh"
python3 -c 'import time; time.sleep(1.1)'
"${updating[@]}" "$two/scripts/velydock" update --yes > "$work/update.out" 2>&1 || { cat "$work/update.out" >&2; fail "the update after the repair failed"; }
is_release "$two" "$work/stage2/velydock-$second" || fail "after the repaired update the program files are not those of $second"
echo "update: a replacement that fails half-way is taken back"

# 4. Cut off for good while it replaced files (as after a power failure): .update-state stays.
#    status and doctor say so, nothing is started from the mixture, and "update" finishes it
#    without overwriting what was kept of the old release.
three=$work/update-three
fresh_installation "$three"
mkdir -p "$three/.previous/$first"
cp -a "$stage/velydock-$first/." "$three/.previous/$first/"
echo "$old_image" > "$three/.previous/$first.image"
printf 'from=%s\nto=%s\n' "$first" "$second" > "$three/.update-state"
install -m 644 "$work/stage2/velydock-$second/IMAGE" "$three/IMAGE"
expect 1 "update from $first to $second was cut off" "${updating[@]}" "$three/scripts/velydock" status
"${updating[@]}" "$three/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said "^\\[FAIL\\] an update from $first to $second was cut off"
expect 1 'nothing is started from this mixture' "${updating[@]}" "$three/scripts/velydock" start
expect 1 "Finish it first: velydock update --version $second" "${updating[@]}" "$three/scripts/velydock" update --version 9.9.9 --yes
"${updating[@]}" "$three/scripts/velydock" update --yes > "$work/update.out" 2>&1 || { cat "$work/update.out" >&2; fail "finishing an update that was cut off failed"; }
grep -q 'It is finished now' "$work/update.out" || fail "the update did not say that it finishes the one that was cut off"
is_release "$three" "$work/stage2/velydock-$second" || fail "after finishing, the program files are not those of $second"
[[ ! -e $three/.update-state && $(cat "$three/.previous/$first/IMAGE") == "$old_image" ]] ||
  fail "after finishing: .update-state left, or the kept copy of $first was overwritten with the mixture"
expect 0 'Everything is running' "${updating[@]}" "$three/scripts/velydock" status
echo "update: one that was cut off is reported by status and doctor, and finished by the next update"

# 5. A place that hands down write access for everybody: a caller with umask 000, and - where
#    the file system and the tools allow it - a default ACL on the directory above, as /opt has
#    on GitHub's runners. There a new directory is writable for others whatever the umask (the
#    first run of the CI job found the installation directory with mode 777 after the documented
#    way back). Root runs programs from the installation: nothing in it may be writable for others.
open_parent=$work/open-parent
mkdir "$open_parent"
handed_down="umask 000"
if command -v setfacl >/dev/null 2>&1 && setfacl -d -m u::rwx,g::rwx,o::rwx "$open_parent" 2>/dev/null; then
  handed_down="umask 000 and a default ACL above"
fi
four=$open_parent/installation
( umask 000 && fresh_installation "$four" )
# What the installer does with the directory itself (secure_directory in install.sh).
if command -v setfacl >/dev/null 2>&1; then setfacl -b -k "$four" 2>/dev/null || true; fi
chmod go-w "$four"
open=$(find "$four" -perm /022 ! -type l | head -n 5)
[[ -z $open ]] || fail "after placing the program files with $handed_down, others can write to: $open"
( umask 000 && "${updating[@]}" "$four/scripts/velydock" update --yes ) > "$work/update.out" 2>&1 || {
  cat "$work/update.out" >&2
  fail "the update with $handed_down failed"
}
[[ -d $four/.previous/$first ]] || fail "the update kept no previous files"
open=$(find "$four" -perm /022 ! -type l | head -n 5)
[[ -z $open ]] || fail "after an update with $handed_down, others can write to: $open"
# The documented way back copies the kept directory over the installation, its mode included.
cp -a "$four/.previous/$first/." "$four/"
[[ $(stat -c %a "$four") == 755 ]] || fail "after the way back the installation directory has mode $(stat -c %a "$four")"
"${updating[@]}" "$four/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said '^\[ ok \] the installation directory can be changed by its owner only'
said '^\[ ok \] the program files can be changed by their owner only'
chmod o+w "$four/scripts/velydock"
"${updating[@]}" "$four/scripts/velydock" doctor > "$work/doctor.out" 2>&1 || true
said '^\[FAIL\] others can write to program files of the installation: .*scripts/velydock'
chmod o-w "$four/scripts/velydock"
echo "update: nothing below the installation is writable for others ($handed_down)"
kill "$files_pid" 2>/dev/null
wait "$files_pid" 2>/dev/null || true
files_pid=""

if [[ ${INSTALLER_TEST_ONLY:-} == quick ]]; then
  passed=" (the quick part only: INSTALLER_TEST_ONLY=quick)"
  exit 0
fi

# ---- 3. a local release ----------------------------------------------------------------------

section "local release: registry on $registry, files on $base_url"
docker image inspect "$source_image" >/dev/null 2>&1 ||
  fail "image $source_image not found - build it (docker build -t velydock:dev .) or set VELYDOCK_DEV_IMAGE."
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] ||
  fail "the Compose project $project already has containers (another run, or leftovers of one)."
[[ -z $(docker ps -aq --filter "name=^$registry_name\$") ]] || fail "a container named $registry_name already exists."
for port in "$registry_port" "$release_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then fail "port $port is in use."; fi
done

docker run -d --name "$registry_name" -p "127.0.0.1:$registry_port:5000" registry:3 >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://$registry/v2/" >/dev/null 2>&1 && break
  python3 -c 'import time; time.sleep(1)'
done
curl -fsS "http://$registry/v2/" >/dev/null || fail "the registry does not answer."

# One image per version, pushed and then removed here: the installer has to pull it.
publish() {
  local version=$1 tag=$registry/velydock:$1 digest
  printf 'FROM %s\nLABEL org.opencontainers.image.version="%s"\n' "$source_image" "$version" |
    docker build -q -t "$tag" - >/dev/null
  docker push -q "$tag" >/dev/null
  digest=$(curl -fsSI -H 'Accept: application/vnd.oci.image.index.v1+json' -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "http://$registry/v2/velydock/manifests/$version" | tr -d '\r' | sed -nE 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: (sha256:[0-9a-f]{64})$/\1/p')
  [[ -n $digest ]] || fail "the registry gave no digest for $tag"
  docker rmi "$tag" >/dev/null
  # As the release workflow writes it: tag and digest.
  "$repo/scripts/make-bundle.sh" "$version" "$tag@$digest" "$release/download/v$version" >/dev/null
  printf '%s@%s' "$tag" "$digest"
}
latest() {
  rm -rf -- "$release/latest"
  mkdir -p "$release/latest"
  cp -r "$release/download/v$1" "$release/latest/download"
}
mkdir -p "$release/download"
first_image=$(publish "$first")
second_image=$(publish "$second")
# A release whose image is not in the registry.
unfetchable=0.1.5
"$repo/scripts/make-bundle.sh" "$unfetchable" "$registry/velydock:$unfetchable@sha256:$(printf '%064d' 0)" \
  "$release/download/v$unfetchable" >/dev/null
[[ ${first_image##*@} != "${second_image##*@}" ]] || fail "both versions have the same image."
if docker image inspect "$first_image" >/dev/null 2>&1; then fail "$first_image is still present locally; the test would not pull it."; fi
latest "$first"

# A release whose bundle was changed after SHA256SUMS was written, and one without checksums.
mkdir -p "$release/download/v9.9.9" "$release/download/v9.9.8"
cp "$release/download/v$first/SHA256SUMS" "$release/download/v9.9.9/SHA256SUMS"
sed -i "s/velydock-$first/velydock-9.9.9/" "$release/download/v9.9.9/SHA256SUMS"
cp "$release/download/v$first/velydock-$first.tar.gz" "$release/download/v9.9.9/velydock-9.9.9.tar.gz"
echo tampered >> "$release/download/v9.9.9/velydock-9.9.9.tar.gz"
cp "$release/download/v$first/velydock-$first.tar.gz" "$release/download/v9.9.8/velydock-9.9.8.tar.gz"
echo "unrelated" > "$release/download/v9.9.8/SHA256SUMS"

python3 -m http.server "$release_port" --bind 127.0.0.1 --directory "$release" > "$work/http.log" 2>&1 &
http_pid=$!
for _ in $(seq 1 30); do
  curl -fsS "$base_url/latest/download/SHA256SUMS" >/dev/null 2>&1 && break
  python3 -c 'import time; time.sleep(1)'
done
curl -fsSL "$base_url/latest/download/install.sh" -o "$work/install.sh"
( cd "$work" && grep ' install.sh$' "$release/latest/download/SHA256SUMS" | sha256sum --check --quiet ) || fail "install.sh does not match SHA256SUMS"
echo "published $first ($first_image) and $second; latest is $first"

# ---- 4. what must not be installed; the questions --------------------------------------------

section "downloads that are refused"
refuse=("${released[@]}" bash "$work/install.sh" --lang en --yes --no-system --dir "$never" --domain itest.localhost
  --tls selfsigned --admin-email a@example.com --http-bind "127.0.0.1:$((http_port + 1))"
  --https-bind "127.0.0.1:$((https_port + 1))" --project-name "$project-questions")
expect 1 'checksum of velydock-9.9.9.tar.gz does not match' "${refuse[@]}" --version 9.9.9
expect 1 'checksum of velydock-9.9.8.tar.gz does not match' "${refuse[@]}" --version 9.9.8
expect 1 'could not be downloaded' "${refuse[@]}" --version 7.7.7
expect 1 'No release could be found' "${clean[@]}" VELYDOCK_RELEASE_BASE_URL="$base_url/nowhere" bash "$work/install.sh" \
  --lang en --yes --no-system --dir "$never" --domain itest.localhost --tls selfsigned --admin-email a@example.com \
  --http-bind "127.0.0.1:$((http_port + 1))" --https-bind "127.0.0.1:$((https_port + 1))" --project-name "$project-questions"
# A port that is taken - here by the HTTP server of this test - is named with who holds it.
taken=("${released[@]}" bash "$work/install.sh" --lang en --yes --no-system --dir "$never" --domain itest.localhost
  --tls selfsigned --admin-email a@example.com --project-name "$project-questions")
expect 1 "Port $release_port is already in use: 127.0.0.1:$release_port \\(python3?\\)" \
  "${taken[@]}" --http-bind "127.0.0.1:$((http_port + 1))" --https-bind "127.0.0.1:$release_port"
expect 1 "Port $release_port is already in use" \
  "${taken[@]}" --http-bind "0.0.0.0:$release_port" --https-bind "127.0.0.1:$((https_port + 1))"
[[ ! -e $never ]] || fail "a refused download created $never"

section "the questions, typed into a terminal (piped installer, German)"
cat > "$work/terminal.py" <<'PY'
"""Runs a command on a pseudo-terminal and types an answer whenever a prompt appears.

argv: <file with the steps: one "regular expression<TAB>answer" per line> <command> [arguments ...]
Prints everything the command wrote and ends with its exit status; 97 if a prompt never came.
"""
import os
import pty
import re
import select
import sys
import time

steps = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        pattern, _, answer = line.rstrip("\n").partition("\t")
        steps.append((re.compile(pattern.encode()), answer.encode()))

pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

seen = b""
unread = b""
position = 0
deadline = time.time() + 300
while time.time() < deadline:
    ready, _, _ = select.select([terminal], [], [], 1.0)
    if not ready:
        continue
    try:
        data = os.read(terminal, 4096)
    except OSError:
        break
    if not data:
        break
    seen += data
    unread += data
    while position < len(steps):
        match = steps[position][0].search(unread)
        if not match:
            break
        unread = unread[match.end():]
        os.write(terminal, steps[position][1] + b"\n")
        position += 1

_, status = os.waitpid(pid, 0)
sys.stdout.write(seen.decode("utf-8", errors="replace"))
if position < len(steps):
    sys.stdout.write(f"\n[terminal.py] prompt {position + 1} never appeared: {steps[position][0].pattern.decode()}\n")
    sys.exit(97)
sys.exit(os.waitstatus_to_exitcode(status))
PY
# Each wrong answer is followed by the same question again.
{
  printf '%s\t%s\n' 'Basis-Domain[^\n]*: $' 'Kein Hostname'
  printf '%s\t%s\n' 'Basis-Domain[^\n]*: $' 'pty.itest.localhost'
  printf '%s\t%s\n' 'Velydock \(Oberfl[^\n]*\[dock\.pty\.itest\.localhost\]: $' ''
  printf '%s\t%s\n' 'Anmeldung \(Keycloak\) \[auth\.pty\.itest\.localhost\]: $' 'dock.pty.itest.localhost'
  printf '%s\t%s\n' 'Anmeldung \(Keycloak\) \[auth\.pty\.itest\.localhost\]: $' ''
  printf '%s\t%s\n' 'Sandbox[^\n]*\[sandbox\.pty\.itest\.localhost\]: $' ''
  printf '%s\t%s\n' 'Apps[^\n]*\[apps\.pty\.itest\.localhost\]: $' 'pty.itest.localhost'
  printf '%s\t%s\n' 'Apps[^\n]*\[apps\.pty\.itest\.localhost\]: $' ''
  printf '%s\t%s\n' 'Auswahl \[1\]: $' '7'
  printf '%s\t%s\n' 'Auswahl \[1\]: $' 'own'
  printf '%s\t%s\n' 'Zertifikatsdatei[^\n]*: $' "$certs/wildcard.pem"
  printf '%s\t%s\n' 'Zertifikatsdatei[^\n]*: $' "$certs/deep.pem"
  printf '%s\t%s\n' 'Schl[^\n]*sseldatei[^\n]*: $' "$certs/wildcard.key"
  printf '%s\t%s\n' 'Schl[^\n]*sseldatei[^\n]*: $' "$certs/deep.key"
  printf '%s\t%s\n' 'Benutzername \[admin\]: $' 'Der Chef'
  printf '%s\t%s\n' 'Benutzername \[admin\]: $' "$admin"
  printf '%s\t%s\n' 'E-Mail-Adresse: $' 'keine-adresse'
  printf '%s\t%s\n' 'E-Mail-Adresse: $' 'chef@example.com'
  if [[ $mode == system ]]; then
    printf '%s\t%s\n' 'Installationsverzeichnis \[/opt/velydock\]: $' 'opt/velydock'
    printf '%s\t%s\n' 'Installationsverzeichnis \[/opt/velydock\]: $' ''
  fi
  printf '%s\t%s\n' 'Jede Nacht sichern\? \[J/n\] $' 'vielleicht'
  printf '%s\t%s\n' 'Jede Nacht sichern\? \[J/n\] $' 'j'
  printf '%s\t%s\n' 'Zielverzeichnis \[[^\n]*/backups\]: $' ''
  printf '%s\t%s\n' 'aufbewahrt werden \[14\]: $' '0'
  printf '%s\t%s\n' 'aufbewahrt werden \[14\]: $' '5'
  printf '%s\t%s\n' 'Jetzt installieren\? \[J/n\] $' 'n'
} > "$work/steps"
# The one-line form: the installer comes through a pipe, the answers from the terminal.
printf -v piped 'curl -fsSL %q | %s bash -s -- --lang de' "$base_url/latest/download/install.sh" \
  "$(printf '%q ' "${root[@]}" "${released[@]}")"
for option in "${question_options[@]}"; do printf -v piped '%s %q' "$piped" "$option"; done
status=0
python3 "$work/terminal.py" "$work/steps" bash -c "$piped" > "$work/questions.out" 2>&1 || status=$?
if [[ $status != 1 ]]; then
  cat "$work/questions.out" >&2
  fail "the questions run ended with status $status instead of 1 (declined at the end)"
fi
for text in 'ist kein Hostname' 'Die Hostnamen müssen sich unterscheiden' \
  'dock.pty.itest.localhost darf nicht der Hostname für veröffentlichte Apps (pty.itest.localhost) sein' \
  'Wähle letsencrypt, own oder selfsigned' 'Das Zertifikat deckt dock.pty.itest.localhost nicht ab' \
  'Der Schlüssel gehört nicht zum Zertifikat' 'geht nicht als Benutzername' 'geht hier nicht als E-Mail-Adresse' \
  'Antworte mit j oder n' 'Gib eine Zahl von 1 bis 999 an' \
  "$question_url" 'apps.pty.itest.localhost' "eigenes Zertifikat $certs/deep.pem, gültig bis" \
  "$admin <chef@example.com>" 'die letzten 5' 'Abgebrochen. Es wurde nichts verändert.'; do
  grep -qF -- "$text" "$work/questions.out" || {
    cat "$work/questions.out" >&2
    fail "the questions run did not say: $text"
  }
done
if [[ $mode == user ]]; then [[ ! -e $work/questions ]] || fail "a declined installation created its directory"; fi
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project-questions") ]] || fail "a declined installation started containers"
echo "every wrong answer was explained and asked again; declined at the summary, nothing was written"

# ---- 5. installation and life after it -------------------------------------------------------

section "install.sh --yes ($first, self-signed) into $dir"
started=1
installer --lang en --yes "${install_options[@]}" --domain itest.localhost --tls selfsigned \
  --admin-user "$admin" --admin-email chef@example.com --backup-keep 2 > "$work/install.out" 2>&1 </dev/null || {
  cat "$work/install.out" >&2
  fail "the installer failed"
}
sed -E 's/(One-time password +).*/\1(shown once)/' "$work/install.out"
password=$(sed -nE 's/^ +One-time password +([^ ]+)$/\1/p' "$work/install.out")
[[ -n $password ]] || fail "the installer printed no one-time password"
grep -qF "$url" "$work/install.out" || fail "the installer did not print the address $url"

env_text=$(as_root cat "$dir/.env")
[[ $(as_root stat -c %a "$dir/.env") == 600 ]] || fail ".env is readable by others"
if grep -Eq '^[A-Z_]*(PASSWORD|SECRET|KEY)=$' <<<"$env_text"; then fail "the installer left a secret empty"; fi
grep -qxF 'TLS_RESOLVER=' <<<"$env_text" || fail "TLS_RESOLVER= is missing in .env (self-signed)"
grep -qxF "VELYDOCK_IMAGE=$first_image" <<<"$env_text" || fail ".env does not pin the image the bundle names"
grep -qxF "VELYDOCK_BACKUP_KEEP=2" <<<"$env_text" || fail ".env lacks the backup settings"
grep -qxF "APPS_HOST=apps.itest.localhost" <<<"$env_text" || fail ".env lacks the apps host"
as_root test ! -e "$dir/.install-state" || fail "the installer left its state file behind"
( cd "$dir" && as_root sha256sum --check --quiet --strict MANIFEST ) || fail "installed program files differ from the bundle"
[[ $(as_root cat "$dir/VERSION") == "$first" ]] || fail "VERSION is not $first"

# The log exists and holds no secret.
if [[ $mode == system ]]; then log=/var/log/velydock-install.log; else log=$dir/install.log; fi
as_root test -s "$log" || fail "no log at $log"
log_text=$(as_root cat "$log")
if grep -qF -- "$password" <<<"$log_text"; then fail "the one-time password is in the log"; fi
while IFS='=' read -r key value; do
  [[ $key =~ (PASSWORD|SECRET|KEY)$ && -n $value ]] || continue
  if grep -qF -- "$value" <<<"$log_text"; then fail "the value of $key is in the log"; fi
  if grep -qF -- "$value" "$work/install.out"; then fail "the installer printed the value of $key"; fi
done <<<"$env_text"

# The right project, the right image, and nothing but the proxy publishes a port.
container() { docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"; }
[[ -n $(container velydock) ]] || fail "no velydock container in project $project"
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=velydock-itest-wrong") ]] || fail "COMPOSE_PROJECT_NAME of the caller was used"
[[ $(docker inspect --format '{{.Config.Image}}' "$(container velydock)") == "$first_image" ]] || fail "velydock does not run $first_image"
published=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -E '^(postgres|keycloak|velydock) .*->' || true)
[[ -z $published ]] || fail "internal services publish ports: $published"
users() { docker exec "$(container postgres)" psql -U postgres -d velydock -Atc "SELECT count(*) FROM users"; }
[[ $(users) == 1 ]] || fail "expected one user after the installation, found $(users)"

if [[ $mode == system ]]; then
  [[ -x /usr/local/bin/velydock ]] || fail "/usr/local/bin/velydock is missing"
  systemctl is-enabled --quiet velydock-backup.timer || fail "the backup timer is not enabled"
  systemctl is-active --quiet velydock-backup.timer || fail "the backup timer is not active"
  sudo systemctl start velydock-backup.service || fail "the backup service failed"
  [[ -n $(sudo find "$dir/backups" -maxdepth 1 -name 'velydock-*Z' -type d) ]] || fail "the backup service wrote no backup"
  # A second backup in the same second would be refused.
  python3 -c 'import time; time.sleep(2)'
fi

section "first sign-in in a browser ($url)"
# sign_in <user name> <one-time password>
sign_in() {
  (
    cd "$repo/e2e"
    [[ -d node_modules ]] || npm ci --no-audit --no-fund
    INSTALL_URL=$url INSTALL_ADMIN=$1 INSTALL_ONE_TIME_PASSWORD=$2 \
      npx playwright test --config playwright.install.config.ts
  )
}
# True if the trace of the sign-in that just failed holds a request that ended with
# net::ERR_NETWORK_CHANGED.
network_changed() {
  python3 - "$repo/e2e/test-results" <<'PY'
import glob
import sys
import zipfile

for path in glob.glob(sys.argv[1] + "/*/trace.zip"):
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if name.endswith(".network") and b"net::ERR_NETWORK_CHANGED" in archive.read(name):
                sys.exit(0)
sys.exit(1)
PY
}
attempt=1
signing_in=$admin
one_time=$password
until sign_in "$signing_in" "$one_time"; do
  if (( attempt >= 4 )) || ! network_changed; then fail "the first sign-in in the browser failed"; fi
  attempt=$((attempt + 1))
  echo "A network interface of this machine changed during the sign-in (net::ERR_NETWORK_CHANGED)."
  echo "Attempt $attempt, with a further administrator."
  signing_in=nochmal$attempt
  one_time=$(velydock admin --username "$signing_in" --email "$signing_in@example.com" |
    sed -nE 's/.*One-time password:[[:space:]]+([^[:space:]]+).*/\1/p')
  [[ -n $one_time ]] || fail "velydock admin printed no one-time password"
done
# One account, and one more for each repeated attempt.
accounts=$(users)
[[ $accounts == "$attempt" ]] || fail "expected $attempt accounts after the sign-in, found $accounts"

section "running the installer again changes nothing"
before=$(as_root sha256sum "$dir/.env")
installer --lang en --yes "${install_options[@]}" --domain other.localhost --tls selfsigned --admin-email other@example.com \
  > "$work/again.out" 2>&1 </dev/null || { cat "$work/again.out" >&2; fail "the second run of the installer failed"; }
grep -q "Velydock $first is already installed in $dir" "$work/again.out" || { cat "$work/again.out" >&2; fail "the second run did not report the installation"; }
grep -q 'update' "$work/again.out" || fail "the second run did not point to velydock update"
grep -q 'doctor' "$work/again.out" || fail "the second run did not point to velydock doctor"
[[ $(as_root sha256sum "$dir/.env") == "$before" ]] || fail "the second run changed .env"
[[ $(users) == "$accounts" ]] || fail "the second run changed data"
tail -n 4 "$work/again.out"

section "velydock status, doctor, logs, admin"
velydock status
expect 0 "Velydock $first" velydock version
velydock doctor | tee "$work/doctor.out"
for text in 'container velydock: running, healthy' 'container keycloak: running, healthy' 'container postgres: running, healthy' \
  'container traefik: running' 'container theme: finished' '.env is readable only by its owner' \
  'Velydock answers through the proxy' "dock.itest.localhost: served with the proxy's self-signed certificate" \
  "program files are those of release $first" "the latest release is $first" ', 0 failures'; do
  grep -qF -- "$text" "$work/doctor.out" || fail "doctor did not say: $text"
done
# doctor reports a problem with its exit status.
as_root chmod 644 "$dir/.env"
expect 1 'FAIL.*\.env has mode 644' velydock doctor
as_root chmod 600 "$dir/.env"
expect 0 'velydock' velydock logs --tail 5 velydock
expect 0 'One-time password' velydock admin --username zweite --email zweite@example.com
accounts=$((accounts + 1))
[[ $(users) == "$accounts" ]] || fail "velydock admin did not create a further administrator"

section "own certificates (velydock cert)"
docker exec "$(container velydock)" velydock cert --help >/dev/null 2>&1 ||
  fail "'velydock cert --help' fails in the container of $source_image: the image must have the certificate commands"
make_cert served 30 'DNS:*.itest.localhost'
velydock cert add "$certs/served.pem" "$certs/served.key"
expect 0 'wildcard-itest-localhost' velydock cert list
wanted=$(openssl x509 -in "$certs/served.pem" -noout -fingerprint -sha256)
found=""
for _ in $(seq 1 60); do
  found=$(openssl s_client -connect "$https_endpoint" -servername dock.itest.localhost </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null || true)
  [[ $found == "$wanted" ]] && break
  python3 -c 'import time; time.sleep(1)'
done
[[ $found == "$wanted" ]] || fail "the imported certificate is not served"
expect 0 'dock.itest.localhost: certificate valid until' velydock doctor
velydock cert remove wildcard-itest-localhost
echo "imported, served, listed, removed"

section "velydock backup"
velydock backup
python3 -c 'import time; time.sleep(2)'
# As a timer or cron calls the command: with next to no environment, not even HOME.
bare=(env -i "PATH=$PATH")
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR; do
  [[ -z ${!name:-} ]] || bare+=("$name=${!name}")
done
as_root "${bare[@]}" "$tool" backup
python3 -c 'import time; time.sleep(2)'
velydock backup | tee "$work/backup3.out"
grep -q 'removed old backup' "$work/backup3.out" || fail "the third backup removed none (keep is 2)"
backups=$(as_root find "$dir/backups" -mindepth 1 -maxdepth 1 | sort)
[[ $(wc -l <<<"$backups") == 2 ]] || fail "expected 2 backups, found: $backups"
newest=$(tail -n1 <<<"$backups")
for file in velydock.dump keycloak.dump env SHA256SUMS; do
  as_root test -s "$newest/$file" || fail "the backup lacks $file"
done
# shellcheck disable=SC2016  # $1 belongs to the inner shell (the directory is root's in system mode)
as_root bash -c 'cd "$1" && sha256sum --check --quiet SHA256SUMS' _ "$newest" || fail "the backup does not match its checksums"

section "velydock update: $first -> $second"
# What an update has to cope with: a program file changed on the server, a file the old release
# had and the new one does not, and a file in the watched directory that is not Velydock's.
as_root bash -c "echo '# changed on this server' >> '$dir/docker-compose.keycloak-admin.yml'"
as_root bash -c "echo gone > '$dir/deploy/retired.txt' && cd '$dir' && sha256sum deploy/retired.txt >> MANIFEST"
as_root bash -c "echo '# not from Velydock' > '$dir/deploy/traefik/dynamic/zz-other.yml'"
expect 0 "program files differ from release $first.*docker-compose.keycloak-admin.yml" velydock doctor
# An update whose image the registry does not have: it fails before anything is changed - no
# backup, no file, not the image line -, Velydock runs on, and the next update is not in the way.
env_before=$(as_root sha256sum "$dir/.env")
backups_before=$(as_root find "$dir/backups" -mindepth 1 -maxdepth 1 | wc -l)
expect 1 "images of version $unfetchable could not be fetched.*Nothing was changed" velydock update --version "$unfetchable" --yes
[[ $(as_root cat "$dir/VERSION") == "$first" ]] || fail "an update that could not fetch its image changed VERSION"
[[ $(as_root sha256sum "$dir/.env") == "$env_before" ]] || fail "an update that could not fetch its image changed .env"
as_root test ! -e "$dir/.previous" || fail "an update that could not fetch its image left .previous"
as_root test ! -e "$dir/.update-state" || fail "an update that could not fetch its image left .update-state"
[[ $(as_root find "$dir/backups" -mindepth 1 -maxdepth 1 | wc -l) == "$backups_before" ]] || fail "an update that could not fetch its image made a backup"
[[ $(docker inspect --format '{{.Config.Image}}' "$(container velydock)") == "$first_image" ]] || fail "an update that could not fetch its image replaced the container"
velydock status
latest "$second"
expect 0 "version $first is installed, $second is available" velydock doctor
expect 1 'nobody can be asked here' unattended_velydock update
velydock update --yes | tee "$work/update.out"
grep -q "Velydock was updated: $first -> $second" "$work/update.out" || fail "update did not report $first -> $second"
grep -q 'docker-compose.keycloak-admin.yml' "$work/update.out" || fail "update did not name the changed program file"
[[ $(as_root cat "$dir/VERSION") == "$second" ]] || fail "VERSION is not $second after the update"
( cd "$dir" && as_root sha256sum --check --quiet --strict MANIFEST ) || fail "program files after the update differ from the bundle"
as_root grep -qxF "VELYDOCK_IMAGE=$second_image" "$dir/.env" || fail ".env does not name the new image"
[[ $(docker inspect --format '{{.Config.Image}}' "$(container velydock)") == "$second_image" ]] || fail "velydock does not run $second_image"
as_root grep -q 'changed on this server' "$dir/.previous/$first/docker-compose.keycloak-admin.yml" || fail "the changed file was not kept in .previous"
as_root test -f "$dir/.previous/$first/scripts/velydock" || fail ".previous lacks the old program files"
[[ $(as_root cat "$dir/.previous/$first.image") == "$first_image" ]] || fail ".previous does not name the old image"
as_root test ! -e "$dir/deploy/retired.txt" || fail "a file the new release does not have was left in place"
as_root test -f "$dir/.previous/$first/deploy/retired.txt" || fail "the retired file was not kept in .previous"
as_root test -f "$dir/deploy/traefik/dynamic/zz-other.yml" || fail "the update removed a file that is not Velydock's"
[[ $(as_root stat -c %a "$dir/.env") == 600 ]] || fail ".env is readable by others after the update"
[[ $(as_root find "$dir/backups" -mindepth 1 -maxdepth 1 | wc -l) == 3 ]] || fail "the update made no backup first"
[[ $(users) == "$accounts" ]] || fail "the update lost data"
velydock status
velydock doctor > "$work/doctor2.out" || { cat "$work/doctor2.out" >&2; fail "doctor reports failures after the update"; }
grep -q "the latest release is $second" "$work/doctor2.out" || fail "doctor does not know the new version"
grep -q 'routing rules that are not part of release .*zz-other.yml' "$work/doctor2.out" || fail "doctor did not name the foreign routing file"
expect 0 'Nothing to do' velydock update --yes
expect 1 'is older than the installed' velydock update --version "$first" --yes

section "back to $first by hand, with the backup made before the update"
before_update=$(as_root find "$dir/backups" -mindepth 1 -maxdepth 1 | sort | tail -n1)
velydock admin --username dritte --email dritte@example.com >/dev/null
[[ $(users) == $((accounts + 1)) ]] || fail "velydock admin did not create the account that the restore is to take away"
expect 1 'no answer could be read' velydock restore "$before_update"
[[ $(users) == $((accounts + 1)) ]] || fail "a restore nobody confirmed changed data"
# docs/betrieb.md, "Zurück zur vorigen Version": program files, image, then the backup.
as_root cp -a "$dir/.previous/$first/." "$dir/"
as_root sed -i "s|^VELYDOCK_IMAGE=.*|VELYDOCK_IMAGE=$(as_root cat "$dir/.previous/$first.image")|" "$dir/.env"
velydock restore "$before_update" --yes
[[ $(as_root cat "$dir/VERSION") == "$first" ]] || fail "VERSION is not $first after going back"
[[ $(as_root stat -c %a "$dir/.env") == 600 ]] || fail ".env is readable by others after going back"
[[ $(docker inspect --format '{{.Config.Image}}' "$(container velydock)") == "$first_image" ]] || fail "velydock does not run $first_image after going back"
[[ $(users) == "$accounts" ]] || fail "after going back there are $(users) users instead of $accounts"
velydock status
expect 0 "version $first is installed, $second is available" velydock doctor

section "velydock update again: $first -> $second"
python3 -c 'import time; time.sleep(2)'
velydock update --yes > "$work/update2.out" 2>&1 || { cat "$work/update2.out" >&2; fail "the second update failed"; }
grep -q "Velydock was updated: $first -> $second" "$work/update2.out" || fail "the second update did not report $first -> $second"
[[ $(as_root cat "$dir/VERSION") == "$second" ]] || fail "VERSION is not $second after the second update"
[[ $(docker inspect --format '{{.Config.Image}}' "$(container velydock)") == "$second_image" ]] || fail "velydock does not run $second_image"
[[ $(users) == "$accounts" ]] || fail "the second update lost data"
velydock status

section "velydock restart, stop, uninstall (data stays), start"
velydock restart velydock
velydock stop
expect 1 'not ready' velydock status
expect 1 'nobody can be asked here' unattended_velydock uninstall
velydock uninstall --yes
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail "uninstall left containers"
[[ -n $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "uninstall removed the volumes"
as_root test -f "$dir/.env" || fail "uninstall removed .env"
if [[ $mode == system ]]; then
  [[ ! -e /usr/local/bin/velydock ]] || fail "uninstall left the command"
  [[ ! -e /etc/systemd/system/velydock-backup.timer ]] || fail "uninstall left the timer"
fi
# The installer brings the command and the timer back and still touches nothing else.
installer --lang en --yes "${install_options[@]}" > "$work/back.out" 2>&1 </dev/null || { cat "$work/back.out" >&2; fail "the installer failed on an uninstalled installation"; }
grep -q "Velydock $second is already installed" "$work/back.out" || fail "the installer did not recognise the uninstalled installation"
if [[ $mode == system ]]; then
  grep -q 'has been restored' "$work/back.out" || fail "the installer did not restore the command"
  systemctl is-active --quiet velydock-backup.timer || fail "the installer did not restore the timer"
fi
velydock start
velydock status
[[ $(users) == "$accounts" ]] || fail "data did not survive uninstall and start"

section "velydock uninstall --purge"
# A backup to another place first: the "new server" below is set up from it.
user_names() { docker exec "$(container postgres)" psql -U postgres -d velydock -Atc "SELECT string_agg(username, ',' ORDER BY username) FROM users"; }
old_names=$(user_names)
velydock backup "$work/offsite" >/dev/null
saved=$(as_root find "$work/offsite" -mindepth 1 -maxdepth 1 -name 'velydock-*Z')
as_root test -s "$saved/env" || fail "no backup outside the installation"
expect 1 'nobody can be asked here' unattended_velydock uninstall --purge
printf '%s\t%s\n' 'Type the host name of this installation \(dock\.itest\.localhost\) to continue: $' 'dock.example.com' > "$work/purge-steps"
status=0
python3 "$work/terminal.py" "$work/purge-steps" "${root[@]}" "${released[@]}" "$tool" uninstall --purge > "$work/purge.out" 2>&1 || status=$?
if [[ $status != 1 ]] || ! grep -q 'aborted; nothing was changed' "$work/purge.out"; then
  cat "$work/purge.out" >&2
  fail "a wrong host name did not stop the purge"
fi
[[ $(users) == "$accounts" ]] || fail "a purge that was not confirmed changed data"
velydock uninstall --purge --yes | tee "$work/purged.out"
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail "purge left containers"
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "purge left volumes"
[[ -z $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "purge left networks"
remains=$(as_root find "$dir" -mindepth 1 2>/dev/null | sort | tr '\n' ' ')
[[ $remains == "$dir/deploy $dir/deploy/traefik $dir/deploy/traefik/dynamic $dir/deploy/traefik/dynamic/zz-other.yml " ]] ||
  fail "after the purge the directory holds: $remains (expected only the file that is not Velydock's)"
grep -q "left in place" "$work/purged.out" || fail "purge did not say what it left in place"
grep -qF "$dir/deploy/traefik/dynamic/zz-other.yml" "$work/purged.out" || fail "purge did not name the file it left in place"
as_root test -s "$saved/velydock.dump" || fail "purge removed a backup outside the installation"
if [[ $mode == system ]]; then
  [[ ! -e /usr/local/bin/velydock ]] || fail "purge left the command"
  [[ ! -e /etc/systemd/system/velydock-backup.service ]] || fail "purge left the backup service"
fi
as_root rm -rf -- "$dir"

# ---- 6. a new server ---------------------------------------------------------------------------

section "a new server: fresh installation of $second, then the backup of the old one"
# docs/betrieb.md, "Wiederherstellung": install the version of the backup, throw the new and
# empty databases away, put the old .env in place, start, restore.
installer --lang en --yes "${install_options[@]}" --version "$second" --domain itest.localhost --tls selfsigned \
  --admin-user throwaway --admin-email throwaway@example.com --no-backup > "$work/new.out" 2>&1 </dev/null || {
  cat "$work/new.out" >&2
  fail "the installation on the new server failed"
}
[[ $(users) == 1 ]] || fail "expected one user on the new server"
new_secret=$(as_root grep '^VELYDOCK_SECRET_KEY=' "$dir/.env")
( cd "$dir" && as_root "${clean[@]}" docker compose down --volumes ) > "$work/down.out" 2>&1 || { cat "$work/down.out" >&2; fail "docker compose down --volumes"; }
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "the volumes of the new server are still there"
as_root install -m 600 "$saved/env" "$dir/.env"
[[ $(as_root grep '^VELYDOCK_SECRET_KEY=' "$dir/.env") != "$new_secret" ]] || fail "the old .env is not in place"
velydock start
velydock restore "$saved" --yes
[[ $(users) == "$accounts" ]] || fail "after the restore on the new server there are $(users) users instead of $accounts"
[[ $(user_names) == "$old_names" && $old_names == *"$admin"*zweite* ]] || fail "the accounts on the new server are $(user_names), on the old one they were $old_names"
[[ $(docker exec "$(container postgres)" psql -U postgres -d keycloak -Atc "SELECT count(*) FROM user_entity WHERE username = '$admin'") == 1 ]] ||
  fail "Keycloak on the new server does not know $admin"
velydock status
expect 0 ' 0 failures' velydock doctor
velydock uninstall --purge --yes >/dev/null
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail "purge left containers"
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "purge left volumes"
as_root test ! -e "$dir" || fail "purge left $dir"
started=0

# ---- 7. an own certificate from the first minute ------------------------------------------------

section "install.sh --yes --tls own: the installation is served with the given certificate"
# One certificate for every name of the installation; the installer checks it before anything
# starts, stores it once the stack runs, and nothing is fetched from anywhere.
make_cert firstminute 30 'DNS:*.itest.localhost,DNS:*.apps.itest.localhost'
started=1
installer --lang en --yes "${install_options[@]}" --version "$second" --domain itest.localhost --tls own \
  --cert "$certs/firstminute.pem" --key "$certs/firstminute.key" \
  --admin-user "$admin" --admin-email chef@example.com --no-backup > "$work/own.out" 2>&1 </dev/null || {
  cat "$work/own.out" >&2
  fail "the installation with an own certificate failed"
}
grep -q 'One-time password' "$work/own.out" || fail "the installation with an own certificate printed no one-time password"
as_root grep -qxF 'TLS_RESOLVER=' "$dir/.env" || fail "TLS_RESOLVER= is missing in .env (own certificate)"
if grep -qF -- "-----BEGIN" "$work/own.out"; then fail "the installer printed key or certificate material"; fi
wanted=$(openssl x509 -in "$certs/firstminute.pem" -noout -fingerprint -sha256)
for name in dock.itest.localhost auth.itest.localhost sandbox.itest.localhost apps.itest.localhost wiki.apps.itest.localhost; do
  found=""
  for _ in $(seq 1 60); do
    found=$(openssl s_client -connect "$https_endpoint" -servername "$name" </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null || true)
    [[ $found == "$wanted" ]] && break
    python3 -c 'import time; time.sleep(1)'
  done
  [[ $found == "$wanted" ]] || fail "$name is not served with the certificate given to the installer"
done
# Named after its first DNS name, as "velydock cert add" does without --name.
expect 0 'wildcard-itest-localhost' velydock cert list
expect 0 'dock.itest.localhost: certificate valid until' velydock doctor
# The key file given to the installer is not kept anywhere in the installation directory.
if as_root grep -rlF -- "$(sed -n 2p "$certs/firstminute.key")" "$dir" 2>/dev/null | grep -q .; then
  fail "the private key is in a file of the installation directory"
fi
echo "installed with an own certificate; all five names are served with it"
velydock uninstall --purge --yes >/dev/null
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail "purge left containers"
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] || fail "purge left volumes"
as_root test ! -e "$dir" || fail "purge left $dir"
started=0
