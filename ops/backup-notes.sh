#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

notes_root="${NOTES_ROOT:-/opt/brain/notes}"
backup_root="${BRAIN_BACKUP_ROOT:-/opt/brain/backups}"
healthcheck_url="${BRAIN_BACKUP_HEALTHCHECK_URL:-}"
node_runtime="${BRAIN_NODE_RUNTIME:-/opt/brain/runtime/current/bin/node}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="${BRAIN_BACKUP_VERIFIER:-$script_dir/verify-notes-backup.py}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_dir=""
status_temporary=""
attempt_temporary=""
attempt_path=""
attempt_started_at=""
attempt_owned=0
failure_code="setup_failed"
published_archive=""
publish_phase="initial"
test_mode="${BRAIN_BACKUP_TEST_MODE:-}"
test_fault="${BRAIN_BACKUP_TEST_FAULT:-}"

fsync_path() {
  "$node_runtime" -e '
    const fs = require("node:fs");
    const descriptor = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  ' "$1"
}

inject_test_fault() {
  local boundary=$1
  if [[ "$test_fault" == "$boundary" ]]; then
    echo "injected backup test fault at $boundary" >&2
    return 99
  fi
}

read_status_archive() {
  # shellcheck disable=SC2016 # JavaScript regex and object access are literal.
  "$node_runtime" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const archivePattern =
      /^brain-notes-\d{8}T\d{6}Z-[0-9a-f]{12,64}\.tar\.gz$/;
    if (
      status.status !== "ok" ||
      !archivePattern.test(status.archive) ||
      !/^[0-9a-f]{40,64}$/.test(status.commit) ||
      !Number.isSafeInteger(status.archiveBytes) ||
      status.archiveBytes <= 0 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(status.verifiedAt) ||
      !status.archive.endsWith(`${status.commit.slice(0, 12)}.tar.gz`)
    ) process.exit(1);
    const archive = path.join(process.argv[2], status.archive);
    const archiveStat = fs.lstatSync(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() ||
        archiveStat.size !== status.archiveBytes) process.exit(1);
    process.stdout.write(status.archive);
  ' "$1" "$backup_root"
}

write_attempt_status() {
  local status=$1
  local finished_at=${2:-}
  local safe_failure_code=${3:-}
  if (( attempt_owned == 0 )); then
    return
  fi
  if [[ -L "$attempt_path" || ( -e "$attempt_path" && ! -f "$attempt_path" ) ]]; then
    echo "last-attempt.json is not a regular file" >&2
    return 1
  fi
  attempt_temporary="$(mktemp "$backup_root/.last-attempt.XXXXXX.tmp")"
  if [[ "$status" == "running" && "$test_fault" == "attempt-write-wait" ]]; then
    printf '%s\n' "$$" >"${BRAIN_BACKUP_TEST_SIGNAL_READY_FILE:?}"
    while true; do
      sleep 1
    done
  fi
  # shellcheck disable=SC2016 # JavaScript template literal, not shell expansion.
  "$node_runtime" -e '
    const fs = require("node:fs");
    const [target, status, startedAt, finishedAt, failureCode] =
      process.argv.slice(1);
    const attempt = { version: 1, status, startedAt };
    if (status !== "running") attempt.finishedAt = finishedAt;
    if (status === "failed") attempt.failureCode = failureCode;
    fs.writeFileSync(target, `${JSON.stringify(attempt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  ' "$attempt_temporary" "$status" "$attempt_started_at" "$finished_at" \
    "$safe_failure_code"
  fsync_path "$attempt_temporary"
  mv "$attempt_temporary" "$attempt_path"
  attempt_temporary=""
  fsync_path "$backup_root"
}

report_failure() {
  local status=$?
  if (( status == 0 )); then
    return
  fi
  set +e
  # EXIT cleanup must be non-reentrant. If a signal interrupted an atomic
  # attempt write, remove its unpublished temp before writing the terminal
  # status with signals ignored.
  trap '' INT TERM HUP
  if [[ -n "$attempt_temporary" ]]; then
    rm -f -- "$attempt_temporary"
    attempt_temporary=""
  fi
  if (( attempt_owned == 1 )); then
    write_attempt_status \
      "failed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$failure_code" || true
  fi
  logger -p user.err -t brain-backup "backup failed with status $status"
  if [[ -n "$healthcheck_url" ]]; then
    curl --fail --silent --show-error --max-time 10 \
      --retry 2 --data-raw "backup failed with status $status" \
      "$healthcheck_url/fail" >/dev/null || true
  fi
  if [[ -n "$status_temporary" ]]; then
    rm -f -- "$status_temporary"
  fi
  if [[ -n "$attempt_temporary" ]]; then
    rm -f -- "$attempt_temporary"
  fi
  if [[ -n "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
  case "$publish_phase" in
    initial|staging|archive-renamed|archive-file-synced|archive-dir-synced)
      if [[ -n "$published_archive" ]]; then
        rm -f -- "$published_archive"
        fsync_path "$backup_root" >/dev/null 2>&1 || true
      fi
      ;;
  esac
  return "$status"
}
trap report_failure EXIT

mark_interrupted() {
  failure_code="interrupted"
  exit 130
}
trap mark_interrupted INT TERM HUP

test -x "$node_runtime"
test -x "$verifier"
if [[ -n "$test_fault" && "$test_mode" != "1" ]]; then
  echo "backup fault injection requires explicit test mode" >&2
  exit 64
fi
case "$test_fault" in
  ""|archive-rename|archive-file-fsync|archive-dir-fsync|status-temp-fsync|\
status-rename|status-dir-fsync|retention|attempt-write-wait)
    ;;
  *)
    echo "unknown backup fault injection boundary" >&2
    exit 64
    ;;
esac
if ! command -v flock >/dev/null; then
  echo "flock is required for Brain backups" >&2
  exit 127
fi
mkdir -p "$backup_root"
exec 9>"$backup_root/.backup.lock"
if ! flock -n 9; then
  # The EXIT trap is already armed. This loser has not created a temporary
  # archive, so it reports the overlap without touching the running backup.
  echo "another Brain notes backup is already running" >&2
  exit 75
fi
attempt_path="$backup_root/last-attempt.json"
attempt_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
attempt_owned=1
write_attempt_status "running"

failure_code="setup_failed"
"$verifier" --cleanup-stale-staging "$backup_root"

status_path="$backup_root/last-success.json"
previous_status_archive=""
if [[ -L "$status_path" || ( -e "$status_path" && ! -f "$status_path" ) ]]; then
  echo "last-success.json is not a regular file" >&2
  exit 1
fi
if [[ -f "$status_path" ]]; then
  previous_status_archive="$(read_status_archive "$status_path")"
  previous_status_path="$backup_root/$previous_status_archive"
  if [[ -L "$previous_status_path" || ! -f "$previous_status_path" ]]; then
    echo "last-success.json references a missing or unusual archive" >&2
    exit 1
  fi
fi

failure_code="source_check_failed"
git -C "$notes_root" fsck --no-dangling
snapshot_commit="$(git -C "$notes_root" rev-parse --verify HEAD)"
if [[ -n "$(git -C "$notes_root" status --porcelain)" ]]; then
  echo "notes repository has uncommitted changes" >&2
  exit 1
fi
failure_code="offsite_copy_failed"
git -C "$notes_root" push --porcelain origin "$snapshot_commit:refs/heads/main"

archive_basename="brain-notes-$timestamp-${snapshot_commit:0:12}.tar.gz"
archive="$backup_root/$archive_basename"
if [[ -e "$archive" || -L "$archive" ]]; then
  echo "refusing to replace an existing Brain notes archive" >&2
  exit 1
fi
failure_code="capacity_check_failed"
staging_dir="$(mktemp -d "$backup_root/.brain-notes-$timestamp.XXXXXX")"
publish_phase="staging"
temporary="$staging_dir/$archive_basename"
restore_dir="$staging_dir/restore"
"$verifier" --preflight-staging "$staging_dir"
mkdir -m 0700 "$restore_dir"
failure_code="archive_create_failed"
(
  "$verifier" --bounded-git-archive \
    "$notes_root" "$temporary" "$snapshot_commit"
)
gzip -t "$temporary"
failure_code="archive_check_failed"
"$verifier" "$temporary" "$restore_dir"
rm -rf -- "$restore_dir"
# After the atomic rename, fsync both the verified inode and its parent directory
# so a reported success survives a power loss, not only a clean process exit.
failure_code="publish_failed"
fsync_path "$temporary"
mv "$temporary" "$archive"
published_archive="$archive"
publish_phase="archive-renamed"
inject_test_fault "archive-rename"
rmdir "$staging_dir"
staging_dir=""
fsync_path "$archive"
publish_phase="archive-file-synced"
inject_test_fault "archive-file-fsync"
fsync_path "$backup_root"
publish_phase="archive-dir-synced"
inject_test_fault "archive-dir-fsync"

archive_bytes="$("$node_runtime" -e '
  const fs = require("node:fs");
  process.stdout.write(String(fs.statSync(process.argv[1]).size));
' "$archive")"
verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status_temporary="$(mktemp "$backup_root/.last-success.XXXXXX.tmp")"
# shellcheck disable=SC2016 # JavaScript template expression, not shell syntax.
"$node_runtime" -e '
  const fs = require("node:fs");
  const [target, archive, commit, archiveBytes, verifiedAt] =
    process.argv.slice(1);
  fs.writeFileSync(
    target,
    `${JSON.stringify({
      status: "ok",
      archive,
      commit,
      archiveBytes: Number(archiveBytes),
      verifiedAt,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
' "$status_temporary" "$archive_basename" "$snapshot_commit" \
  "$archive_bytes" "$verified_at"
fsync_path "$status_temporary"
inject_test_fault "status-temp-fsync"
mv "$status_temporary" "$status_path"
status_temporary=""
publish_phase="status-renamed"
inject_test_fault "status-rename"
fsync_path "$backup_root"
publish_phase="status-durable"
inject_test_fault "status-dir-fsync"

durable_status_archive="$(read_status_archive "$status_path")"
durable_status_path="$backup_root/$durable_status_archive"
if [[ -L "$durable_status_path" || ! -f "$durable_status_path" ]]; then
  echo "durable backup status references a missing or unusual archive" >&2
  exit 1
fi

# Retention starts only after the status rename is directory-synced. It always
# reserves the archive named by the status read back from disk, plus the six
# newest other archives.
failure_code="retention_failed"
archives=()
while IFS= read -r archive_path; do
  archives+=("$archive_path")
done < <(find "$backup_root" -maxdepth 1 -type f \
  -name 'brain-notes-*.tar.gz' -print | sort -r)
kept_other_archives=0
retention_deleted=0
retention_fault_checked=0
for old_archive in "${archives[@]}"; do
  if [[ "$(basename -- "$old_archive")" == "$durable_status_archive" ]]; then
    continue
  fi
  if (( kept_other_archives < 6 )); then
    kept_other_archives=$((kept_other_archives + 1))
    continue
  fi
  rm -f -- "$old_archive"
  retention_deleted=1
  if (( retention_fault_checked == 0 )); then
    retention_fault_checked=1
    inject_test_fault "retention"
  fi
done
if (( retention_fault_checked == 0 )); then
  inject_test_fault "retention"
fi
if (( retention_deleted == 1 )); then
  fsync_path "$backup_root"
fi
publish_phase="retention-complete"

failure_code="completion_report_failed"
if [[ -n "$healthcheck_url" ]]; then
  curl --fail --silent --show-error --max-time 10 --retry 2 \
    "$healthcheck_url" >/dev/null
fi
logger -p user.notice -t brain-backup \
  "backup completed: $archive_basename at $snapshot_commit"
write_attempt_status "success" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
