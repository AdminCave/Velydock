#!/usr/bin/env bash
# Installer test for what needs root on a fresh system, run in unprivileged containers.
#
#   ./scripts/tests/installer-system.sh [docker|system]        default: both parts
#
# docker   Docker is missing: "install.sh --install-docker" on debian:13 and ubuntu:24.04 sets
#          up Docker's apt repository and installs the packages. A container cannot start the
#          daemon, so the installer is expected to stop right after that and say so. This
#          shows that the packages install and that "docker --version" and "docker compose
#          version" answer - not that Docker runs.
#
# system   The installer as root on debian:13 with stand-ins for docker and systemctl: default
#          directory, /usr/local/bin/velydock, the unit files of the backup timer, the log in
#          /var/log, a second run, the three TLS modes in .env, a start that fails and the run
#          that continues it, update, uninstall, what the installer puts back afterwards, and
#          purge. No container of the stack is started here: scripts/tests/installer.sh does
#          that without root, and the CI job "Installer" does it as root with a real systemd.
#
# Needs network access (base images, Debian's and Docker's package repositories). Removes its
# containers and files also when it fails.
set -euo pipefail
export LC_ALL=C

repo=$(cd "$(dirname "$0")/../.." && pwd)
part=${1:-all}
case $part in
  all | docker | system) ;;
  *)
    echo "usage: $0 [docker|system]" >&2
    exit 2
    ;;
esac
prefix=velydock-itest-system
work=$(mktemp -d)

fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$? found
  trap - EXIT
  set +e
  found=$(docker ps -aq --filter "name=^$prefix-")
  # shellcheck disable=SC2086  # a list of IDs
  [[ -z $found ]] || docker rm -f -v $found >/dev/null 2>&1
  rm -rf -- "$work"
  if (( status == 0 )); then echo "OK: the installer's system parts passed ($part)."; fi
  exit "$status"
}
trap cleanup EXIT

# ---- Docker is missing -----------------------------------------------------------------------

# Asked on a terminal whether Docker may be installed, the answer is no: nothing happens.
docker_declined() {
  local image=$1 name output
  name=$prefix-declined-$(tr -c 'a-z0-9\n' '-' <<<"$image")
  printf '\n== Docker missing on %s, and the answer is no\n' "$image"
  output=$(docker run --rm --name "$name" -v "$repo/install.sh:/install.sh:ro" "$image" bash -c '
    printf "maybe\nn\n" | script -qec "bash /install.sh --lang en" /dev/null
    echo "installer status: $?"
    command -v docker || echo "docker: still missing"
    ls /etc/apt/sources.list.d/docker.sources 2>/dev/null || echo "repository: not set up"
  ' 2>&1 | tr -d '\r') || true
  printf '%s\n' "$output" | sed 's/^/  /'
  grep -q 'Install Docker Engine from Docker.s official repository (download.docker.com) now? \[Y/n\]' <<<"$output" || fail "$image: the question was not asked"
  grep -q 'Answer y or n' <<<"$output" || fail "$image: a wrong answer was not asked again"
  grep -q 'Without Docker nothing can be installed. Nothing was changed.' <<<"$output" || fail "$image: declining did not end the installer"
  grep -q '^installer status: 1$' <<<"$output" || fail "$image: unexpected exit status after declining"
  grep -q '^docker: still missing$' <<<"$output" || fail "$image: Docker was installed although declined"
  grep -q '^repository: not set up$' <<<"$output" || fail "$image: the repository was set up although declined"
}

# Where the installer cannot install Docker itself, it explains what is needed and stops.
docker_elsewhere() {
  local name=$prefix-elsewhere output
  printf '\n== Docker missing on a system that is neither Debian nor Ubuntu\n'
  output=$(docker run --rm --name "$name" -v "$repo/install.sh:/install.sh:ro" debian:13 bash -c '
    sed -i "s/^ID=.*/ID=fedora/" /etc/os-release
    bash /install.sh --lang en --yes --install-docker --domain itest.example --tls selfsigned --admin-email admin@example.com
    echo "installer status: $?"
    ls /etc/apt/sources.list.d/docker.sources 2>/dev/null || echo "repository: not set up"
  ' 2>&1) || true
  printf '%s\n' "$output" | sed 's/^/  /'
  grep -q 'Docker is not installed' <<<"$output" || fail "the missing Docker was not reported"
  grep -q 'https://docs.docker.com/engine/install/' <<<"$output" || fail "the installer did not explain how to get Docker"
  grep -q '^installer status: 1$' <<<"$output" || fail "unexpected exit status"
  grep -q '^repository: not set up$' <<<"$output" || fail "the repository was set up on a system that is not supported"
}

docker_missing() {
  local image=$1 name output
  name=$prefix-$(tr -c 'a-z0-9\n' '-' <<<"$image")
  printf '\n== Docker missing on %s\n' "$image"
  output=$(docker run --rm --name "$name" -v "$repo/install.sh:/install.sh:ro" "$image" bash -c '
    bash /install.sh --lang en --yes --install-docker --domain itest.example --tls selfsigned \
      --admin-email admin@example.com --no-backup
    echo "installer status: $?"
    echo "docker: $(docker --version 2>&1)"
    echo "compose: $(docker compose version 2>&1)"
    echo "repository: $(tr "\n" " " < /etc/apt/sources.list.d/docker.sources 2>&1)"
    echo "packages: $(dpkg-query -W -f "\${Package} " docker-ce docker-ce-cli containerd.io docker-compose-plugin 2>&1)"
    echo "log lines: $(grep -c . /var/log/velydock-install.log 2>&1)"
  ' 2>&1) || true
  printf '%s\n' "$output" | sed 's/^/  /'
  grep -q 'Docker is not installed; Docker Engine will be installed' <<<"$output" || fail "$image: the installer did not announce the Docker installation"
  grep -q 'Installing Docker Engine .*ok' <<<"$output" || fail "$image: Docker's packages did not install"
  grep -q 'Docker was installed, but its daemon does not answer' <<<"$output" || fail "$image: the installer did not stop at the daemon"
  grep -q '^installer status: 1$' <<<"$output" || fail "$image: unexpected exit status of the installer"
  grep -q '^docker: Docker version [0-9]' <<<"$output" || fail "$image: docker --version does not answer"
  grep -q '^compose: Docker Compose version v\?[0-9]' <<<"$output" || fail "$image: docker compose version does not answer"
  grep -q 'repository: .*URIs: https://download.docker.com/linux/' <<<"$output" || fail "$image: Docker's repository was not set up"
  grep -q 'Log: /var/log/velydock-install.log' <<<"$output" || fail "$image: the installer did not say where its log is"
}

# ---- system integration with stand-ins -------------------------------------------------------

system_parts() {
  local release=$work/release certs=$work/certs name=$prefix-debian-13
  printf '\n== system integration on debian:13 (stand-ins for docker and systemctl)\n'
  mkdir -p "$release/download" "$certs" "$work/stub"
  "$repo/scripts/make-bundle.sh" 0.1.0 example.invalid/velydock:0.1.0 "$release/download/v0.1.0" >/dev/null
  "$repo/scripts/make-bundle.sh" 0.1.1 example.invalid/velydock:0.1.1 "$release/download/v0.1.1" >/dev/null
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=test \
    -addext 'subjectAltName=DNS:*.itest.example' -keyout "$certs/wildcard.key" -out "$certs/wildcard.pem" 2>/dev/null

  # docker: answers what the installer and "velydock" ask, records every call.
  cat > "$work/stub/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> /state/docker.calls
case "$*" in
  "version --format {{.Server.Version}}") echo 29.0.0 ;;
  "compose version --short") echo 2.40.0 ;;
  "info --format {{.DockerRootDir}}") echo /var/lib/docker ;;
  "volume inspect "*) exit 1 ;;
  "compose config --services") printf '%s\n' keycloak postgres theme traefik velydock ;;
  "compose ps --all -q "*) echo "id-${*: -1}" ;;
  "inspect --format "*)
    case ${*: -1} in
      id-theme) echo 'exited||0|no' ;;
      id-traefik) echo 'running||0|unless-stopped' ;;
      *) echo 'running|healthy|0|unless-stopped' ;;
    esac
    ;;
  "compose up -d --wait"*)
    if [[ -e /state/fail-start ]]; then
      echo "stand-in: container velydock is unhealthy" >&2
      exit 1
    fi
    ;;
  *"cert add"*) cat > /state/cert.stdin ;;
  *setup-admin*) printf '\n  System administrator created: admin\n  One-time password:  stand-in-password\n\n' ;;
  *pg_dump*) echo "dump of ${*: -1}" ;;
esac
exit 0
STUB
  cat > "$work/stub/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> /state/systemctl.calls
exit 0
STUB
  chmod +x "$work/stub/docker" "$work/stub/systemctl"

  cat > "$work/inside.sh" <<'INSIDE'
#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}
note() { printf '  %s\n' "$*"; }

apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates openssl python3 >/dev/null 2>&1
mkdir -p /state /var/lib/docker /run/systemd/system /srv/release
install -m 755 /t/stub/docker /usr/local/bin/docker
install -m 755 /t/stub/systemctl /usr/local/bin/systemctl
cp -r /t/release/download /srv/release/download
latest() {
  rm -rf /srv/release/latest
  mkdir -p /srv/release/latest
  cp -r "/srv/release/download/v$1" /srv/release/latest/download
}
latest 0.1.0
python3 -m http.server 8000 --bind 127.0.0.1 --directory /srv/release >/dev/null 2>&1 &
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8000/latest/download/SHA256SUMS >/dev/null 2>&1 && break
  python3 -c 'import time; time.sleep(1)'
done
export VELYDOCK_RELEASE_BASE_URL=http://127.0.0.1:8000
installer() { curl -fsSL "$VELYDOCK_RELEASE_BASE_URL/latest/download/install.sh" | bash -s -- --lang en "$@"; }
answers=(--domain itest.example --admin-email admin@example.com)
calls() { grep -cxF -- "$1" /state/docker.calls || true; }

# The default directory holds something that is not Velydock: nothing is installed over it.
mkdir -p /opt/velydock
echo "not from Velydock" > /opt/velydock/notes.txt
status=0
installer --yes "${answers[@]}" --tls selfsigned > /state/occupied.out 2>&1 || status=$?
grep -q '/opt/velydock is not empty and holds no Velydock installation' /state/occupied.out || { cat /state/occupied.out; fail "an occupied directory was not refused"; }
[[ $status != 0 && $(ls -A /opt/velydock) == notes.txt && ! -e /usr/local/bin/velydock ]] || fail "a refused installation changed something"
rm -r /opt/velydock
note "a directory that holds something else is refused"

# A start that fails, and the run that continues the installation.
touch /state/fail-start
status=0
installer --yes "${answers[@]}" --tls selfsigned --backup-keep 3 > /state/failed.out 2>&1 || status=$?
[[ $status == 1 ]] || { cat /state/failed.out; fail "a failed start ended with status $status"; }
grep -q 'Velydock did not start' /state/failed.out || fail "the installer did not report the failed start"
grep -q 'stand-in: container velydock is unhealthy' /state/failed.out || fail "the installer did not show the end of the log"
grep -q 'Run the installer again to continue it, or remove what is there with: /usr/local/bin/velydock uninstall --purge' /state/failed.out ||
  { cat /state/failed.out; fail "the installer did not say how to go on"; }
grep -q 'Log: /var/log/velydock-install.log' /state/failed.out || fail "the installer did not say where the log is"
[[ -f /opt/velydock/.install-state && -f /opt/velydock/.env && -x /usr/local/bin/velydock ]] || fail "state after a failed start"
first_env=$(sha256sum /opt/velydock/.env)
rm /state/fail-start
installer --yes --domain other.example --admin-email other@example.com --tls selfsigned > /state/continued.out 2>&1 ||
  { cat /state/continued.out; fail "continuing the installation failed"; }
grep -q 'The installation of Velydock 0.1.0 in /opt/velydock did not finish. It is continued' /state/continued.out ||
  { cat /state/continued.out; fail "the second run did not continue the first"; }
[[ $(sha256sum /opt/velydock/.env) == "$first_env" ]] || fail "continuing the installation rewrote .env"
grep -q 'One-time password  *stand-in-password' /state/continued.out || fail "no one-time password after continuing"
[[ ! -e /opt/velydock/.install-state ]] || fail "the state file is still there after continuing"
[[ $(calls 'compose exec -T velydock velydock setup-admin --username admin --email admin@example.com') == 1 ]] ||
  fail "the administrator of the first run's answers was not created exactly once"
note "a failed start is reported with the log, and the next run continues with the first run's answers"

# What the installation left on the system.
[[ $(stat -c %a /opt/velydock/.env) == 600 ]] || fail ".env is readable by others"
[[ $(stat -c %a /opt/velydock) == 755 ]] || fail "/opt/velydock has mode $(stat -c %a /opt/velydock)"
grep -qxF 'TLS_RESOLVER=' /opt/velydock/.env || fail "self-signed: TLS_RESOLVER= is missing"
grep -qxF 'VELYDOCK_IMAGE=example.invalid/velydock:0.1.0' /opt/velydock/.env || fail ".env does not name the bundle's image"
grep -qxF 'VELYDOCK_BACKUP_DIR=/opt/velydock/backups' /opt/velydock/.env || fail ".env lacks the backup directory"
if grep -q '^COMPOSE_PROJECT_NAME=\|^HTTP_BIND=\|^PUBLIC_PORT_SUFFIX=' /opt/velydock/.env; then fail ".env holds settings nobody asked for"; fi
[[ $(/usr/local/bin/velydock version | head -n1) == "Velydock 0.1.0" ]] || fail "the command in /usr/local/bin does not answer"
grep -qxF "exec '/opt/velydock/scripts/velydock' \"\$@\"" /usr/local/bin/velydock || fail "the launcher does not run the copy in /opt/velydock"
grep -qxF 'ExecStart=/opt/velydock/scripts/velydock backup' /etc/systemd/system/velydock-backup.service || fail "the backup service"
grep -q '^OnCalendar=' /etc/systemd/system/velydock-backup.timer || fail "the backup timer"
grep -qxF 'daemon-reload' /state/systemctl.calls || fail "systemctl daemon-reload was not called"
grep -qxF 'enable --now velydock-backup.timer' /state/systemctl.calls || fail "the timer was not enabled"
[[ $(stat -c %a /var/log/velydock-install.log) == 600 ]] || fail "the log is readable by others"
if grep -q 'stand-in-password' /var/log/velydock-install.log; then fail "the one-time password is in the log"; fi
while IFS='=' read -r key value; do
  [[ $key =~ (PASSWORD|SECRET|KEY)$ && -n $value ]] || continue
  if grep -qF -- "$value" /var/log/velydock-install.log /state/continued.out /state/failed.out; then fail "the value of $key was printed or logged"; fi
done < /opt/velydock/.env
[[ $(calls 'compose pull --quiet') -ge 1 ]] || fail "the images were not pulled"
note "directory, .env, launcher, unit files and log are as documented; no secret in output or log"

# A second run changes nothing.
installer --yes "${answers[@]}" --tls selfsigned > /state/again.out 2>&1 || fail "the second run failed"
grep -q 'Velydock 0.1.0 is already installed in /opt/velydock' /state/again.out || fail "the second run did not report the installation"
[[ $(sha256sum /opt/velydock/.env) == "$first_env" ]] || fail "the second run changed .env"
# Neither does a run that asks for another directory while the command belongs to this one.
status=0
installer --yes "${answers[@]}" --tls selfsigned --dir /srv/second > /state/second.out 2>&1 || status=$?
grep -q '/usr/local/bin/velydock already belongs to another Velydock installation (/opt/velydock)' /state/second.out ||
  { cat /state/second.out; fail "a second installation was not refused"; }
[[ $status == 1 && ! -e /srv/second ]] || fail "a refused second installation left something behind"
note "a second run reports the installation; a second installation is refused"

# Backup through the command, and the update.
velydock backup >/dev/null
[[ -n $(find /opt/velydock/backups -maxdepth 1 -name 'velydock-*Z' -type d) ]] || fail "velydock backup wrote nothing"
latest 0.1.1
# With stand-ins everything takes no time, and two backups cannot be made in the same second.
python3 -c 'import time; time.sleep(2)'
velydock update --yes --no-backup > /state/update.out 2>&1 || { cat /state/update.out; fail "the update failed"; }
grep -q 'Velydock was updated: 0.1.0 -> 0.1.1' /state/update.out || fail "the update did not report 0.1.0 -> 0.1.1"
grep -q 'no backup before this update' /state/update.out || fail "--no-backup was not announced"
[[ $(velydock version | head -n1) == "Velydock 0.1.1" ]] || fail "the command does not answer as 0.1.1 after the update"
grep -qxF 'VELYDOCK_IMAGE=example.invalid/velydock:0.1.1' /opt/velydock/.env || fail "the update did not set the image"
[[ -f /opt/velydock/.previous/0.1.0/scripts/velydock && $(cat /opt/velydock/.previous/0.1.0.image) == example.invalid/velydock:0.1.0 ]] ||
  fail "the previous version was not kept"
[[ $(find /opt/velydock/backups -maxdepth 1 -name 'velydock-*Z' -type d | wc -l) == 1 ]] || fail "update --no-backup made a backup"
note "update 0.1.0 -> 0.1.1 through /usr/local/bin/velydock, without a backup when told so"

# Uninstall takes the command and the timer away; the installer puts them back.
velydock uninstall --yes >/dev/null
[[ ! -e /usr/local/bin/velydock && ! -e /etc/systemd/system/velydock-backup.timer && ! -e /etc/systemd/system/velydock-backup.service ]] ||
  fail "uninstall left the command or the timer"
grep -qxF 'disable --now velydock-backup.timer' /state/systemctl.calls || fail "uninstall did not disable the timer"
[[ -f /opt/velydock/.env && -d /opt/velydock/backups ]] || fail "uninstall removed configuration or backups"
installer --yes > /state/back.out 2>&1 || { cat /state/back.out; fail "the installer failed on an uninstalled installation"; }
grep -q 'The command /usr/local/bin/velydock was missing and has been restored' /state/back.out || fail "the command was not restored"
grep -q 'The backup timer was missing and has been restored' /state/back.out || fail "the timer was not restored"
[[ -x /usr/local/bin/velydock && -f /etc/systemd/system/velydock-backup.timer ]] || fail "command and timer are not back"
[[ $(sha256sum /opt/velydock/.env | cut -d' ' -f1) != "" && $(velydock version | head -n1) == "Velydock 0.1.1" ]] || fail "after restoring"
note "uninstall removes command and timer and keeps the data; the installer restores both"

# A command of that name that is not ours is left alone.
velydock uninstall --purge --yes > /state/purge.out
[[ ! -e /opt/velydock && ! -e /usr/local/bin/velydock && ! -e /etc/systemd/system/velydock-backup.service ]] ||
  { cat /state/purge.out; ls -la /opt/velydock; fail "purge left something behind"; }
[[ $(calls 'compose down --volumes') == 1 ]] || fail "purge did not remove the volumes"
printf '#!/bin/sh\necho mine\n' > /usr/local/bin/velydock
chmod 755 /usr/local/bin/velydock
latest 0.1.0

# Own certificate: checked before the start, imported after it, through the contract.
: > /state/docker.calls
installer --yes "${answers[@]}" --tls own --cert /t/certs/wildcard.pem --key /t/certs/wildcard.key --no-backup > /state/own.out 2>&1 ||
  { cat /state/own.out; fail "the installation with an own certificate failed"; }
grep -q '/usr/local/bin/velydock exists and is not from Velydock; it was left alone' /state/own.out || fail "a foreign command was not reported"
[[ $(cat /usr/local/bin/velydock) == *"echo mine"* ]] || fail "a foreign command was overwritten"
grep -qxF 'TLS_RESOLVER=' /opt/velydock/.env || fail "own: TLS_RESOLVER= is missing"
grep -qxF 'compose exec -T velydock velydock cert add --name wildcard-itest-example --replace' /state/docker.calls ||
  { cat /state/docker.calls; fail "the certificate was not imported through the contract"; }
up_line=$(grep -n '^compose up -d --wait' /state/docker.calls | head -n1 | cut -d: -f1)
cert_line=$(grep -n 'cert add' /state/docker.calls | head -n1 | cut -d: -f1)
admin_line=$(grep -n 'setup-admin' /state/docker.calls | head -n1 | cut -d: -f1)
(( up_line < cert_line && cert_line < admin_line )) || fail "order: start, certificate, administrator"
openssl x509 -in /state/cert.stdin -noout && openssl pkey -in /state/cert.stdin -noout || fail "the PEM stream does not hold certificate and key"
[[ ! -e /etc/systemd/system/velydock-backup.timer ]] || fail "--no-backup installed a timer"
if grep -q '^VELYDOCK_BACKUP_' /opt/velydock/.env; then fail "--no-backup wrote backup settings"; fi
/opt/velydock/scripts/velydock uninstall --purge --yes >/dev/null
[[ $(cat /usr/local/bin/velydock) == *"echo mine"* ]] || fail "purge removed a command that is not ours"
rm /usr/local/bin/velydock
note "own certificate: imported after the start, before the administrator; a foreign command is left alone"

# Let's Encrypt: the resolver stays at its default, the address is recorded.
installer --yes "${answers[@]}" --acme-email hostmaster@example.com --apps-host - --backup-dir /srv/backups \
  --image mirror.example.invalid/velydock:0.1.0 > /state/acme.out 2>&1 ||
  { cat /state/acme.out; fail "the installation with Let's Encrypt failed"; }
grep -qxF 'VELYDOCK_IMAGE=mirror.example.invalid/velydock:0.1.0' /opt/velydock/.env || fail "--image is not in .env"
if grep -q '^TLS_RESOLVER' /opt/velydock/.env; then fail "letsencrypt: TLS_RESOLVER must not be set"; fi
grep -qxF 'ACME_EMAIL=hostmaster@example.com' /opt/velydock/.env || fail "letsencrypt: ACME_EMAIL is missing"
grep -qxF 'APPS_HOST=' /opt/velydock/.env || fail "--apps-host - did not switch the apps host off"
grep -qxF 'VELYDOCK_BACKUP_DIR=/srv/backups' /opt/velydock/.env || fail "--backup-dir is not in .env"
velydock backup >/dev/null
[[ -n $(find /srv/backups -maxdepth 1 -name 'velydock-*Z' -type d) ]] || fail "the backup did not go to --backup-dir"
velydock uninstall --purge --yes > /state/purge2.out
grep -q 'Backups outside the installation directory were not touched: /srv/backups' /state/purge2.out || fail "purge did not name the outside backups"
[[ ! -e /opt/velydock && -n $(find /srv/backups -maxdepth 1 -name 'velydock-*Z' -type d) ]] || fail "purge and the outside backups"
note "Let's Encrypt: resolver left at its default; backups outside the directory survive a purge"

# A start that fails can also be answered with a purge instead of a second run.
touch /state/fail-start
installer --yes "${answers[@]}" --tls selfsigned > /state/failed2.out 2>&1 && fail "a failed start was reported as a success"
[[ -f /opt/velydock/.install-state ]] || fail "no state file after the failed start"
velydock uninstall --purge --yes > /state/purge3.out || { cat /state/purge3.out; fail "purge after a failed start"; }
[[ ! -e /opt/velydock && ! -e /usr/local/bin/velydock ]] || fail "purge after a failed start left something behind"
rm /state/fail-start
note "an installation that did not finish can be removed with uninstall --purge"
INSIDE

  docker run --rm --name "$name" -v "$work:/t:ro" debian:13 bash /t/inside.sh
}

if [[ $part == all || $part == system ]]; then system_parts; fi
if [[ $part == all || $part == docker ]]; then
  docker_declined debian:13
  docker_elsewhere
  docker_missing debian:13
  docker_missing ubuntu:24.04
fi
