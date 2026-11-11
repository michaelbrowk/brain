#!/usr/bin/env bash
set -euo pipefail

verify_rg() {
  rg --version
  printf '%s\n' 'brain-runtime-search' | rg --fixed-strings --line-regexp --quiet 'brain-runtime-search'
}

if command -v rg >/dev/null 2>&1; then
  verify_rg
  exit 0
fi

# The three workflows pin an x64 Ubuntu runner. Fetch its standalone upstream
# binary instead of depending on an Ubuntu mirror just to run the search gate.
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'ripgrep bootstrap requires Linux x86_64 when rg is not installed' >&2
  exit 1
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required for the CI ripgrep bootstrap}"
: "${GITHUB_PATH:?GITHUB_PATH is required for the CI ripgrep bootstrap}"
workspace="$(mktemp -d "$RUNNER_TEMP/brain-rg.XXXXXX")"
trap 'rm -rf -- "$workspace"' EXIT
version=15.1.0
package="ripgrep-${version}-x86_64-unknown-linux-musl"
archive="$workspace/$package.tar.gz"
checksum=1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599
curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 120 \
  "https://github.com/BurntSushi/ripgrep/releases/download/$version/$package.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$workspace" "$package/rg"
install_dir="$RUNNER_TEMP/brain-runtime-search/bin"
mkdir -p "$install_dir"
install -m 0755 "$workspace/$package/rg" "$install_dir/rg"
export PATH="$install_dir:$PATH"
verify_rg
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
