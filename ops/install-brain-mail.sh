#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

if [[ $# != 1 ]]; then
  echo "usage: install-brain-mail.sh /opt/brain/releases/<release>/brain-mail-ops" >&2
  exit 2
fi

source_dir="$1"
install_root="${BRAIN_MAIL_INSTALL_ROOT:-/}"
sandbox=false
if [[ "$install_root" != / ]]; then
  sandbox=true
fi

if [[ "$sandbox" == false && "$EUID" != 0 ]]; then
  echo "brain-mail installation requires root" >&2
  exit 1
fi
if [[ ! "$install_root" = /* || -L "$install_root" || ! -d "$install_root" ]]; then
  echo "brain-mail install root is unsafe" >&2
  exit 1
fi
install_root="$(cd "$install_root" && pwd -P)"
if [[ "$install_root" != / ]]; then
  install_root="${install_root%/}"
fi
if [[ ! "$source_dir" = /* || -L "$source_dir" || ! -d "$source_dir" ]]; then
  echo "brain-mail ops source is unsafe" >&2
  exit 1
fi
source_dir="$(cd "$source_dir" && pwd -P)"
if [[ "$sandbox" == false ]]; then
  release_dir="$(dirname "$source_dir")"
  if [[ "$(basename "$source_dir")" != brain-mail-ops || \
    "$(dirname "$release_dir")" != /opt/brain/releases ]]; then
    echo "brain-mail ops must be a direct child of one immutable release" >&2
    exit 1
  fi
fi

for command in \
  awk basename cat chmod chown date dirname find flock grep id install kill mkdir mv \
  readlink rm sed sha256sum sort stat sync touch; do
  command -v "$command" >/dev/null || {
    echo "$command is required before installing Brain Mail" >&2
    exit 1
  }
done
if [[ "$sandbox" == false ]]; then
  for command in getent systemctl systemd-analyze systemd-sysusers systemd-tmpfiles; do
    command -v "$command" >/dev/null || {
      echo "$command is required before installing Brain Mail" >&2
      exit 1
    }
  done
  if systemctl is-active --quiet brain-mail.service || \
    systemctl is-active --quiet brain-mail.socket || \
    systemctl is-active --quiet brain-mail-mime.socket || \
    systemctl is-enabled --quiet brain-mail.service || \
    systemctl is-enabled --quiet brain-mail.socket || \
    systemctl is-enabled --quiet brain-mail-mime.socket; then
    echo "stop and disable Brain Mail before installation" >&2
    exit 1
  fi
  if ! getent passwd brain >/dev/null || [[ "$(id -u brain)" == 0 ]]; then
    echo "the existing unprivileged brain service identity is required" >&2
    exit 1
  fi
fi

relative_sources=(
  brain-mail.service
  brain-mail.socket
  brain-mail-mime.socket
  brain-mail-mime@.service
  brain-mail.sysusers.conf
  brain-mail-mime.sysusers.conf
  brain-mail.tmpfiles.conf
  brain-mail-mime.tmpfiles.conf
  project_mail_runtime.py
  create-brain-mail-key.sh
  brain-mail-state-rollback.py
  install-brain-mail.sh
  rollback-brain-mail-install.sh
  brain.service.d/90-brain-mail-client.conf
  mail-account-connect-operations.md
  brain-mail.service.d/90-smtp-egress.conf.example
  mail-egress-operations.md
)
relative_destinations=(
  etc/systemd/system/brain-mail.service
  etc/systemd/system/brain-mail.socket
  etc/systemd/system/brain-mail-mime.socket
  etc/systemd/system/brain-mail-mime@.service
  usr/lib/sysusers.d/brain-mail.conf
  usr/lib/sysusers.d/brain-mail-mime.conf
  usr/lib/tmpfiles.d/brain-mail.conf
  usr/lib/tmpfiles.d/brain-mail-mime.conf
  opt/brain/bin/project_mail_runtime.py
  opt/brain/bin/create-brain-mail-key.sh
  opt/brain/bin/brain-mail-state-rollback.py
  opt/brain/bin/install-brain-mail.sh
  opt/brain/bin/rollback-brain-mail-install.sh
  etc/systemd/system/brain.service.d/90-brain-mail-client.conf
  opt/brain/share/mail-account-connect-operations.md
  opt/brain/share/brain-mail.service.d/90-smtp-egress.conf.example
  opt/brain/share/mail-egress-operations.md
)
modes=(0644 0644 0644 0644 0644 0644 0644 0644 0755 0755 0755 0755 0755 0644 0644 0644 0644)

expected_listing="$({
  printf '%s|f\n' "${relative_sources[@]}"
  printf '%s\n' \
    'MANIFEST.sha256|f' \
    'brain.service.d|d' \
    'brain-mail.service.d|d'
} | LC_ALL=C sort)"
actual_listing="$(
  cd "$source_dir"
  find . -mindepth 1 -printf '%P|%y\n' | LC_ALL=C sort
)"
if [[ "$actual_listing" != "$expected_listing" ]]; then
  echo "brain-mail ops allowlist mismatch" >&2
  exit 1
fi
expected_manifest_names="$(printf '%s\n' "${relative_sources[@]}" | LC_ALL=C sort)"
actual_manifest_names="$(awk 'NF == 2 { print $2 }' "$source_dir/MANIFEST.sha256" | LC_ALL=C sort)"
if [[ "$actual_manifest_names" != "$expected_manifest_names" ]]; then
  echo "brain-mail ops manifest file list mismatch" >&2
  exit 1
fi
if ! (cd "$source_dir" && sha256sum --strict -c MANIFEST.sha256 >/dev/null); then
  echo "brain-mail ops manifest verification failed" >&2
  exit 1
fi

trusted_uid="$EUID"
trusted_gid="$(id -g)"
if [[ "$sandbox" == false ]]; then
  trusted_uid=0
  trusted_gid=0
fi
assert_trusted_directory() {
  local directory="$1"
  local metadata owner mode
  if [[ ! -d "$directory" || -L "$directory" || \
    "$(readlink -f "$directory")" != "$directory" ]]; then
    echo "$directory is not a trusted real directory" >&2
    exit 1
  fi
  metadata="$(stat -c '%u:%a' "$directory")"
  IFS=: read -r owner mode <<<"$metadata"
  if [[ "$owner" != "$trusted_uid" || $((8#$mode & 8#022)) != 0 ]]; then
    echo "$directory ownership or mode is unsafe" >&2
    exit 1
  fi
}
assert_trusted_file() {
  local file="$1"
  local metadata owner mode links
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "$file is not a trusted regular file" >&2
    exit 1
  fi
  metadata="$(stat -c '%u:%a:%h' "$file")"
  IFS=: read -r owner mode links <<<"$metadata"
  if [[ "$owner" != "$trusted_uid" || "$links" != 1 || \
    $((8#$mode & 8#022)) != 0 ]]; then
    echo "$file ownership, mode, or link count is unsafe" >&2
    exit 1
  fi
}
assert_trusted_directory "$source_dir"
if [[ "$sandbox" == false ]]; then
  for directory in /opt /opt/brain /opt/brain/releases "$release_dir"; do
    assert_trusted_directory "$directory"
  done
fi
for relative in "${relative_sources[@]}" MANIFEST.sha256; do
  assert_trusted_file "$source_dir/$relative"
done

root_path() {
  if [[ "$install_root" == / ]]; then
    printf '/%s' "$1"
  else
    printf '%s/%s' "$install_root" "$1"
  fi
}

assert_destination_parent() {
  local destination="$1"
  local parent existing_parent
  parent="$(dirname "$destination")"
  existing_parent="$parent"
  while [[ ! -e "$existing_parent" && ! -L "$existing_parent" ]]; do
    existing_parent="$(dirname "$existing_parent")"
  done
  assert_trusted_directory "$existing_parent"
  if [[ -e "$parent" || -L "$parent" ]]; then
    assert_trusted_directory "$parent"
  fi
}

assert_trusted_directory "$install_root"
for relative in "${relative_destinations[@]}"; do
  assert_destination_parent "$(root_path "$relative")"
done

lock_file="$(root_path run/brain-mail-install.lock)"
mkdir -p -- "$(dirname "$lock_file")"
assert_trusted_directory "$(dirname "$lock_file")"
if [[ -e "$lock_file" || -L "$lock_file" ]]; then
  assert_trusted_file "$lock_file"
else
  install -m 0600 /dev/null "$lock_file"
fi
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "another Brain Mail install or rollback is running" >&2
  exit 1
fi

temp_path=
cleanup() {
  if [[ -n "$temp_path" && -e "$temp_path" && ! -L "$temp_path" ]]; then
    rm -f -- "$temp_path"
  fi
}
trap cleanup EXIT

transactions_root="$(root_path var/lib/brain-mail-install-transactions)"
mkdir -p -- "$transactions_root"
chmod 0700 "$transactions_root"
assert_trusted_directory "$transactions_root"

# A killed install or rollback must be recovered before a new transaction can
# obscure which bytes belong to which release.
while IFS= read -r -d '' existing_transaction; do
  if [[ ! -d "$existing_transaction" || -L "$existing_transaction" ]]; then
    echo "unsafe entry in the Brain Mail transaction directory" >&2
    exit 1
  fi
  assert_trusted_directory "$existing_transaction"
  if [[ "$(basename "$existing_transaction")" == *.preparing ]]; then
    echo "an interrupted Brain Mail preparation requires operator cleanup: $existing_transaction" >&2
    exit 1
  fi
  if [[ ! -f "$existing_transaction/PREPARED" ]]; then
    echo "an incomplete Brain Mail transaction requires recovery: $existing_transaction" >&2
    exit 1
  fi
  if [[ -f "$existing_transaction/ROLLED_BACK" ]]; then
    continue
  fi
  if [[ ! -f "$existing_transaction/COMMITTED" ]] || \
    find "$existing_transaction" -maxdepth 1 -type f \
      \( -name '*.RESTORING' -o -name '*.RESTORED' \) -print -quit | grep -q .; then
    echo "an incomplete Brain Mail transaction requires rollback: $existing_transaction" >&2
    exit 1
  fi
done < <(find "$transactions_root" -mindepth 1 -maxdepth 1 -print0)

transaction_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
transaction="$transactions_root/$transaction_id"
preparing="$transaction.preparing"
mkdir -m 0700 -- "$preparing"
printf '%s\n' "$source_dir" >"$preparing/SOURCE"
printf '%s\n' "$install_root" >"$preparing/INSTALL_ROOT"
chmod 0600 "$preparing/SOURCE" "$preparing/INSTALL_ROOT"
sync -f "$preparing/SOURCE"
sync -f "$preparing/INSTALL_ROOT"
install -m 0500 "$source_dir/rollback-brain-mail-install.sh" \
  "$preparing/rollback-recovery.sh"
(
  cd "$preparing"
  sha256sum rollback-recovery.sh >RECOVERY.sha256
)
printf '%s:%s:500\n' "$trusted_uid" "$trusted_gid" \
  >"$preparing/RECOVERY.metadata"
chmod 0600 "$preparing/RECOVERY.sha256" "$preparing/RECOVERY.metadata"
sync -f "$preparing/rollback-recovery.sh"
sync -f "$preparing/RECOVERY.sha256"
sync -f "$preparing/RECOVERY.metadata"
evidence_names=(
  SOURCE
  INSTALL_ROOT
  rollback-recovery.sh
  RECOVERY.sha256
  RECOVERY.metadata
)

owner_args=()
if [[ "$sandbox" == false ]]; then
  owner_args=(-o root -g root)
fi

write_prepared_file() {
  local file="$1"
  chmod 0600 "$file"
  sync -f "$file"
}

for index in "${!relative_sources[@]}"; do
  source_file="$source_dir/${relative_sources[$index]}"
  destination="$(root_path "${relative_destinations[$index]}")"
  sha256sum "$source_file" | awk '{print $1}' >"$preparing/$index.installed.sha256"
  printf '%s:%s:%s\n' \
    "$trusted_uid" "$trusted_gid" "${modes[$index]#0}" \
    >"$preparing/$index.installed.metadata"
  write_prepared_file "$preparing/$index.installed.sha256"
  write_prepared_file "$preparing/$index.installed.metadata"
  evidence_names+=(
    "$index.installed.sha256"
    "$index.installed.metadata"
  )
  if [[ -e "$destination" || -L "$destination" ]]; then
    assert_trusted_file "$destination"
    install -m 0600 "$destination" "$preparing/$index.backup"
    stat -c '%u:%g:%a' "$destination" >"$preparing/$index.original.metadata"
    sha256sum "$preparing/$index.backup" | awk '{print $1}' \
      >"$preparing/$index.original.sha256"
    touch "$preparing/$index.present"
    write_prepared_file "$preparing/$index.backup"
    write_prepared_file "$preparing/$index.original.metadata"
    write_prepared_file "$preparing/$index.original.sha256"
    write_prepared_file "$preparing/$index.present"
    evidence_names+=(
      "$index.backup"
      "$index.original.metadata"
      "$index.original.sha256"
      "$index.present"
    )
  else
    touch "$preparing/$index.absent"
    write_prepared_file "$preparing/$index.absent"
    evidence_names+=("$index.absent")
  fi
done
(
  cd "$preparing"
  for evidence_name in "${evidence_names[@]}"; do
    sha256sum "$evidence_name"
  done
) >"$preparing/EVIDENCE.sha256"
write_prepared_file "$preparing/EVIDENCE.sha256"
sha256sum "$preparing/EVIDENCE.sha256" | awk '{print $1}' \
  >"$preparing/PREPARED"
write_prepared_file "$preparing/PREPARED"
sync -f "$preparing"
mv -- "$preparing" "$transaction"
sync -f "$transactions_root"

write_marker() {
  local marker="$1"
  touch "$transaction/$marker"
  chmod 0600 "$transaction/$marker"
  sync -f "$transaction/$marker"
  sync -f "$transaction"
}

remove_known_temp() {
  local path="$1"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return
  fi
  assert_trusted_file "$path"
  rm -f -- "$path"
  sync -f "$(dirname "$path")"
}

verify_installed_file() {
  local index="$1"
  local destination="$2"
  local expected_hash expected_metadata current_hash current_metadata
  if [[ ! -f "$destination" || -L "$destination" || \
    "$(stat -c '%h' "$destination")" != 1 ]]; then
    echo "$destination is not the expected installed regular file" >&2
    return 1
  fi
  expected_hash="$(cat "$transaction/$index.installed.sha256")"
  expected_metadata="$(cat "$transaction/$index.installed.metadata")"
  current_hash="$(sha256sum "$destination" | awk '{print $1}')"
  current_metadata="$(stat -c '%u:%g:%a' "$destination")"
  if [[ "$current_hash" != "$expected_hash" || \
    "$current_metadata" != "$expected_metadata" ]]; then
    echo "$destination does not match the prepared install evidence" >&2
    return 1
  fi
}

verify_recovery_helper() {
  local current_metadata expected_metadata
  assert_trusted_file "$transaction/rollback-recovery.sh"
  assert_trusted_file "$transaction/RECOVERY.sha256"
  assert_trusted_file "$transaction/RECOVERY.metadata"
  if ! (cd "$transaction" && \
    sha256sum --strict -c RECOVERY.sha256 >/dev/null); then
    echo "transaction-local Brain Mail recovery helper failed hash verification" >&2
    return 1
  fi
  current_metadata="$(stat -c '%u:%g:%a' "$transaction/rollback-recovery.sh")"
  expected_metadata="$(cat "$transaction/RECOVERY.metadata")"
  if [[ "$current_metadata" != "$expected_metadata" ]]; then
    echo "transaction-local Brain Mail recovery helper metadata changed" >&2
    return 1
  fi
}

on_error() {
  local status=$?
  local rollback_status
  trap - ERR
  set +e
  flock -u 9
  verify_recovery_helper
  rollback_status=$?
  if [[ "$rollback_status" == 0 ]]; then
    BRAIN_MAIL_INSTALL_ROOT="$install_root" \
      BRAIN_MAIL_ROLLBACK_AUTO=1 \
      /bin/bash "$transaction/rollback-recovery.sh" "$transaction"
    rollback_status=$?
  fi
  set -e
  if [[ "$rollback_status" == 0 ]]; then
    echo "brain-mail installation failed and files were rolled back: $transaction" >&2
  else
    echo "brain-mail installation failed; resume rollback for transaction: $transaction" >&2
  fi
  exit "$status"
}
trap on_error ERR

for index in "${!relative_sources[@]}"; do
  destination="$(root_path "${relative_destinations[$index]}")"
  mkdir -p -- "$(dirname "$destination")"
  assert_trusted_directory "$(dirname "$destination")"
  temp_path="$(dirname "$destination")/.brain-mail-install.$transaction_id.$index.tmp"
  remove_known_temp "$temp_path"
  write_marker "$index.APPLYING"
  install "${owner_args[@]}" -m "${modes[$index]}" \
    "$source_dir/${relative_sources[$index]}" "$temp_path"
  sync -f "$temp_path"
  mv -f -- "$temp_path" "$destination"
  temp_path=
  sync -f "$(dirname "$destination")"
  if [[ "$sandbox" == true && \
    "${BRAIN_MAIL_INSTALL_TEST_KILL_AFTER_MV:-}" == "$((index + 1))" ]]; then
    kill -KILL "$$"
  fi
  verify_installed_file "$index" "$destination"
  write_marker "$index.APPLIED"
  if [[ "$sandbox" == true && \
    "${BRAIN_MAIL_INSTALL_TEST_KILL_AFTER_MARKER:-}" == "$((index + 1))" ]]; then
    kill -KILL "$$"
  fi
  if [[ "$sandbox" == true && \
    "${BRAIN_MAIL_INSTALL_TEST_FAIL_AFTER:-}" == "$((index + 1))" ]]; then
    false
  fi
done

if [[ "$sandbox" == false ]]; then
  systemd-analyze verify \
    /etc/systemd/system/brain-mail.socket \
    /etc/systemd/system/brain-mail.service \
    /etc/systemd/system/brain-mail-mime.socket \
    /etc/systemd/system/brain-mail-mime@.service
  systemd-sysusers \
    /usr/lib/sysusers.d/brain-mail.conf \
    /usr/lib/sysusers.d/brain-mail-mime.conf
  systemd-tmpfiles --create \
    /usr/lib/tmpfiles.d/brain-mail.conf \
    /usr/lib/tmpfiles.d/brain-mail-mime.conf
  systemctl daemon-reload
  if systemctl is-active --quiet brain-mail.service || \
    systemctl is-active --quiet brain-mail.socket || \
    systemctl is-active --quiet brain-mail-mime.socket || \
    systemctl is-enabled --quiet brain-mail.service || \
    systemctl is-enabled --quiet brain-mail.socket || \
    systemctl is-enabled --quiet brain-mail-mime.socket; then
    echo "Brain Mail unexpectedly became active or enabled" >&2
    false
  fi
fi

write_marker COMMITTED
trap - ERR
echo "installed but disabled; transaction: $transaction"
echo "create the key separately, then run the documented manual canary"
