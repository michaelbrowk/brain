#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

base="${BRAIN_DEPLOY_BASE:-/opt/brain}"
bin_dir="${BRAIN_DEPLOY_BIN:-/opt/brain/bin}"
fetch_user="${BRAIN_DEPLOY_FETCH_USER:-brain-deploy}"
fetch_group="${BRAIN_DEPLOY_FETCH_GROUP:-brain-deploy}"
env_file="${BRAIN_DEPLOY_ENV_FILE:-/etc/brain/deployer.env}"
runtime_link="$base/runtime/current/bin/node"
resolver_path="$bin_dir/resolve-deploy-candidate.mjs"
resolver_library_path="$bin_dir/deploy-provenance.mjs"
extractor_path="$bin_dir/extract_release.py"
metadata_writer_path="$bin_dir/write-release-metadata.mjs"
transaction_path="$bin_dir/deploy-transaction.mjs"
mail_health_parser_path="$bin_dir/read-mail-health-commit.mjs"
mail_runtime_projector_path="$bin_dir/project_mail_runtime.py"
current="$base/current"
bootstrap_marker="$base/.bootstrap-deploy-once"
transaction_journal="$base/.deploy-transaction.json"
pending_marker="$base/.deploy-pending.json"
max_zip_unpacked_bytes=537919488
max_release_files=100000
max_release_bytes=1073741824

fail() {
  echo "brain deploy puller: $*" >&2
  exit 1
}

if (( EUID != 0 )); then
  fail "must run as root from its systemd service"
fi
if [[ ! "$base" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
  [[ "$base" == "/" || "$base" == *"/../"* || "$base" == */.. ]]; then
  fail "BRAIN_DEPLOY_BASE must be a safe absolute path"
fi
if [[ ! "$bin_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
  [[ "$bin_dir" == "/" || "$bin_dir" == *"/../"* || "$bin_dir" == */.. ]]; then
  fail "BRAIN_DEPLOY_BIN must be a safe absolute path"
fi
if [[ ! "$fetch_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || \
  [[ ! "$fetch_group" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  fail "fetch user and group names are malformed"
fi

assert_root_config() {
  local path="$1"
  local expected_mode="$2"
  local metadata
  [[ -f "$path" && ! -L "$path" ]] || fail "$path must be a regular file"
  metadata="$(stat -c '%u:%a' "$path")"
  [[ "$metadata" == "0:$expected_mode" ]] || \
    fail "$path must be root-owned mode $expected_mode"
}

assert_root_chain() {
  local input="$1"
  local resolved cursor owner mode
  resolved="$(readlink -f -- "$input")" || fail "cannot resolve $input"
  [[ -e "$resolved" ]] || fail "$input does not exist"
  cursor="$resolved"
  while true; do
    owner="$(stat -c '%u' "$cursor")"
    mode="$(stat -c '%a' "$cursor")"
    [[ "$owner" == "0" ]] || fail "$cursor must be root-owned"
    if (( (8#$mode & 0022) != 0 )); then
      fail "$cursor must not be group- or world-writable"
    fi
    [[ "$cursor" == "/" ]] && break
    cursor="${cursor%/*}"
    [[ -n "$cursor" ]] || cursor="/"
  done
  printf '%s' "$resolved"
}

assert_root_program() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || fail "$path must be a regular file"
  assert_root_chain "$path" >/dev/null
}

for command in cmp curl flock stat systemctl; do
  command -v "$command" >/dev/null || fail "$command is required"
done

assert_root_program "$(readlink -f "$0")"
assert_root_program "$transaction_path"
runtime="$(assert_root_chain "$runtime_link")"
[[ -f "$runtime" && -x "$runtime" ]] || fail "pinned Brain Node runtime is missing"
[[ "$runtime" == "$base/runtime/"* ]] || \
  fail "pinned Brain Node runtime resolves outside $base/runtime"
[[ "$("$runtime" --version)" == "v22.23.1" ]] || \
  fail "pinned Brain Node runtime is not v22.23.1"
transaction="$(readlink -f "$transaction_path")"
mail_health_parser=""
[[ -d "$base" && ! -L "$base" ]] || fail "$base must be a real directory"
assert_root_chain "$base" >/dev/null
[[ -L "$current" ]] || fail "$current must be a symlink"
initial_current="$(readlink -f "$current")"
[[ -d "$initial_current" && "$initial_current" == "$base/releases/"* ]] || \
  fail "current release target is outside the releases directory"

exec 8>"$base/.deploy-poll.lock"
if ! flock -n 8; then
  exit 0
fi
exec 9>"$base/.deploy.lock"
if ! flock -w 300 9; then
  fail "timed out waiting for the Brain deployment lock"
fi

readiness_token=""
mail_managed=0

load_readiness_token() {
  readiness_token="$(sed -n 's/^BRAIN_READINESS_TOKEN=//p' /etc/brain/brain.env)"
  [[ "$readiness_token" =~ ^[a-f0-9]{64}$ ]] || \
    fail "BRAIN_READINESS_TOKEN is missing or malformed"
}

read_release_commit() {
  "$runtime" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value || !/^[a-f0-9]{40}$/.test(value.commit || "")) process.exit(2);
    process.stdout.write(value.commit);
  ' "$1"
}

read_health_commit() {
  "$runtime" -e '
    let source = "";
    process.stdin.on("data", chunk => source += chunk).on("end", () => {
      const value = JSON.parse(source);
      if (!value || value.status !== "ok" || !/^[a-f0-9]{40}$/.test(value.commit || "")) {
        process.exit(2);
      }
      process.stdout.write(value.commit);
    });
  '
}

read_mail_health_commit() {
  "$runtime" "$mail_health_parser"
}

deep_health() {
  [[ "$readiness_token" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf 'header = "X-Brain-Readiness: %s"\n' "$readiness_token" | \
    curl -q --noproxy '*' --fail --silent --show-error \
      --max-time "${deep_health_max_time:-10}" --config - \
      'http://127.0.0.1:3020/api/health?ready=1'
}

mail_health() {
  (( mail_managed == 1 )) || return 1
  curl -q --noproxy '*' --fail --silent --show-error --max-time 10 \
    --unix-socket /run/brain-mail/brain-mail.sock \
    http://brain-mail/v1/health
}

shallow_health() {
  curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    --output /dev/null http://127.0.0.1:3020/login
}

verify_managed_health() {
  local expected="$1"
  local health actual
  health="$(deep_health)" || return 1
  actual="$(printf '%s' "$health" | read_health_commit)" || return 1
  [[ "$actual" == "$expected" ]]
}

verify_release_health() {
  local expected="$1"
  local actual
  verify_managed_health "$expected" || return 1
  if (( mail_managed == 1 )); then
    actual="$(mail_health | read_mail_health_commit)" || return 1
    [[ "$actual" == "$expected" ]] || return 1
  fi
}

wait_for_release_health() {
  local expected="$1"
  local _attempt
  for _attempt in 1 2 3 4 5; do
    if verify_release_health "$expected"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_shallow_health() {
  local _attempt
  for _attempt in 1 2 3 4 5; do
    if shallow_health; then
      return 0
    fi
    sleep 1
  done
  return 1
}

sync_base() {
  "$runtime" "$transaction" sync "$base"
}

sync_releases() {
  "$runtime" "$transaction" sync-releases "$base"
}

remove_candidate_release() {
  local candidate="$1"
  local current_target
  [[ "$candidate" == "$base/releases/"* && \
    "$candidate" != "$base/releases/" ]] || return 1
  current_target="$(readlink -f "$current")" || return 1
  [[ "$current_target" != "$candidate" ]] || return 1
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
    rm -rf --one-file-system -- "$candidate" || return 1
    [[ ! -e "$candidate" && ! -L "$candidate" ]] || return 1
  fi
  sync_releases
}

clear_pending_if_matching() {
  local release="$1"
  local commit="$2"
  if [[ -e "$pending_marker" || -L "$pending_marker" ]]; then
    "$runtime" "$transaction" clear-pending "$base" "$release" "$commit"
  fi
}

atomic_switch() {
  local target="$1"
  local label="$2"
  local link="$base/.current-$label-$$"
  [[ -d "$target" && "$target" == "$base/releases/"* ]] || return 1
  rm -f -- "$link"
  ln -s "$target" "$link"
  mv -Tf "$link" "$current"
  sync_base
}

validate_bootstrap_marker() {
  local expected="${1:-}"
  local authorized
  [[ -e "$bootstrap_marker" || -L "$bootstrap_marker" ]] || return 1
  [[ -f "$bootstrap_marker" && ! -L "$bootstrap_marker" ]] || \
    fail "invalid bootstrap marker"
  [[ "$(stat -c '%u:%a' "$bootstrap_marker")" == "0:600" ]] || \
    fail "invalid bootstrap marker"
  authorized="$(<"$bootstrap_marker")"
  [[ "$authorized" =~ ^[a-f0-9]{40}$ ]] || \
    fail "bootstrap marker must contain one approved commit SHA"
  if [[ -n "$expected" && "$authorized" != "$expected" ]]; then
    fail "bootstrap marker does not authorize current main"
  fi
}

ensure_bootstrap_marker() {
  local expected="$1"
  [[ "$expected" =~ ^[a-f0-9]{40}$ ]] || return 1
  if [[ -e "$bootstrap_marker" || -L "$bootstrap_marker" ]]; then
    validate_bootstrap_marker "$expected"
    return
  fi
  "$runtime" "$transaction" write-bootstrap "$base" "$expected"
}

stop_transient_unit() {
  local unit="$1"
  local listing
  local _attempt
  [[ "$unit" =~ ^brain-deploy-(resolver|extractor)-[0-9a-f]{32}\.service$ ]] || \
    return 1
  systemctl kill --kill-whom=all --signal=KILL "$unit" \
    >/dev/null 2>&1 || true
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  for _attempt in 1 2 3 4 5; do
    listing="$(systemctl list-units --all --full --plain --no-legend \
      "$unit")" || return 1
    if [[ -z "$listing" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

read_unit_load_state() {
  local unit="$1"
  local load_state
  load_state="$(systemctl show --property=LoadState --value "$unit")" || return 1
  [[ "$load_state" == "loaded" || "$load_state" == "not-found" ]] || return 1
  printf '%s' "$load_state"
}

assert_release_service_identity() {
  local load_state service_user
  local mail_service_load mail_socket_load mail_mime_socket_load
  local mail_mime_service_load brain_dropins brain_supplementary_groups
  load_state="$(systemctl show --property=LoadState --value brain.service)" || \
    fail "brain.service could not be queried"
  [[ "$load_state" == "loaded" ]] || fail "brain.service is not loaded"
  service_user="$(systemctl show --property=User --value brain.service)" || \
    fail "brain.service user could not be queried"
  [[ "$service_user" == "brain" ]] || fail "brain.service must run as brain"

  mail_service_load="$(read_unit_load_state brain-mail.service)" || \
    fail "brain-mail.service has an invalid load state"
  mail_socket_load="$(read_unit_load_state brain-mail.socket)" || \
    fail "brain-mail.socket has an invalid load state"
  mail_mime_socket_load="$(read_unit_load_state brain-mail-mime.socket)" || \
    fail "brain-mail-mime.socket has an invalid load state"
  # systemctl rejects a bare template name (`name@.service`) for `show`.
  # A concrete, never-started probe instance resolves the installed template
  # without creating or activating a service.
  mail_mime_service_load="$(read_unit_load_state brain-mail-mime@brain-deploy-probe.service)" || \
    fail "brain-mail-mime@.service has an invalid load state"
  brain_dropins="$(systemctl show --property=DropInPaths --value brain.service)" || \
    fail "brain.service drop-ins could not be queried"
  brain_supplementary_groups="$(systemctl show \
    --property=SupplementaryGroups --value brain.service)" || \
    fail "brain.service supplementary groups could not be queried"

  if [[ "$mail_service_load" == "loaded" ]]; then
    [[ "$mail_socket_load" == "loaded" && \
      "$mail_mime_socket_load" == "loaded" && \
      "$mail_mime_service_load" == "loaded" && \
      "$brain_dropins" == *"/90-brain-mail-client.conf"* && \
      " $brain_supplementary_groups " == *" brain-mail-client "* ]] || \
      fail "Brain Mail installation is incomplete"
    service_user="$(systemctl show --property=User --value brain-mail.service)" || \
      fail "brain-mail.service user could not be queried"
    [[ "$service_user" == "brain-mail" ]] || \
      fail "brain-mail.service must run as brain-mail"
    mail_managed=1
  elif [[ "$mail_socket_load" == "not-found" && \
    "$mail_mime_socket_load" == "not-found" && \
    "$mail_mime_service_load" == "not-found" && \
    "$brain_dropins" != *"/90-brain-mail-client.conf"* && \
    " $brain_supplementary_groups " != *" brain-mail-client "* ]]; then
    mail_managed=0
  else
    fail "Brain Mail installation is incomplete"
  fi
}

assert_release_services_active() {
  systemctl is-active --quiet brain.service || fail "brain.service is not active"
  if (( mail_managed == 1 )); then
    systemctl is-active --quiet brain-mail.socket || \
      fail "brain-mail.socket is not active"
    systemctl is-active --quiet brain-mail-mime.socket || \
      fail "brain-mail-mime.socket is not active"
    systemctl is-active --quiet brain-mail.service || \
      fail "brain-mail.service is not active"
  fi
}

restart_release_services() {
  if (( mail_managed == 1 )); then
    systemctl restart brain-mail.service || return 1
  fi
  systemctl restart brain.service
}

stop_stale_transient_units() {
  local listing unit _rest
  listing="$(systemctl list-units --all --full --plain --no-legend \
    'brain-deploy-resolver-*.service' \
    'brain-deploy-extractor-*.service')" || \
    fail "could not enumerate stale transient deploy units"
  while read -r unit _rest; do
    [[ -n "$unit" ]] || continue
    stop_transient_unit "$unit" || \
      fail "stale transient deploy unit could not be contained"
  done <<<"$listing"
}

recover_transaction() {
  local raw
  local -a fields
  local previous release commit bootstrap current_target previous_commit
  if [[ ! -e "$transaction_journal" && ! -L "$transaction_journal" ]]; then
    return
  fi
  current_target="$(readlink -f "$current")" || \
    fail "current release target could not be resolved"
  raw="$("$runtime" "$transaction" inspect-recovery-fields \
    "$base" "$current_target")" || \
    fail "deployment transaction recovery state could not be read"
  mapfile -t fields <<<"$raw"
  [[ "${#fields[@]}" == "5" && "${fields[0]}" == "transaction" ]] || \
    fail "deployment transaction fields are invalid"
  previous="${fields[1]}"
  release="${fields[2]}"
  commit="${fields[3]}"
  bootstrap="${fields[4]}"
  if [[ "$bootstrap" == "1" && "$mail_managed" == "1" ]]; then
    fail "legacy transaction recovery cannot safely manage Brain Mail"
  fi
  atomic_switch "$previous" recovery || \
    fail "could not restore the previous release from the transaction journal"
  restart_release_services || \
    fail "previous Brain release services did not restart during transaction recovery"
  if [[ "$bootstrap" == "1" ]]; then
    ensure_bootstrap_marker "$commit"
    wait_for_shallow_health || \
      fail "legacy Brain release is unhealthy after recovery"
  else
    load_readiness_token
    [[ -f "$previous/release.json" ]] || \
      fail "previous release metadata is missing during recovery"
    previous_commit="$(read_release_commit "$previous/release.json")"
    wait_for_release_health "$previous_commit" || \
      fail "previous Brain release services are unhealthy after transaction recovery"
  fi
  remove_candidate_release "$release" || \
    fail "could not remove interrupted candidate release"
  clear_pending_if_matching "$release" "$commit" || \
    fail "could not clear recovered deployment pending marker"
  "$runtime" "$transaction" clear "$base"
  echo "brain deploy puller: recovered interrupted deployment of $commit"
}

recover_pending_release() {
  local raw release commit current_target
  local -a fields
  if [[ ! -e "$pending_marker" && ! -L "$pending_marker" ]]; then
    return
  fi
  current_target="$(readlink -f "$current")" || \
    fail "current release target could not be resolved"
  raw="$("$runtime" "$transaction" inspect-recovery-fields \
    "$base" "$current_target")" || \
    fail "deployment pending recovery state could not be read"
  mapfile -t fields <<<"$raw"
  [[ "${#fields[@]}" == "3" && "${fields[0]}" == "pending" ]] || \
    fail "deployment pending marker fields are invalid"
  release="${fields[1]}"
  commit="${fields[2]}"
  remove_candidate_release "$release" || \
    fail "could not remove unreferenced pending release"
  "$runtime" "$transaction" clear-pending "$base" "$release" "$commit" || \
    fail "could not clear deployment pending marker"
  echo "brain deploy puller: recovered pre-transaction release preparation for $commit"
}

# Recovery happens under both deployment locks and before any active-release
# no-op, so a crash after the symlink switch cannot bypass health or rollback.
assert_release_service_identity
if (( mail_managed == 1 )); then
  assert_root_program "$mail_health_parser_path"
  mail_health_parser="$(readlink -f "$mail_health_parser_path")"
fi
recover_transaction
recover_pending_release
stop_stale_transient_units
assert_release_services_active
load_readiness_token

# Recovery needs only the pinned runtime, transaction and Mail health helpers,
# service manager, readiness credential, and current release. Normal deployment
# prerequisites are intentionally checked afterwards so missing GitHub/fetch
# configuration cannot strand an interrupted promotion.
for command in \
  df env find getent id install openssl passwd python3 setfacl systemd-run; do
  command -v "$command" >/dev/null || fail "$command is required"
done
[[ ! -L "$env_file" ]] || fail "$env_file must not be a symlink"
env_file="$(assert_root_chain "$env_file")"
assert_root_config "$env_file" 600
assert_root_program "$resolver_path"
assert_root_program "$resolver_library_path"
assert_root_program "$extractor_path"
assert_root_program "$metadata_writer_path"
resolver="$(readlink -f "$resolver_path")"
extractor="$(readlink -f "$extractor_path")"
metadata_writer="$(readlink -f "$metadata_writer_path")"

fetch_uid="$(id -u "$fetch_user")" || fail "fetch user does not exist"
fetch_gid="$(getent group "$fetch_group" | cut -d: -f3)"
brain_uid="$(id -u brain)" || fail "brain service user does not exist"
read -r -a brain_sensitive_gids <<<"$(id -G brain)"
[[ "$fetch_uid" =~ ^[0-9]+$ && "$fetch_uid" != "0" ]] || \
  fail "fetch user must be unprivileged"
[[ "$fetch_gid" =~ ^[0-9]+$ && "$fetch_gid" != "0" ]] || \
  fail "fetch group must be unprivileged"
[[ "$brain_uid" =~ ^[0-9]+$ && "$brain_uid" != "0" ]] || \
  fail "brain service user must be unprivileged"
[[ "$fetch_uid" != "$brain_uid" ]] || \
  fail "fetch user must have a distinct numeric uid from brain"
(( ${#brain_sensitive_gids[@]} > 0 )) || \
  fail "brain service groups could not be determined"
for sensitive_gid in "${brain_sensitive_gids[@]}"; do
  [[ "$sensitive_gid" =~ ^[0-9]+$ ]] || \
    fail "brain service group id is malformed"
  [[ "$fetch_gid" != "$sensitive_gid" ]] || \
    fail "fetch primary group must be numerically distinct from every brain group"
done
[[ "$(id -g "$fetch_user")" == "$fetch_gid" ]] || \
  fail "fetch user primary group is unexpected"
[[ "$(id -G "$fetch_user")" == "$fetch_gid" ]] || \
  fail "fetch user must not have supplementary groups"
password_state="$(passwd -S "$fetch_user" | awk '{print $2}')"
[[ "$password_state" == "L" || "$password_state" == "LK" ]] || \
  fail "fetch user password must be locked"

systemctl is-enabled --quiet brain.service || fail "brain.service is not enabled"
[[ "$(systemctl show --property=User --value brain.service)" == "brain" ]] || \
  fail "brain.service must run as brain"
mkdir -p "$base/incoming" "$base/releases"

# No poll can own a fetch workspace while the poll lock is held. Remove every
# abandoned puller workspace before measuring space or allocating a new one.
find "$base/incoming" -mindepth 1 -maxdepth 1 -name '.pull.*' \
  -exec rm -rf --one-file-system -- {} +
# Manual upload directories use release ids, never the .pull prefix. Delete
# week-old abandoned uploads before the resource gate counts free space/inodes.
find "$base/incoming" -mindepth 1 -maxdepth 1 -type d \
  ! -name '.pull.*' -mtime +7 -exec rm -rf --one-file-system -- {} +

workspace="$(mktemp -d "$base/incoming/.pull.XXXXXXXX")"
active_transient_unit=""

# Invoked by the EXIT trap below.
# ShellCheck cannot follow the EXIT trap's indirect invocation of this
# function. Both rule ids are used by supported distro versions.
# shellcheck disable=SC2317,SC2329
cleanup() {
  local status=$?
  local contained=1
  trap - EXIT
  if [[ -n "$active_transient_unit" ]] && \
    ! stop_transient_unit "$active_transient_unit"; then
    echo "CRITICAL: transient deploy unit could not be contained" >&2
    status=70
    contained=0
  fi
  if (( contained == 1 )); then
    rm -rf --one-file-system -- "$workspace"
  else
    echo "CRITICAL: preserving fetch workspace until unit containment succeeds" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
chown "$fetch_uid:$fetch_gid" "$workspace"
chmod 0700 "$workspace"

run_isolated() {
  local mode="$1"
  shift
  local status=0
  local unit
  unit="brain-deploy-$mode-$(openssl rand -hex 16).service"
  local -a command=(
    systemd-run
    --quiet
    --wait
    --pipe
    --collect
    --unit="$unit"
    --service-type=exec
    --uid="$fetch_user"
    --gid="$fetch_group"
    --property=SupplementaryGroups=
    --property=KillMode=control-group
    --property=NoNewPrivileges=yes
    --property=ProtectSystem=strict
    --property=ProtectHome=yes
    --property=PrivateDevices=yes
    --property=PrivateTmp=yes
    --property=ProtectKernelTunables=yes
    --property=ProtectKernelModules=yes
    --property=ProtectKernelLogs=yes
    --property=ProtectControlGroups=yes
    --property=ProtectProc=invisible
    --property=ProcSubset=pid
    --property=RestrictSUIDSGID=yes
    --property=RestrictRealtime=yes
    --property=RestrictNamespaces=yes
    --property=LockPersonality=yes
    --property=CapabilityBoundingSet=
    --property=SystemCallArchitectures=native
    --property=RuntimeMaxSec=15min
    --property=TimeoutStopSec=30s
    --property=MemoryMax=512M
    --property=MemorySwapMax=0
    --property=TasksMax=64
    --property=CPUWeight=20
    --property=IOWeight=20
    --property=LimitNOFILE=1024
    --property="ReadWritePaths=$workspace"
  )
  if [[ "$mode" == "resolver" ]]; then
    command+=(
      --property="LoadCredential=deployer-env:$env_file"
      --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"
    )
  elif [[ "$mode" == "extractor" ]]; then
    command+=(
      --property=PrivateNetwork=yes
      --property=RestrictAddressFamilies=AF_UNIX
    )
  else
    fail "unknown isolated execution mode"
  fi
  active_transient_unit="$unit"
  if "${command[@]}" -- "$@"; then
    status=0
  else
    status=$?
  fi
  if ! stop_transient_unit "$unit"; then
    fail "transient deploy unit did not become inactive"
  fi
  active_transient_unit=""
  return "$status"
}

run_resolver() {
  run_isolated resolver "$runtime" "$resolver" "$@"
}

run_extractor() {
  run_isolated extractor env -i \
    PATH="$PATH" \
    BRAIN_DEPLOY_MAX_ZIP_UNPACKED_BYTES="$max_zip_unpacked_bytes" \
    BRAIN_DEPLOY_MAX_RELEASE_FILES="$max_release_files" \
    BRAIN_DEPLOY_MAX_RELEASE_BYTES="$max_release_bytes" \
    python3 "$extractor" "$@"
}

run_isolated extractor test -x "$base" || fail "fetch user cannot traverse $base"
run_isolated extractor test -x "$base/incoming" || \
  fail "fetch user cannot traverse $base/incoming"
run_isolated extractor test -x "$workspace" || \
  fail "fetch workspace is not isolated"

resolver_status=0
current_main="$(run_resolver target)" || resolver_status=$?
if [[ "$resolver_status" -eq 75 ]]; then
  # EX_TEMPFAIL from the resolver: the configured source has no deployable
  # target yet — no completed CI run for current main, or no published
  # release. The resolver's stderr carries the exact reason; exiting 0
  # keeps OnFailure= alerts for real failures only.
  echo "brain deploy puller: deploy source has no deployable target yet; retrying on the next timer pass"
  exit 0
fi
[[ "$resolver_status" -eq 0 ]] || exit "$resolver_status"
[[ "$current_main" =~ ^[0-9a-f]{40}$ ]] || \
  fail "resolver returned an invalid current main commit"

active_release="$(readlink -f "$current")"
active_commit=""
if [[ -f "$active_release/release.json" && \
  ! -L "$active_release/release.json" && \
  "$(stat -c '%u:%a' "$active_release/release.json")" =~ ^0:44[04]$ ]]; then
  active_commit="$(read_release_commit "$active_release/release.json")"
  if [[ "$active_commit" == "$current_main" ]]; then
    if validate_bootstrap_marker; then
      fail "bootstrap marker is stale"
    fi
    if [[ -e "$active_release/deploy-provenance.json" || \
      -L "$active_release/deploy-provenance.json" ]]; then
      [[ -f "$active_release/deploy-provenance.json" && \
        ! -L "$active_release/deploy-provenance.json" && \
        "$(stat -c '%u:%a' "$active_release/deploy-provenance.json")" == \
          "0:440" ]] || \
        fail "active managed release provenance is invalid"
      active_candidate="$workspace/active-candidate.json"
      install -o "$fetch_uid" -g "$fetch_gid" -m 0400 \
        "$active_release/deploy-provenance.json" "$active_candidate"
      [[ "$(run_resolver recheck-active "$active_candidate")" == "$active_commit" ]] || \
        fail "active release provenance recheck returned another commit"
      verify_release_health "$active_commit" || \
        fail "active Brain release services are unhealthy or serve another commit"
      echo "brain deploy puller: $active_commit is already active and healthy"
      exit 0
    fi
    echo "brain deploy puller: active release lacks provenance; preparing a verified replacement"
  fi
fi

if [[ -n "$active_commit" ]]; then
  minimum_commit="$active_commit"
else
  validate_bootstrap_marker "$current_main" || \
    fail "legacy release requires a bootstrap marker pinned to current main"
  minimum_commit="$current_main"
fi

candidate="$workspace/candidate.json"
artifact_download="$workspace/artifact"
resolver_status=0
commit="$(run_resolver resolve "$candidate" "$minimum_commit")" || \
  resolver_status=$?
if [[ "$resolver_status" -eq 75 ]]; then
  # EX_TEMPFAIL from the resolver: the configured source has no deployable
  # candidate yet — CI still running after a merge, or no published release.
  # The resolver's stderr carries the exact reason; exiting 0 keeps
  # OnFailure= alerts for real failures only.
  echo "brain deploy puller: deploy source has no deployable candidate yet; retrying on the next timer pass"
  exit 0
fi
[[ "$resolver_status" -eq 0 ]] || exit "$resolver_status"
[[ "$commit" =~ ^[0-9a-f]{40}$ && "$commit" == "$current_main" ]] || \
  fail "resolver returned an invalid or changed main commit"

# The candidate pins the exact artifact size. While extracting, disk can hold
# that artifact, up to 513 MiB of zip-expanded archive plus manifest, a 1 GiB
# release tree, and 256 MiB of operational headroom at the same time.
artifact_bytes="$(run_resolver artifact-size "$candidate")"
[[ "$artifact_bytes" =~ ^[1-9][0-9]*$ ]] || \
  fail "candidate returned an invalid artifact size"
artifact_kb=$(((artifact_bytes + 1023) / 1024))
zip_unpacked_kb=$(((max_zip_unpacked_bytes + 1023) / 1024))
release_limit_kb=$(((max_release_bytes + 1023) / 1024))
preextract_required_kb=$((artifact_kb + zip_unpacked_kb + release_limit_kb + 256 * 1024))
preextract_available_kb="$(df -Pk "$base" | awk 'END { print $4 }')"
[[ "$preextract_available_kb" =~ ^[0-9]+$ ]] || \
  fail "could not determine available deployment space"
if (( 10#$preextract_available_kb < preextract_required_kb )); then
  fail "not enough free space for bounded release extraction"
fi
preextract_required_inodes=$((max_release_files + 10000))
preextract_available_inodes="$(df -Pi "$base" | awk 'END { print $4 }')"
[[ "$preextract_available_inodes" =~ ^[0-9]+$ ]] || \
  fail "could not determine available deployment inodes"
if (( 10#$preextract_available_inodes < preextract_required_inodes )); then
  fail "not enough free inodes for bounded release extraction"
fi
run_resolver download "$candidate" "$artifact_download" >/dev/null

extracted="$workspace/extracted"
install -d -o "$fetch_uid" -g "$fetch_gid" -m 0700 "$extracted"
built_at="$(run_extractor extract "$artifact_download" "$extracted" "$commit")"
[[ "$built_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
  fail "extractor returned an invalid build timestamp"
stage="$extracted/release"
[[ -f "$stage/server.js" && -f "$stage/package.json" ]] || \
  fail "extracted standalone release is incomplete"
unsafe_entry="$(find "$workspace" -xdev ! -type d ! -type f ! -type l -print -quit)"
[[ -z "$unsafe_entry" ]] || fail "fetch workspace contains a special file"
chown -R --no-dereference root:brain "$workspace"
chmod 0444 "$candidate"
setfacl -m "u:$fetch_user:--x" "$workspace"
env -i \
  PATH="$PATH" \
  BRAIN_DEPLOY_MAX_RELEASE_FILES="$max_release_files" \
  BRAIN_DEPLOY_MAX_RELEASE_BYTES="$max_release_bytes" \
  python3 "$extractor" verify-tree "$stage" >/dev/null

shipped_release_metadata=""
if [[ -e "$stage/release.json" || -L "$stage/release.json" ]]; then
  [[ -f "$stage/release.json" && ! -L "$stage/release.json" ]] || \
    fail "shipped release metadata must be a regular file"
  shipped_release_metadata="$workspace/shipped-release.json"
  mv -- "$stage/release.json" "$shipped_release_metadata"
  chmod 0444 "$shipped_release_metadata"
fi

if (( mail_managed == 1 )); then
  assert_root_program "$mail_runtime_projector_path"
  candidate_mail_runtime_projector="$stage/brain-mail-ops/project_mail_runtime.py"
  [[ -f "$candidate_mail_runtime_projector" && \
    ! -L "$candidate_mail_runtime_projector" ]] || \
    fail "release artifact is missing the Brain Mail runtime projector"
  assert_root_program "$candidate_mail_runtime_projector"
  cmp --silent \
    "$mail_runtime_projector_path" \
    "$candidate_mail_runtime_projector" || \
    fail "Brain Mail runtime projector update is required before deployment"
fi

release_nonce="$(openssl rand -hex 16)"
release_id="${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$release_nonce"
release="$base/releases/$release_id"
[[ ! -e "$release" && ! -L "$release" ]] || fail "release id already exists"

for reserved_metadata in \
  "$stage/release.json" "$stage/deploy-provenance.json"; do
  [[ ! -e "$reserved_metadata" && ! -L "$reserved_metadata" ]] || \
    fail "release artifact contains a reserved metadata path"
done
"$runtime" "$metadata_writer" \
  "$stage/release.json" "$release_id" "$commit" "$built_at" \
  "$candidate" "$stage/deploy-provenance.json" "$shipped_release_metadata"
for reserved_metadata in \
  "$stage/release.json" "$stage/deploy-provenance.json"; do
  [[ -f "$reserved_metadata" && ! -L "$reserved_metadata" && \
    "$(stat -c '%U:%G:%a' "$reserved_metadata")" == "root:brain:444" ]] || \
    fail "release metadata was not created as an immutable root:brain file"
done

unsafe_entry="$(find "$stage" -xdev ! -type d ! -type f ! -type l -print -quit)"
[[ -z "$unsafe_entry" ]] || fail "release tree contains a special file"
hardlink="$(find "$stage" -xdev -type f -links +1 -print -quit)"
[[ -z "$hardlink" ]] || fail "release tree contains a hard-linked file"
find "$stage" -xdev -type d -exec chmod 0550 {} +
find "$stage" -xdev -type f -exec chmod 0440 {} +

release_kb="$(du -sk "$stage" | awk '{print $1}')"
required_kb=$((release_kb * 2 + 262144))
available_kb="$(df -Pk "$base" | awk 'END { print $4 }')"
if (( available_kb < required_kb )); then
  fail "not enough free space for a Brain release"
fi
[[ "$(run_resolver recheck "$candidate")" == "$commit" ]] || \
  fail "candidate recheck returned another commit"

previous="$(readlink -f "$current")"
[[ -d "$previous" && "$previous" == "$base/releases/"* ]] || \
  fail "current release target is outside the releases directory"
bootstrap=0
if [[ -e "$bootstrap_marker" || -L "$bootstrap_marker" ]]; then
  validate_bootstrap_marker "$commit"
  bootstrap=1
fi
if (( bootstrap == 1 )); then
  (( mail_managed == 0 )) || \
    fail "legacy bootstrap cannot safely manage an installed Brain Mail service"
  [[ ! -e "$previous/release.json" ]] || fail "bootstrap marker is stale"
  shallow_health || fail "legacy Brain release is unhealthy"
  previous_commit=""
else
  [[ -f "$previous/release.json" ]] || fail "current release metadata is missing"
  previous_commit="$(read_release_commit "$previous/release.json")"
  verify_release_health "$previous_commit" || \
    fail "active processes do not match current release metadata"
fi

"$runtime" "$transaction" sync-tree "$base" "$stage"
"$runtime" "$transaction" write-pending "$base" "$release" "$commit" >/dev/null
mv "$stage" "$release"
"$runtime" "$transaction" sync-tree "$base" "$release"
[[ "$(run_resolver recheck "$candidate")" == "$commit" ]] || \
  fail "candidate changed immediately before promotion"
"$runtime" "$transaction" begin \
  "$base" "$previous" "$release" "$commit" "$bootstrap" >/dev/null

rollback() {
  local status="${1:-1}"
  trap - ERR HUP INT TERM
  set +e
  if ! "$runtime" "$transaction" ensure \
    "$base" "$previous" "$release" "$commit" "$bootstrap" >/dev/null; then
    echo "CRITICAL: rollback transaction authority could not be restored" >&2
    exit 70
  fi
  if ! atomic_switch "$previous" rollback; then
    echo "CRITICAL: could not restore the previous release symlink" >&2
    exit 70
  fi
  if ! restart_release_services; then
    echo "CRITICAL: previous Brain release services did not restart" >&2
    exit 70
  fi
  if (( bootstrap == 1 )); then
    if ! ensure_bootstrap_marker "$commit" || ! wait_for_shallow_health; then
      echo "CRITICAL: legacy Brain release is unhealthy after rollback" >&2
      exit 70
    fi
  elif ! wait_for_release_health "$previous_commit"; then
    echo "CRITICAL: previous Brain release services are unhealthy after rollback" >&2
    exit 70
  fi
  if ! remove_candidate_release "$release"; then
    echo "CRITICAL: rollback succeeded but candidate release remains" >&2
    exit 70
  fi
  if ! clear_pending_if_matching "$release" "$commit"; then
    echo "CRITICAL: rollback succeeded but pending marker remains" >&2
    exit 70
  fi
  if ! "$runtime" "$transaction" clear "$base"; then
    if [[ -e "$transaction_journal" || -L "$transaction_journal" ]] || \
      ! sync_base; then
      echo "CRITICAL: rollback succeeded but transaction journal is not durably cleared" >&2
      exit 70
    fi
  fi
  exit "$status"
}

trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

atomic_switch "$release" promote
restart_release_services

for _attempt in 1 2 3 4 5; do
  if (( _attempt == 1 )); then
    # The first request initializes and indexes the full notes tree. Later
    # retries remain short so an actual deadlock still reaches rollback.
    deep_health_max_time=120
  else
    deep_health_max_time=10
  fi
  if verify_release_health "$commit"; then
    [[ "$(run_resolver recheck "$candidate")" == "$commit" ]]
    if (( bootstrap == 1 )); then
      rm -f -- "$bootstrap_marker"
      sync_base
    fi
    "$runtime" "$transaction" clear-pending "$base" "$release" "$commit"
    "$runtime" "$transaction" clear "$base"
    trap - ERR HUP INT TERM

    seen=0
    while IFS= read -r old_release; do
      [[ "$old_release" == "$base/releases/"* ]] || continue
      release_name="${old_release##*/}"
      [[ "$release_name" =~ ^[A-Za-z0-9._-]+$ ]] || continue
      ((seen += 1))
      if (( seen <= 7 )) || \
        [[ "$old_release" == "$release" || "$old_release" == "$previous" ]]; then
        continue
      fi
      if ! rm -rf --one-file-system -- "$old_release"; then
        echo "warning: could not prune old release $old_release" >&2
      fi
    done < <(
      find "$base/releases" -mindepth 1 -maxdepth 1 -type d \
        -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-
    )
    echo "brain deploy puller: deployed $release_id ($commit)"
    exit 0
  fi
  sleep 1
done

rollback 1
