#!/usr/bin/env bash
set -Eeuo pipefail

version="${1:?usage: pnpm deploy <version>}"
node scripts/release-version.mjs assert "$version"

host="${BRAIN_DEPLOY_HOST:?set BRAIN_DEPLOY_HOST to the ssh host of your server}"
base="${BRAIN_DEPLOY_BASE:-/opt/brain}"

if [[ ! "$base" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
  [[ "$base" == "/" || "$base" == *"/../"* || "$base" == */.. ]]; then
  echo "BRAIN_DEPLOY_BASE must be a safe absolute path" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "refusing to deploy a dirty working tree" >&2
  exit 1
fi

git fetch --quiet origin "+refs/tags/v$version:refs/tags/v$version"
commit="$(git rev-list -n 1 "refs/tags/v$version")"
release_nonce="$(node -e \
  'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
release_id="${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$release_nonce"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/brain-release.XXXXXX")"
download="$workspace/download"
stage="$workspace/release"
archive="$download/brain-$version-linux-x64.tar.gz"

cleanup() {
  rm -rf -- "$workspace"
}
trap cleanup EXIT

ssh "$host" bash -s -- "$base" <<'PREFLIGHT'
set -Eeuo pipefail
base="$1"
systemctl is-active --quiet brain.service
systemctl is-enabled --quiet brain.service
test "$(systemctl show --property=User --value brain.service)" = "brain"
nginx -t
test -L "$base/current"
if [[ -e "$base/.deploy-transaction.json" || \
  -L "$base/.deploy-transaction.json" || \
  -e "$base/.deploy-pending.json" || \
  -L "$base/.deploy-pending.json" ]]; then
  echo "automatic deployment recovery is pending; refusing manual deploy" >&2
  exit 75
fi
test -x "$base/runtime/current/bin/node"
test "$("$base/runtime/current/bin/node" --version)" = "v22.23.1"
test -f "$base/bin/deploy-transaction.mjs"
test ! -L "$base/bin/deploy-transaction.mjs"
test "$(stat -c '%u:%a' "$base/bin/deploy-transaction.mjs")" = "0:755"
test -f "$base/bin/extract_release.py"
test ! -L "$base/bin/extract_release.py"
test "$(stat -c '%u:%a' "$base/bin/extract_release.py")" = "0:755"
command -v flock >/dev/null
command -v python3 >/dev/null
command -v rg >/dev/null
PREFLIGHT

pnpm check
command -v gh >/dev/null
draft="$(gh release view "v$version" --json isDraft --jq .isDraft)"
if [[ "$draft" != "false" ]]; then
  echo "refusing to deploy v$version: the release is a draft or does not exist" >&2
  exit 1
fi
mkdir -p "$download" "$stage"
gh release download "v$version" \
  --pattern "brain-$version-linux-x64.tar.gz" --pattern SHA256SUMS --dir "$download"
node scripts/verify-checksums.mjs "$download/SHA256SUMS" "$archive" >/dev/null
tar -xzf "$archive" -C "$stage"
test -f "$stage/server.js"
test -f "$stage/brain-next-server.js"
test -f "$stage/brain-shutdown-preload.mjs"
test -d "$stage/.next/static"
test -d "$stage/public"
test -f "$stage/release.json"
mv "$stage/release.json" "$workspace/shipped-release.json"
built_at="$(node -p \
  'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).buildTime' \
  "$workspace/shipped-release.json")"
node scripts/write-release-metadata.mjs \
  "$stage/release.json" "$release_id" "$commit" "$built_at" "" "" \
  "$workspace/shipped-release.json"
release_kb="$(du -sk "$stage" | awk '{print $1}')"
required_kb=$((release_kb * 2 + 262144))

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "working tree changed while preparing the release" >&2
  exit 1
fi

ssh "$host" bash -s -- "$base" "$release_id" "$required_kb" <<'PREPARE'
set -Eeuo pipefail
base="$1"
release_id="$2"
required_kb="$3"
mkdir -p "$base/incoming/$release_id" "$base/releases"
# A failed upload is never promotable. Keep recent incoming directories for
# diagnosis, but remove week-old abandoned manual uploads before measuring
# capacity. Automatic .pull workspaces belong exclusively to the locked puller.
find "$base/incoming" -mindepth 1 -maxdepth 1 -type d \
  ! -name '.pull.*' -mtime +7 -exec rm -rf --one-file-system -- {} +
available_kb="$(df -Pk "$base" | awk 'END { print $4 }')"
if (( available_kb < required_kb )); then
  echo "not enough free space for a Brain release: ${available_kb}KB available, ${required_kb}KB required" >&2
  exit 1
fi
PREPARE
rsync -az --delete "$stage/" "$host:$base/incoming/$release_id/"

ssh "$host" bash -s -- "$base" "$release_id" "$commit" <<'REMOTE'
set -Eeuo pipefail

base="$1"
release_id="$2"
expected_commit="$3"
incoming="$base/incoming/$release_id"
release="$base/releases/$release_id"
current="$base/current"
bootstrap_marker="$base/.bootstrap-deploy-once"
transaction_journal="$base/.deploy-transaction.json"
pending_marker="$base/.deploy-pending.json"
runtime="$base/runtime/current/bin/node"
transaction="$base/bin/deploy-transaction.mjs"
mail_health_parser="$base/bin/read-mail-health-commit.mjs"
extractor="$base/bin/extract_release.py"
max_release_files=100000
max_release_bytes=1073741824

# Promotion, restart, validation, and rollback are one remote critical section.
# Uploads may proceed concurrently because every incoming directory is unique.
exec 9>"$base/.deploy.lock"
if ! flock -w 300 9; then
  echo "timed out waiting for the Brain deployment lock" >&2
  exit 75
fi
if [[ -e "$transaction_journal" || -L "$transaction_journal" || \
  -e "$pending_marker" || -L "$pending_marker" ]]; then
  echo "automatic deployment recovery is pending; refusing manual deploy" >&2
  exit 75
fi
if [[ ! -x "$runtime" || ! -f "$transaction" || -L "$transaction" || \
  "$(stat -c '%u:%a' "$transaction")" != "0:755" || \
  ! -f "$extractor" || -L "$extractor" || \
  "$(stat -c '%u:%a' "$extractor")" != "0:755" ]]; then
  echo "durable deployment helpers are missing or invalid" >&2
  exit 1
fi
command -v python3 >/dev/null || {
  echo "python3 is required for remote release-tree verification" >&2
  exit 1
}

mail_managed=0

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
  load_state="$(systemctl show --property=LoadState --value brain.service)" || return 1
  [[ "$load_state" == "loaded" ]] || return 1
  service_user="$(systemctl show --property=User --value brain.service)" || return 1
  [[ "$service_user" == "brain" ]] || return 1

  mail_service_load="$(read_unit_load_state brain-mail.service)" || return 1
  mail_socket_load="$(read_unit_load_state brain-mail.socket)" || return 1
  mail_mime_socket_load="$(read_unit_load_state brain-mail-mime.socket)" || return 1
  # systemctl rejects a bare template name (`name@.service`) for `show`.
  # Probe the installed template through a concrete, never-started instance.
  mail_mime_service_load="$(read_unit_load_state brain-mail-mime@brain-deploy-probe.service)" || \
    return 1
  brain_dropins="$(systemctl show --property=DropInPaths --value brain.service)" || \
    return 1
  brain_supplementary_groups="$(systemctl show \
    --property=SupplementaryGroups --value brain.service)" || return 1

  if [[ "$mail_service_load" == "loaded" ]]; then
    [[ "$mail_socket_load" == "loaded" && \
      "$mail_mime_socket_load" == "loaded" && \
      "$mail_mime_service_load" == "loaded" && \
      "$brain_dropins" == *"/90-brain-mail-client.conf"* && \
      " $brain_supplementary_groups " == *" brain-mail-client "* ]] || \
      return 1
    service_user="$(systemctl show --property=User --value brain-mail.service)" || \
      return 1
    [[ "$service_user" == "brain-mail" ]] || return 1
    mail_managed=1
  elif [[ "$mail_socket_load" == "not-found" && \
    "$mail_mime_socket_load" == "not-found" && \
    "$mail_mime_service_load" == "not-found" && \
    "$brain_dropins" != *"/90-brain-mail-client.conf"* && \
    " $brain_supplementary_groups " != *" brain-mail-client "* ]]; then
    mail_managed=0
  else
    return 1
  fi
}

assert_release_services_active() {
  systemctl is-active --quiet brain.service || return 1
  if (( mail_managed == 1 )); then
    systemctl is-active --quiet brain-mail.socket || return 1
    systemctl is-active --quiet brain-mail-mime.socket || return 1
    systemctl is-active --quiet brain-mail.service || return 1
  fi
}

restart_release_services() {
  if (( mail_managed == 1 )); then
    systemctl restart brain-mail.service || return 1
  fi
  systemctl restart brain.service
}

if ! assert_release_service_identity || ! assert_release_services_active; then
  echo "Brain release service installation is incomplete or inactive" >&2
  exit 1
fi
if (( mail_managed == 1 )) && \
  [[ ! -f "$mail_health_parser" || -L "$mail_health_parser" || \
    "$(stat -c '%u:%a' "$mail_health_parser")" != "0:644" ]]; then
  echo "Brain Mail deployment health helper is missing or invalid" >&2
  exit 1
fi

# Keep the internal readiness credential out of argv/process listings. The
# environment file is trusted root-managed configuration and the token format
# is intentionally plain hex so it can be read without eval/source.
readiness_token="$(sed -n 's/^BRAIN_READINESS_TOKEN=//p' \
  /etc/brain/brain.env)"
if [[ ! "$readiness_token" =~ ^[a-f0-9]{64}$ ]]; then
  echo "BRAIN_READINESS_TOKEN is missing or malformed" >&2
  exit 1
fi
deep_health_max_time=10

deep_health() {
  printf 'header = "X-Brain-Readiness: %s"\n' "$readiness_token" | \
    curl -q --noproxy '*' --fail --silent --show-error \
      --max-time "$deep_health_max_time" --config - \
      'http://127.0.0.1:3020/api/health?ready=1'
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

mail_health() {
  (( mail_managed == 1 )) || return 1
  curl -q --noproxy '*' --fail --silent --show-error --max-time 10 \
    --unix-socket /run/brain-mail/brain-mail.sock \
    http://brain-mail/v1/health
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

[[ -d "$incoming" && ! -L "$incoming" ]]
[[ -f "$incoming/server.js" && ! -L "$incoming/server.js" ]]
[[ -f "$incoming/brain-next-server.js" && ! -L "$incoming/brain-next-server.js" ]]
[[ -f "$incoming/brain-shutdown-preload.mjs" && ! -L "$incoming/brain-shutdown-preload.mjs" ]]
[[ -f "$incoming/release.json" && ! -L "$incoming/release.json" ]]
test -L "$current"
[[ ! -e "$release" && ! -L "$release" ]]
test "$(read_release_commit "$incoming/release.json")" = "$expected_commit"

# rsync archive mode preserves the local sender's ownership and permissions
# when the SSH receiver is root. Normalize the uploaded tree to the same
# immutable release contract as the automatic puller before any durable marker
# can name it. Symlinks are allowed, but special entries and shared inodes are
# not release material.
unsafe_entry="$(find "$incoming" -xdev \
  ! -type d ! -type f ! -type l -print -quit)"
if [[ -n "$unsafe_entry" ]]; then
  echo "manual release contains a special filesystem entry" >&2
  exit 1
fi
hardlink="$(find "$incoming" -xdev -type f -links +1 -print -quit)"
if [[ -n "$hardlink" ]]; then
  echo "manual release contains a hard-linked file" >&2
  exit 1
fi
chown -R --no-dereference root:brain "$incoming"
find "$incoming" -xdev -type d -exec chmod 0550 {} +
find "$incoming" -xdev -type f -exec chmod 0440 {} +
ownership_mismatch="$(find "$incoming" -xdev \
  \( ! -user root -o ! -group brain \) -print -quit)"
mode_mismatch="$(find "$incoming" -xdev \
  \( \( -type d ! -perm 0550 \) -o \( -type f ! -perm 0440 \) \) \
  -print -quit)"
if [[ -n "$ownership_mismatch" || -n "$mode_mismatch" ]]; then
  echo "manual release ownership or mode normalization failed" >&2
  exit 1
fi
env -i \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  BRAIN_DEPLOY_MAX_RELEASE_FILES="$max_release_files" \
  BRAIN_DEPLOY_MAX_RELEASE_BYTES="$max_release_bytes" \
  python3 "$extractor" verify-tree "$incoming" >/dev/null

previous="$(readlink -f "$current")"
test -d "$previous"
bootstrap=0
if [[ -e "$bootstrap_marker" || -L "$bootstrap_marker" ]]; then
  if [[ -L "$bootstrap_marker" || ! -f "$bootstrap_marker" ]] || \
    [[ "$(stat -c '%u:%a' "$bootstrap_marker")" != "0:600" ]]; then
    echo "invalid bootstrap marker; expected a root-owned 0600 regular file" >&2
    exit 1
  fi
  bootstrap_commit="$(<"$bootstrap_marker")"
  if [[ ! "$bootstrap_commit" =~ ^[a-f0-9]{40}$ || \
    "$bootstrap_commit" != "$expected_commit" ]]; then
    echo "bootstrap marker does not authorize this release commit" >&2
    exit 1
  fi
  bootstrap=1
fi

if (( bootstrap == 1 )); then
  # The one-time PM2 bootstrap predates release.json and authenticated deep
  # health. Only this explicit root-owned marker permits a shallow baseline.
  if [[ -e "$previous/release.json" ]]; then
    echo "bootstrap marker is stale: current already has release metadata" >&2
    exit 1
  fi
  if (( mail_managed == 1 )); then
    echo "legacy bootstrap cannot safely manage an installed Brain Mail service" >&2
    exit 1
  fi
  curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    --output /dev/null http://127.0.0.1:3020/login
  previous_commit=""
else
  test -f "$previous/release.json"
  previous_release_commit="$(read_release_commit "$previous/release.json")"
  previous_commit="$previous_release_commit"
  if ! verify_release_health "$previous_commit"; then
    echo "active processes do not match current release metadata" >&2
    exit 1
  fi
fi

sync_base() {
  "$runtime" "$transaction" sync "$base"
}

sync_releases() {
  "$runtime" "$transaction" sync-releases "$base"
}

atomic_switch() {
  local target="$1"
  local label="$2"
  local link="$base/.current-manual-$label-$$"
  [[ -d "$target" && ! -L "$target" && "$target" == "$base/releases/"* ]] || \
    return 1
  rm -f -- "$link"
  ln -s "$target" "$link"
  mv -Tf "$link" "$current"
  sync_base
}

remove_candidate_release() {
  local current_target
  current_target="$(readlink -f "$current")" || return 1
  [[ "$current_target" != "$release" ]] || return 1
  if [[ -e "$release" || -L "$release" ]]; then
    [[ -d "$release" && ! -L "$release" ]] || return 1
    rm -rf --one-file-system -- "$release" || return 1
    [[ ! -e "$release" && ! -L "$release" ]] || return 1
  fi
  sync_releases
}

clear_pending_if_present() {
  if [[ -e "$pending_marker" || -L "$pending_marker" ]]; then
    "$runtime" "$transaction" clear-pending \
      "$base" "$release" "$expected_commit"
  fi
}

wait_for_previous_health() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if (( bootstrap == 0 )); then
      if verify_release_health "$previous_commit"; then
        return 0
      fi
    elif curl --noproxy '*' --fail --silent --show-error --max-time 5 \
      --output /dev/null http://127.0.0.1:3020/login; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_bootstrap_marker() {
  local authorized
  if [[ -e "$bootstrap_marker" || -L "$bootstrap_marker" ]]; then
    [[ -f "$bootstrap_marker" && ! -L "$bootstrap_marker" && \
      "$(stat -c '%u:%a' "$bootstrap_marker")" == "0:600" ]] || return 1
    authorized="$(<"$bootstrap_marker")"
    [[ "$authorized" == "$expected_commit" ]] || return 1
    return 0
  fi
  "$runtime" "$transaction" write-bootstrap "$base" "$expected_commit"
}

rollback() {
  local status="${1:-1}"
  local current_target
  trap - ERR HUP INT TERM
  set +e
  current_target="$(readlink -f "$current")" || {
    echo "CRITICAL: current release could not be resolved during rollback" >&2
    exit 70
  }
  if [[ "$current_target" != "$previous" && \
    "$current_target" != "$release" ]]; then
    echo "CRITICAL: current points outside the manual deployment transaction" >&2
    exit 70
  fi
  if [[ -e "$transaction_journal" || -L "$transaction_journal" || \
    "$current_target" == "$release" ]]; then
    # clearTransaction commits only after unlink + directory fsync. If unlink
    # succeeded but that fsync failed, the journal is absent in this namespace
    # while the command still failed. The in-process trap retains the exact
    # previous/release authority. Recreate it durably before rollback can fsync
    # any change to current.
    if ! "$runtime" "$transaction" ensure \
      "$base" "$previous" "$release" "$expected_commit" "$bootstrap" \
      >/dev/null; then
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
    if (( bootstrap == 1 )) && ! ensure_bootstrap_marker; then
      echo "CRITICAL: could not restore the bootstrap deployment authority" >&2
      exit 70
    fi
    if ! wait_for_previous_health; then
      echo "CRITICAL: rollback completed but the previous release is unhealthy" >&2
      exit 70
    fi
  fi
  if ! remove_candidate_release; then
    echo "CRITICAL: could not remove the interrupted manual release" >&2
    exit 70
  fi
  if ! clear_pending_if_present; then
    echo "CRITICAL: could not clear the manual deployment pending marker" >&2
    exit 70
  fi
  if [[ -e "$transaction_journal" || -L "$transaction_journal" ]]; then
    if ! "$runtime" "$transaction" clear "$base"; then
      if [[ -e "$transaction_journal" || -L "$transaction_journal" ]] || \
        ! sync_base; then
        echo "CRITICAL: could not durably clear the manual deployment journal" >&2
        exit 70
      fi
    fi
  fi
  exit "$status"
}

trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

"$runtime" "$transaction" sync-tree "$base" "$incoming"
"$runtime" "$transaction" write-pending \
  "$base" "$release" "$expected_commit" >/dev/null
mv "$incoming" "$release"
"$runtime" "$transaction" sync-tree "$base" "$release"
"$runtime" "$transaction" begin \
  "$base" "$previous" "$release" "$expected_commit" "$bootstrap" >/dev/null
atomic_switch "$release" promote

restart_release_services

for attempt in 1 2 3 4 5; do
  if (( attempt == 1 )); then
    # A cold Store rebuild walks the complete notes tree. Give only the first
    # probe enough time for that bounded startup work; retries stay short so a
    # genuinely stuck release still rolls back promptly.
    deep_health_max_time=120
  else
    deep_health_max_time=10
  fi
  if verify_release_health "$expected_commit"; then
    if (( bootstrap == 1 )); then
      # Successful first immutable release permanently closes the weaker
      # bootstrap path. Recovery recreates it if a crash happens before
      # the transaction is committed.
      rm -f -- "$bootstrap_marker"
      sync_base
    fi
    "$runtime" "$transaction" clear-pending \
      "$base" "$release" "$expected_commit"
    "$runtime" "$transaction" clear "$base"
    trap - ERR HUP INT TERM
    # Retain the seven newest immutable releases. Always preserve the active
    # release and its immediate rollback target, even if mtimes were changed.
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
    exit 0
  fi
  sleep 1
done

rollback 1
REMOTE

echo "deployed $release_id ($commit)"
