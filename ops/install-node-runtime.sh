#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

version="22.23.1"
platform="linux-x64"
archive="node-v${version}-${platform}.tar.xz"
sha256="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
base="/opt/brain/runtime"
destination="$base/node-v${version}-${platform}"
temporary="$(mktemp -d /tmp/brain-node-runtime.XXXXXX)"

cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

if [[ "$(id -u)" != "0" ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "unsupported architecture: $(uname -m)" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "unsupported operating system: $(uname -s)" >&2
  exit 1
fi
command -v flock >/dev/null

install -d -o root -g root -m 0755 "$base"
exec 9>"$base/.install.lock"
if ! flock -w 120 9; then
  echo "timed out waiting for the Brain runtime installation lock" >&2
  exit 75
fi
if [[ ! -d "$destination" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v${version}/${archive}" \
    --output "$temporary/$archive"
  printf '%s  %s\n' "$sha256" "$temporary/$archive" | sha256sum --check --status
  tar -xJf "$temporary/$archive" -C "$temporary"
  chown -R root:root "$temporary/node-v${version}-${platform}"
  chmod -R go-w "$temporary/node-v${version}-${platform}"
  chmod 0755 "$temporary/node-v${version}-${platform}"
  mv "$temporary/node-v${version}-${platform}" "$destination"
fi

chmod 0755 "$base" "$destination"
test -x "$destination/bin/node"
installed_version="$("$destination/bin/node" --version)"
if [[ "$installed_version" != "v$version" ]]; then
  echo "unexpected Node runtime version: $installed_version" >&2
  exit 1
fi

candidate="$base/.current-${version}"
rm -f -- "$candidate"
ln -s "$destination" "$candidate"
mv -Tf "$candidate" "$base/current"
"$base/current/bin/node" --version
