#!/usr/bin/env bash
# Builds the files of a release: everything a server needs besides the container images.
#
#   scripts/make-bundle.sh <version> <image-ref> <out-dir>
#
#   <version>     1.2.3 or 1.2.3-rc.1 (a leading "v" is dropped)
#   <image-ref>   the image this version runs; the release workflow passes it with its digest
#                 (ghcr.io/admincave/velydock:1.2.3@sha256:...)
#   <out-dir>     created if missing; receives the three files of a release:
#                   velydock-<version>.tar.gz   the bundle
#                   install.sh                  the installer, as it lies in the repository
#                   SHA256SUMS                  checksums of the two
#
# The bundle unpacks to velydock-<version>/ with:
#
#   docker-compose.yml, docker-compose.keycloak-admin.yml, deploy/, LICENSE
#   scripts/velydock, scripts/backup.sh, scripts/restore.sh
#   VERSION    the version
#   IMAGE      one line: the image reference
#   MANIFEST   sha256sum lines for every other file; install.sh and "velydock update" copy
#              exactly the files it names
#
# Only files tracked by git are taken, with the content of the working tree: a file somebody
# else dropped into deploy/ never ends up in a release. The release workflow and the tests
# (scripts/tests/installer.sh) both build their release with this script.
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <version> <image-ref> <out-dir>" >&2
  exit 2
fi
version=${1#v}
image=$2
out=$3

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "error: '$version' is not a version (1.2.3 or 1.2.3-rc.1)." >&2
  exit 2
fi
if [[ ! $image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; then
  echo "error: '$image' is not an image reference." >&2
  exit 2
fi
[[ $out == /* ]] || out=${PWD%/}/$out

cd "$(dirname "$0")/.."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "error: the bundle is built from a git checkout (it takes the tracked files)." >&2
  exit 1
}

content=(docker-compose.yml docker-compose.keycloak-admin.yml LICENSE deploy
  scripts/velydock scripts/backup.sh scripts/restore.sh)

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
root=$work/velydock-$version
mkdir -p "$root"

count=0
while IFS= read -r -d '' entry; do
  # "100755 <object> 0<TAB>path": the mode git records decides between 755 and 644.
  mode=${entry%% *}
  path=${entry#*$'\t'}
  if [[ ! $path =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
    echo "error: '$path' cannot go into a bundle (letters, digits, '.', '_' and '-' only)." >&2
    exit 1
  fi
  [[ -f $path && ! -L $path ]] || { echo "error: $path is not a regular file." >&2; exit 1; }
  mkdir -p "$root/$(dirname "$path")"
  if [[ $mode == 100755 ]]; then
    install -m 755 "$path" "$root/$path"
  else
    install -m 644 "$path" "$root/$path"
  fi
  count=$((count + 1))
done < <(git ls-files -s -z -- "${content[@]}")

for path in docker-compose.yml LICENSE scripts/velydock scripts/backup.sh scripts/restore.sh \
  deploy/postgres/init-databases.sh deploy/traefik/dynamic/velydock.yml; do
  [[ -f $root/$path ]] || { echo "error: $path is missing or not tracked by git." >&2; exit 1; }
done

printf '%s\n' "$version" > "$root/VERSION"
printf '%s\n' "$image" > "$root/IMAGE"
chmod 644 "$root/VERSION" "$root/IMAGE"
find "$root" -type d -exec chmod 755 {} +
( cd "$root" && find . -type f -printf '%P\0' | sort -z | xargs -0 sha256sum ) > "$work/MANIFEST"
install -m 644 "$work/MANIFEST" "$root/MANIFEST"

# The same input gives the same archive: fixed order, owner and time stamps.
stamp=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
mkdir -p "$out"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$stamp" \
  -C "$work" -cf - "velydock-$version" | gzip -n -9 > "$out/velydock-$version.tar.gz"

install -m 755 install.sh "$out/install.sh"
( cd "$out" && sha256sum install.sh "velydock-$version.tar.gz" > SHA256SUMS )

echo "$out: velydock-$version.tar.gz ($((count + 3)) files, image $image), install.sh, SHA256SUMS"
