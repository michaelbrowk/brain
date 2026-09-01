#!/usr/bin/env bash
set -euo pipefail

key_dir=/etc/brain
key_path="$key_dir/brain-mail-account.key"
temp_path=

cleanup() {
  if [[ -n "$temp_path" && -e "$temp_path" ]]; then
    rm -f -- "$temp_path"
  fi
}
trap cleanup EXIT

if [[ "$(id -u)" != 0 ]]; then
  echo "brain-mail key creation requires root" >&2
  exit 1
fi
if [[ -e "$key_path" || -L "$key_path" ]]; then
  echo "brain-mail key already exists; refusing to overwrite or rotate it" >&2
  exit 1
fi
if [[ ! -d "$key_dir" || -L "$key_dir" ]]; then
  echo "brain-mail key directory is unsafe" >&2
  exit 1
fi
if [[ "$(stat -c '%u' "$key_dir")" != "0" ]]; then
  echo "brain-mail key directory ownership is unsafe" >&2
  exit 1
fi
if (( 8#$(stat -c '%a' "$key_dir") & 8#022 )); then
  echo "brain-mail key directory is writable by another identity" >&2
  exit 1
fi

umask 077
temp_path="$(mktemp "$key_dir/.brain-mail-account.key.XXXXXXXX")"
dd if=/dev/urandom of="$temp_path" bs=32 count=1 status=none conv=notrunc
chown root:root "$temp_path"
chmod 0400 "$temp_path"
test "$(stat -c '%s:%u:%g:%a' "$temp_path")" = "32:0:0:400"
sync -f "$temp_path"

# A hard-link publish is atomic and fails if another operator won the race.
ln "$temp_path" "$key_path"
rm -f -- "$temp_path"
temp_path=
sync -f "$key_dir"
test "$(stat -c '%s:%u:%g:%a:%h' "$key_path")" = "32:0:0:400:1"

echo "brain-mail wrapping key created; service and socket remain disabled"
