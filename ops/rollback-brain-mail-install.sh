#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

if [[ $# != 1 ]]; then
  echo "usage: rollback-brain-mail-install.sh TRANSACTION_DIRECTORY" >&2
  exit 2
fi

transaction="$1"
install_root="${BRAIN_MAIL_INSTALL_ROOT:-/}"
sandbox=false
if [[ "$install_root" != / ]]; then
  sandbox=true
fi
if [[ "$sandbox" == false && "$EUID" != 0 ]]; then
  echo "brain-mail rollback requires root" >&2
  exit 1
fi
for command in \
  awk basename cat chmod chown dirname flock id install mkdir mv readlink rm \
  sha256sum stat sync touch; do
  command -v "$command" >/dev/null || {
    echo "$command is required before rolling back Brain Mail" >&2
    exit 1
  }
done
if [[ "$sandbox" == false ]]; then
  command -v systemctl >/dev/null || {
    echo "systemctl is required before rolling back Brain Mail" >&2
    exit 1
  }
fi
if [[ ! "$install_root" = /* || -L "$install_root" || ! -d "$install_root" ]]; then
  echo "brain-mail rollback root is unsafe" >&2
  exit 1
fi
install_root="$(cd "$install_root" && pwd -P)"
if [[ "$install_root" != / ]]; then
  install_root="${install_root%/}"
fi
root_path() {
  if [[ "$install_root" == / ]]; then
    printf '/%s' "$1"
  else
    printf '%s/%s' "$install_root" "$1"
  fi
}

trusted_uid="$EUID"
if [[ "$sandbox" == false ]]; then
  trusted_uid=0
fi
assert_trusted_directory() {
  local directory="$1"
  local owner mode
  if [[ ! -d "$directory" || -L "$directory" || \
    "$(readlink -f "$directory")" != "$directory" ]]; then
    echo "$directory is not a trusted real directory" >&2
    exit 1
  fi
  IFS=: read -r owner mode < <(stat -c '%u:%a' "$directory")
  if [[ "$owner" != "$trusted_uid" || $((8#$mode & 8#022)) != 0 ]]; then
    echo "$directory ownership or mode is unsafe" >&2
    exit 1
  fi
}
assert_trusted_file() {
  local file="$1"
  local owner mode links
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "$file is not a trusted transaction file" >&2
    exit 1
  fi
  IFS=: read -r owner mode links < <(stat -c '%u:%a:%h' "$file")
  if [[ "$owner" != "$trusted_uid" || "$links" != 1 || \
    $((8#$mode & 8#022)) != 0 ]]; then
    echo "$file ownership, mode, or link count is unsafe" >&2
    exit 1
  fi
}
assert_exact_mode() {
  local file="$1"
  local expected_mode="$2"
  if [[ "$(stat -c '%a' "$file")" != "$expected_mode" ]]; then
    echo "$file has unexpected transaction evidence mode" >&2
    exit 1
  fi
}
read_hash_line() {
  local file="$1"
  local value
  value="$(cat "$file")"
  if [[ "$(stat -c '%s' "$file")" != 65 || \
    ! "$value" =~ ^[0-9a-f]{64}$ ]]; then
    echo "$file is not one exact SHA-256 line" >&2
    return 1
  fi
  printf '%s' "$value"
}
read_metadata_line() {
  local file="$1"
  local value
  value="$(cat "$file")"
  if [[ "$(stat -c '%s' "$file")" != "$(( ${#value} + 1 ))" || \
    ! "$value" =~ ^[0-9]{1,10}:[0-9]{1,10}:[0-7]{3,4}$ ]]; then
    echo "$file is not one safe uid:gid:mode line" >&2
    return 1
  fi
  printf '%s' "$value"
}
assert_empty_marker() {
  local file="$1"
  assert_trusted_file "$file"
  assert_exact_mode "$file" 600
  if [[ "$(stat -c '%s' "$file")" != 0 ]]; then
    echo "$file is not an empty transaction marker" >&2
    exit 1
  fi
}

assert_trusted_directory "$install_root"
transactions_root="$(root_path var/lib/brain-mail-install-transactions)"
if [[ ! -d "$transactions_root" || -L "$transactions_root" ]]; then
  echo "brain-mail rollback transaction root is unsafe" >&2
  exit 1
fi
transactions_root="$(cd "$transactions_root" && pwd -P)"
assert_trusted_directory "$transactions_root"
if [[ ! "$transaction" = /* || -L "$transaction" || ! -d "$transaction" ]]; then
  echo "brain-mail rollback transaction is unsafe" >&2
  exit 1
fi
transaction="$(cd "$transaction" && pwd -P)"
transaction_id="$(basename "$transaction")"
if [[ "$(dirname "$transaction")" != "$transactions_root" || \
  ! "$transaction_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$ ]]; then
  echo "brain-mail rollback transaction path is invalid" >&2
  exit 1
fi
assert_trusted_directory "$transaction"
if [[ ! -f "$transaction/PREPARED" || -e "$transaction/ROLLED_BACK" ]]; then
  echo "brain-mail rollback transaction is not recoverable or was already used" >&2
  exit 1
fi
assert_trusted_file "$transaction/PREPARED"
assert_trusted_file "$transaction/INSTALL_ROOT"
assert_trusted_file "$transaction/SOURCE"
assert_trusted_file "$transaction/rollback-recovery.sh"
assert_trusted_file "$transaction/RECOVERY.sha256"
assert_trusted_file "$transaction/RECOVERY.metadata"
assert_trusted_file "$transaction/EVIDENCE.sha256"
if [[ "$(cat "$transaction/INSTALL_ROOT")" != "$install_root" ]]; then
  echo "brain-mail rollback root does not match the transaction" >&2
  exit 1
fi
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

# The first state check deliberately happens before opening the shared lock so
# unsafe input fails quickly. Repeat it under the lock: another rollback could
# have completed while this process was descheduled before flock(2).
assert_trusted_directory "$transaction"
if [[ ! -f "$transaction/PREPARED" || -e "$transaction/ROLLED_BACK" ]]; then
  echo "brain-mail rollback transaction is not recoverable or was already used" >&2
  exit 1
fi
assert_trusted_file "$transaction/PREPARED"
assert_trusted_file "$transaction/INSTALL_ROOT"
assert_trusted_file "$transaction/SOURCE"
assert_trusted_file "$transaction/rollback-recovery.sh"
assert_trusted_file "$transaction/RECOVERY.sha256"
assert_trusted_file "$transaction/RECOVERY.metadata"
assert_trusted_file "$transaction/EVIDENCE.sha256"
if [[ "$(cat "$transaction/INSTALL_ROOT")" != "$install_root" ]]; then
  echo "brain-mail rollback root does not match the transaction" >&2
  exit 1
fi
if [[ "$sandbox" == false ]]; then
  if systemctl is-active --quiet brain-mail.service || \
    systemctl is-active --quiet brain-mail.socket || \
    systemctl is-active --quiet brain-mail-mime.socket || \
    systemctl is-enabled --quiet brain-mail.service || \
    systemctl is-enabled --quiet brain-mail.socket || \
    systemctl is-enabled --quiet brain-mail-mime.socket; then
    echo "stop and disable Brain Mail before rollback" >&2
    exit 1
  fi
fi

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

assert_exact_mode "$transaction" 700
assert_exact_mode "$transaction/PREPARED" 600
assert_exact_mode "$transaction/INSTALL_ROOT" 600
assert_exact_mode "$transaction/SOURCE" 600
assert_exact_mode "$transaction/rollback-recovery.sh" 500
assert_exact_mode "$transaction/RECOVERY.sha256" 600
assert_exact_mode "$transaction/RECOVERY.metadata" 600
assert_exact_mode "$transaction/EVIDENCE.sha256" 600

expected_evidence_names=(
  SOURCE
  INSTALL_ROOT
  rollback-recovery.sh
  RECOVERY.sha256
  RECOVERY.metadata
)
for index in "${!relative_destinations[@]}"; do
  destination="$(root_path "${relative_destinations[$index]}")"
  assert_destination_parent "$destination"
  assert_trusted_file "$transaction/$index.installed.sha256"
  assert_trusted_file "$transaction/$index.installed.metadata"
  assert_exact_mode "$transaction/$index.installed.sha256" 600
  assert_exact_mode "$transaction/$index.installed.metadata" 600
  read_hash_line "$transaction/$index.installed.sha256" >/dev/null
  read_metadata_line "$transaction/$index.installed.metadata" >/dev/null
  expected_evidence_names+=(
    "$index.installed.sha256"
    "$index.installed.metadata"
  )
  present=false
  absent=false
  if [[ -e "$transaction/$index.present" || -L "$transaction/$index.present" ]]; then
    present=true
    assert_empty_marker "$transaction/$index.present"
  fi
  if [[ -e "$transaction/$index.absent" || -L "$transaction/$index.absent" ]]; then
    absent=true
    assert_empty_marker "$transaction/$index.absent"
  fi
  if [[ "$present" == "$absent" ]]; then
    echo "brain-mail rollback requires exactly one backup marker" >&2
    exit 1
  fi
  if [[ "$present" == true ]]; then
    assert_trusted_file "$transaction/$index.backup"
    assert_trusted_file "$transaction/$index.original.sha256"
    assert_trusted_file "$transaction/$index.original.metadata"
    assert_exact_mode "$transaction/$index.backup" 600
    assert_exact_mode "$transaction/$index.original.sha256" 600
    assert_exact_mode "$transaction/$index.original.metadata" 600
    original_hash="$(read_hash_line "$transaction/$index.original.sha256")"
    read_metadata_line "$transaction/$index.original.metadata" >/dev/null
    backup_hash="$(sha256sum "$transaction/$index.backup" | awk '{print $1}')"
    if [[ "$backup_hash" != "$original_hash" ]]; then
      echo "brain-mail rollback backup hash does not match prepared evidence" >&2
      exit 1
    fi
    expected_evidence_names+=(
      "$index.backup"
      "$index.original.metadata"
      "$index.original.sha256"
      "$index.present"
    )
  else
    expected_evidence_names+=("$index.absent")
  fi
  for marker in APPLYING APPLIED RESTORING RESTORED; do
    if [[ -e "$transaction/$index.$marker" || \
      -L "$transaction/$index.$marker" ]]; then
      assert_empty_marker "$transaction/$index.$marker"
    fi
  done
done

for marker in COMMITTED AUTO_ROLLED_BACK; do
  if [[ -e "$transaction/$marker" || -L "$transaction/$marker" ]]; then
    assert_empty_marker "$transaction/$marker"
  fi
done

prepared_hash="$(read_hash_line "$transaction/PREPARED")"
evidence_hash="$(sha256sum "$transaction/EVIDENCE.sha256" | awk '{print $1}')"
if [[ "$prepared_hash" != "$evidence_hash" ]]; then
  echo "Brain Mail prepared evidence manifest hash changed" >&2
  exit 1
fi
expected_evidence_listing="$(printf '%s\n' "${expected_evidence_names[@]}")"
actual_evidence_listing="$(
  awk 'NF == 2 { print $2 }' "$transaction/EVIDENCE.sha256"
)"
if [[ "$actual_evidence_listing" != "$expected_evidence_listing" ]]; then
  echo "Brain Mail prepared evidence manifest file list changed" >&2
  exit 1
fi
if ! (cd "$transaction" && \
  sha256sum --strict -c EVIDENCE.sha256 >/dev/null); then
  echo "Brain Mail prepared transaction evidence failed hash verification" >&2
  exit 1
fi
recovery_listing="$(awk 'NF == 2 { print $2 }' "$transaction/RECOVERY.sha256")"
if [[ "$recovery_listing" != rollback-recovery.sh ]] || \
  ! (cd "$transaction" && sha256sum --strict -c RECOVERY.sha256 >/dev/null); then
  echo "transaction-local Brain Mail recovery helper failed hash verification" >&2
  exit 1
fi
recovery_metadata="$(read_metadata_line "$transaction/RECOVERY.metadata")"
if [[ "$(stat -c '%u:%g:%a' "$transaction/rollback-recovery.sh")" != \
  "$recovery_metadata" ]]; then
  echo "transaction-local Brain Mail recovery helper metadata changed" >&2
  exit 1
fi

temp_path=
cleanup() {
  if [[ -n "$temp_path" && -e "$temp_path" && ! -L "$temp_path" ]]; then
    rm -f -- "$temp_path"
  fi
}
trap cleanup EXIT

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

current_state() {
  local index="$1"
  local destination="$2"
  local current_hash current_metadata expected_hash expected_metadata
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    if [[ -f "$transaction/$index.absent" ]]; then
      printf original
    else
      printf tampered
    fi
    return
  fi
  if [[ ! -f "$destination" || -L "$destination" || \
    "$(stat -c '%h' "$destination")" != 1 ]]; then
    printf tampered
    return
  fi
  current_hash="$(sha256sum "$destination" | awk '{print $1}')"
  current_metadata="$(stat -c '%u:%g:%a' "$destination")"
  if [[ -f "$transaction/$index.present" ]]; then
    expected_hash="$(cat "$transaction/$index.original.sha256")"
    expected_metadata="$(cat "$transaction/$index.original.metadata")"
    if [[ "$current_hash" == "$expected_hash" && \
      "$current_metadata" == "$expected_metadata" ]]; then
      printf original
      return
    fi
  fi
  expected_hash="$(cat "$transaction/$index.installed.sha256")"
  expected_metadata="$(cat "$transaction/$index.installed.metadata")"
  if [[ "$current_hash" == "$expected_hash" && \
    "$current_metadata" == "$expected_metadata" ]]; then
    printf installed
    return
  fi
  printf tampered
}

# Classify every destination before changing any of them. Each atomic rename
# leaves either the saved original or the prepared release bytes; anything else
# is an operator change and must stop recovery.
for index in "${!relative_destinations[@]}"; do
  destination="$(root_path "${relative_destinations[$index]}")"
  state="$(current_state "$index" "$destination")"
  if [[ "$state" == tampered ]]; then
    echo "$destination matches neither saved original nor installed evidence" >&2
    exit 1
  fi
  if [[ -f "$transaction/$index.RESTORED" && "$state" != original ]]; then
    echo "$destination changed after its rollback completed" >&2
    exit 1
  fi
done

for index in "${!relative_destinations[@]}"; do
  destination="$(root_path "${relative_destinations[$index]}")"
  parent="$(dirname "$destination")"
  install_temp="$parent/.brain-mail-install.$transaction_id.$index.tmp"
  rollback_temp="$parent/.brain-mail-rollback.$transaction_id.$index.tmp"
  remove_known_temp "$install_temp"
  remove_known_temp "$rollback_temp"
  state="$(current_state "$index" "$destination")"
  if [[ -f "$transaction/$index.RESTORED" ]]; then
    continue
  fi
  if [[ ! -f "$transaction/$index.RESTORING" ]]; then
    write_marker "$index.RESTORING"
  fi
  if [[ "$state" == installed ]]; then
    if [[ -f "$transaction/$index.present" ]]; then
      IFS=: read -r restore_uid restore_gid restore_mode \
        <"$transaction/$index.original.metadata"
      mkdir -p -- "$parent"
      assert_trusted_directory "$parent"
      temp_path="$rollback_temp"
      install -m "$restore_mode" "$transaction/$index.backup" "$temp_path"
      if [[ "$sandbox" == false ]]; then
        chown "$restore_uid:$restore_gid" "$temp_path"
      fi
      sync -f "$temp_path"
      mv -f -- "$temp_path" "$destination"
      temp_path=
      sync -f "$parent"
    else
      rm -f -- "$destination"
      if [[ -d "$parent" ]]; then
        sync -f "$parent"
      fi
    fi
  fi
  if [[ "$sandbox" == true && \
    "${BRAIN_MAIL_ROLLBACK_TEST_KILL_AFTER_RESTORE:-}" == "$((index + 1))" ]]; then
    kill -KILL "$$"
  fi
  if [[ "$(current_state "$index" "$destination")" != original ]]; then
    echo "$destination did not restore to its saved original state" >&2
    exit 1
  fi
  write_marker "$index.RESTORED"
  if [[ "$sandbox" == true && \
    "${BRAIN_MAIL_ROLLBACK_TEST_KILL_AFTER_MARKER:-}" == "$((index + 1))" ]]; then
    kill -KILL "$$"
  fi
done

if [[ "$sandbox" == false ]]; then
  systemctl daemon-reload
fi
if [[ "${BRAIN_MAIL_ROLLBACK_AUTO:-}" == 1 ]]; then
  write_marker AUTO_ROLLED_BACK
fi
write_marker ROLLED_BACK
echo "rolled back Brain Mail files; additive system identities and data were preserved"
