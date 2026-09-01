#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_script="$repo_root/ops/backup-notes.sh"
verifier="$repo_root/ops/verify-notes-backup.py"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/brain-backup-smoke.XXXXXX")"
notes="$workspace/notes"
remote="$workspace/remote.git"
backups="$workspace/backups"
restore="$workspace/restore"
status_file="$backups/last-success.json"
attempt_file="$backups/last-attempt.json"

# macOS does not ship util-linux flock. Keep the production requirement while
# giving the local smoke the same non-blocking descriptor-lock semantics.
if ! command -v flock >/dev/null; then
  mkdir -m 0700 "$workspace/bin"
  cat >"$workspace/bin/flock" <<'PY'
#!/usr/bin/env python3
import fcntl
import sys

arguments = sys.argv[1:]
nonblocking = arguments and arguments[0] == "-n"
if nonblocking:
    arguments = arguments[1:]
if len(arguments) != 1:
    raise SystemExit(64)
flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
try:
    fcntl.flock(int(arguments[0]), flags)
except BlockingIOError:
    raise SystemExit(1)
PY
  chmod 0700 "$workspace/bin/flock"
  export PATH="$workspace/bin:$PATH"
fi

cleanup() {
  rm -rf -- "$workspace"
}
trap cleanup EXIT

run_backup() {
  NOTES_ROOT="$notes" BRAIN_BACKUP_ROOT="$backups" \
    BRAIN_NODE_RUNTIME="$(command -v node)" \
    BRAIN_BACKUP_VERIFIER="$verifier" \
    bash "$backup_script"
}

run_backup_with_fault() {
  local fault=$1
  NOTES_ROOT="$notes" BRAIN_BACKUP_ROOT="$backups" \
    BRAIN_NODE_RUNTIME="$(command -v node)" \
    BRAIN_BACKUP_VERIFIER="$verifier" \
    BRAIN_BACKUP_TEST_MODE=1 \
    BRAIN_BACKUP_TEST_FAULT="$fault" \
    bash "$backup_script"
}

run_backup_with_limits() {
  local limits=$1
  NOTES_ROOT="$notes" BRAIN_BACKUP_ROOT="$backups" \
    BRAIN_NODE_RUNTIME="$(command -v node)" \
    BRAIN_BACKUP_VERIFIER="$verifier" \
    BRAIN_BACKUP_TEST_MODE=1 \
    BRAIN_BACKUP_TEST_LIMITS_JSON="$limits" \
    bash "$backup_script"
}

status_archive() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(status.archive);
  ' "$status_file"
}

assert_lkg_consistent() {
  # shellcheck disable=SC2016 # JavaScript template expression, not shell syntax.
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, statusPath] = process.argv.slice(1);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (status.status !== "ok" ||
        !/^brain-notes-\d{8}T\d{6}Z-[0-9a-f]{12,64}\.tar\.gz$/
          .test(status.archive) ||
        !/^[0-9a-f]{40,64}$/.test(status.commit) ||
        !status.archive.endsWith(`${status.commit.slice(0, 12)}.tar.gz`))
      throw new Error("invalid LKG status");
    const archive = path.join(root, status.archive);
    const archiveStat = fs.lstatSync(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() ||
        archiveStat.size !== status.archiveBytes)
      throw new Error("LKG archive is missing or unusual");
  ' "$backups" "$status_file"
}

assert_attempt() {
  local expected_status=$1
  local expected_failure=${2:-}
  # shellcheck disable=SC2016 # JavaScript template literal, not shell expansion.
  node -e '
    const fs = require("node:fs");
    const [file, expectedStatus, expectedFailure] = process.argv.slice(1);
    const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedKeys = expectedStatus === "running"
      ? ["startedAt", "status", "version"]
      : expectedStatus === "success"
        ? ["finishedAt", "startedAt", "status", "version"]
        : ["failureCode", "finishedAt", "startedAt", "status", "version"];
    if (JSON.stringify(Object.keys(attempt).sort()) !==
        JSON.stringify(expectedKeys)) throw new Error("unexpected attempt schema");
    if (attempt.version !== 1 || attempt.status !== expectedStatus)
      throw new Error("unexpected attempt status");
    for (const key of ["startedAt", ...(expectedStatus === "running" ? [] : ["finishedAt"])]) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(attempt[key]) ||
          Number.isNaN(Date.parse(attempt[key])))
        throw new Error(`invalid ${key}`);
    }
    if (expectedFailure && attempt.failureCode !== expectedFailure)
      throw new Error(
        `unexpected attempt failure code: expected ${expectedFailure}, got ${attempt.failureCode}`,
      );
  ' "$attempt_file" "$expected_status" "$expected_failure"
}

assert_no_backup_temps() {
  if find "$backups" -maxdepth 1 \
    \( -name '.brain-notes-*' -o -name '.last-success.*.tmp' \
      -o -name '.last-attempt.*.tmp' \) \
    -print -quit | grep -q .; then
    echo "backup left a temporary extraction or status fragment" >&2
    exit 1
  fi
}

git init -q --bare "$remote"
git init -q -b main "$notes"
git -C "$notes" config user.name "Brain Backup Smoke"
git -C "$notes" config user.email "brain-backup-smoke@example.invalid"
printf '%s\n' "backup body" >"$notes/index.md"
git -C "$notes" add index.md
git -C "$notes" commit -q -m "backup fixture"
git -C "$notes" remote add origin "$remote"
snapshot_commit="$(git -C "$notes" rev-parse --verify HEAD)"

run_backup
assert_attempt success

# A TERM during the initial atomic attempt write must publish one terminal
# interrupted record, preserve the older verified backup, and leave no temp.
status_baseline="$workspace/last-success.good.json"
cp "$status_file" "$status_baseline"
signal_ready="$workspace/attempt-signal-ready"
set +e
NOTES_ROOT="$notes" BRAIN_BACKUP_ROOT="$backups" \
  BRAIN_NODE_RUNTIME="$(command -v node)" \
  BRAIN_BACKUP_VERIFIER="$verifier" \
  BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_FAULT="attempt-write-wait" \
  BRAIN_BACKUP_TEST_SIGNAL_READY_FILE="$signal_ready" \
  bash "$backup_script" >/dev/null 2>&1 &
signal_pid=$!
set -e
for _ in {1..100}; do
  [[ -f "$signal_ready" ]] && break
  kill -0 "$signal_pid" 2>/dev/null || break
  sleep 0.05
done
if [[ ! -f "$signal_ready" ]]; then
  echo "backup signal fixture did not reach the attempt write" >&2
  kill "$signal_pid" 2>/dev/null || true
  wait "$signal_pid" 2>/dev/null || true
  exit 1
fi
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"
signal_status=$?
set -e
if (( signal_status == 0 )); then
  echo "backup signal fixture reported success" >&2
  exit 1
fi
assert_attempt failed interrupted
cmp --silent "$status_baseline" "$status_file"
assert_lkg_consistent
assert_no_backup_temps

# An overlapping invocation must fail observably before it creates or removes
# any archive/temp file belonging to the lock holder.
attempt_before_overlap="$workspace/last-attempt.before-overlap.json"
cp "$attempt_file" "$attempt_before_overlap"
exec 8>"$backups/.backup.lock"
flock -n 8
foreign_staging="$backups/.brain-notes-20000101T000003Z.Q1w2E3"
mkdir -m 0700 "$foreign_staging"
printf '%s\n' "owned by lock holder" >"$foreign_staging/keep"
touch -t 200001010000.00 "$foreign_staging"
set +e
overlap_output="$(run_backup 2>&1)"
overlap_status=$?
set -e
exec 8>&-
if (( overlap_status != 75 )); then
  echo "overlapping backup returned $overlap_status instead of 75" >&2
  exit 1
fi
if [[ "$overlap_output" != *"already running"* ]]; then
  echo "overlapping backup did not emit a failure signal" >&2
  exit 1
fi
if [[ "$(<"$foreign_staging/keep")" != "owned by lock holder" ]]; then
  echo "overlapping backup touched the lock holder's staging directory" >&2
  exit 1
fi
cmp --silent "$attempt_before_overlap" "$attempt_file"
rm -rf -- "$foreign_staging"

archives=()
while IFS= read -r archive_path; do
  archives+=("$archive_path")
done < <(find "$backups" -maxdepth 1 -type f \
  -name 'brain-notes-*.tar.gz' -print)
if (( ${#archives[@]} != 1 )); then
  echo "expected one rehearsal-verified backup archive" >&2
  exit 1
fi
archive="${archives[0]}"
archive_basename="$(basename -- "$archive")"

mkdir -m 0700 "$restore"
"$verifier" "$archive" "$restore"
test "$(<"$restore/brain-notes/index.md")" = "backup body"
git --git-dir="$remote" show-ref --verify --quiet refs/heads/main

test -f "$status_file"
# shellcheck disable=SC2016 # JavaScript template expression, not shell syntax.
node -e '
  const fs = require("node:fs");
  const [statusPath, expectedArchive, expectedCommit, archivePath] =
    process.argv.slice(1);
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  const expectedKeys =
    ["archive", "archiveBytes", "commit", "status", "verifiedAt"];
  if (JSON.stringify(Object.keys(status).sort()) !==
      JSON.stringify(expectedKeys)) throw new Error("unexpected status schema");
  if (status.status !== "ok") throw new Error("status is not ok");
  if (status.archive !== expectedArchive) throw new Error("archive mismatch");
  if (status.commit !== expectedCommit) throw new Error("commit mismatch");
  if (!status.archive.endsWith(`${status.commit.slice(0, 12)}.tar.gz`))
    throw new Error("archive does not carry commit prefix");
  if (status.archiveBytes !== fs.statSync(archivePath).size)
    throw new Error("archive byte count mismatch");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(status.verifiedAt) ||
      Number.isNaN(Date.parse(status.verifiedAt)))
    throw new Error("verifiedAt is not UTC");
' "$status_file" "$archive_basename" "$snapshot_commit" "$archive"

cp "$status_file" "$status_baseline"

# Simulate a power loss that leaves both the compressed-output and raw-tar
# staging files behind. The next lock holder removes only this old, exact-name,
# private tree; fresh, linked, and unusual lookalikes must survive untouched.
previous_lkg_archive="$(status_archive)"
crash_staging="$backups/.brain-notes-20000101T000000Z.A1b2C3"
mkdir -m 0700 "$crash_staging"
printf '%s\n' "partial gzip after power loss" \
  >"$crash_staging/brain-notes-20000101T000000Z-aaaaaaaaaaaa.tar.gz"
mkdir -m 0700 "$crash_staging/restore"
printf '%s\n' "partial raw tar after power loss" \
  >"$crash_staging/restore/.brain-notes-tar-crash.tmp"
touch -t 200001010000.00 "$crash_staging"

fresh_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
fresh_staging="$backups/.brain-notes-$fresh_timestamp.D4e5F6"
mkdir -m 0700 "$fresh_staging"
printf '%s\n' "fresh foreign work" >"$fresh_staging/keep"

linked_staging="$backups/.brain-notes-20000101T000001Z.G7h8I9"
linked_sentinel="$workspace/linked-staging-sentinel"
printf '%s\n' "do not follow" >"$linked_sentinel"
ln -s "$linked_sentinel" "$linked_staging"

unusual_staging="$backups/.brain-notes-20000101T000002Z.J1k2L3"
mkdir -m 0700 "$unusual_staging"
ln -s "$linked_sentinel" "$unusual_staging/unsafe-link"
touch -t 200001010000.00 "$unusual_staging"

printf '%s\n' "crash recovery" >"$notes/index.md"
git -C "$notes" add index.md
git -C "$notes" commit -q -m "crash recovery fixture"
crash_recovery_commit="$(git -C "$notes" rev-parse --verify HEAD)"
run_backup
assert_attempt success

if [[ -e "$crash_staging" || -L "$crash_staging" ]]; then
  echo "next backup did not remove abandoned staging residue" >&2
  exit 1
fi
test -d "$fresh_staging"
test "$(<"$fresh_staging/keep")" = "fresh foreign work"
test -L "$linked_staging"
test "$(<"$linked_sentinel")" = "do not follow"
test -d "$unusual_staging"
test -L "$unusual_staging/unsafe-link"
test -f "$backups/$previous_lkg_archive"
assert_lkg_consistent
if [[ "$(status_archive)" != *"-${crash_recovery_commit:0:12}.tar.gz" ]]; then
  echo "crash-recovery backup did not publish its consistent LKG" >&2
  exit 1
fi
rm -rf -- "$fresh_staging" "$unusual_staging"
rm -f -- "$linked_staging"
assert_no_backup_temps
cp "$status_file" "$status_baseline"

unsafe_root="$workspace/unsafe"
mkdir -m 0700 "$unsafe_root"
python3 - "$unsafe_root" <<'PY'
import io
from pathlib import Path
import sys
import tarfile

root = Path(sys.argv[1])

def fixture(name, entry):
    with tarfile.open(root / name, "w:gz") as archive:
        directory = tarfile.TarInfo("brain-notes/")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        archive.addfile(directory)
        if entry.isreg():
            body = b"unsafe"
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
        else:
            archive.addfile(entry)

entries = [
    ("brain-notes-20260101T000001Z-aaaaaaaaaaaa.tar.gz",
     tarfile.TarInfo("brain-notes/../escape")),
    ("brain-notes-20260101T000002Z-bbbbbbbbbbbb.tar.gz",
     tarfile.TarInfo("/brain-notes/escape")),
    ("brain-notes-20260101T000003Z-cccccccccccc.tar.gz",
     tarfile.TarInfo("outside.txt")),
]

symlink = tarfile.TarInfo("brain-notes/link")
symlink.type = tarfile.SYMTYPE
symlink.linkname = "index.md"
entries.append(("brain-notes-20260101T000004Z-dddddddddddd.tar.gz", symlink))

hardlink = tarfile.TarInfo("brain-notes/hardlink")
hardlink.type = tarfile.LNKTYPE
hardlink.linkname = "brain-notes/index.md"
entries.append(("brain-notes-20260101T000005Z-eeeeeeeeeeee.tar.gz", hardlink))

device = tarfile.TarInfo("brain-notes/device")
device.type = tarfile.CHRTYPE
device.devmajor = 1
device.devminor = 3
entries.append(("brain-notes-20260101T000006Z-ffffffffffff.tar.gz", device))

for name, entry in entries:
    fixture(name, entry)

with tarfile.open(
    root / "brain-notes-20260101T000008Z-222222222222.tar.gz",
    "w:gz",
) as archive:
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    directory.mode = 0o700
    archive.addfile(directory)
    body = b"A" * 4096
    regular = tarfile.TarInfo("brain-notes/payload.txt")
    regular.size = len(body)
    archive.addfile(regular, io.BytesIO(body))

with tarfile.open(
    root / "brain-notes-20260101T000009Z-333333333333.tar.gz",
    "w:gz",
    format=tarfile.PAX_FORMAT,
) as archive:
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    archive.addfile(directory)
    body = b"pax"
    regular = tarfile.TarInfo("brain-notes/pax.txt")
    regular.size = len(body)
    regular.pax_headers = {"comment": "P" * 2048}
    archive.addfile(regular, io.BytesIO(body))

with tarfile.open(
    root / "brain-notes-20260101T000010Z-444444444444.tar.gz",
    "w:gz",
    format=tarfile.GNU_FORMAT,
) as archive:
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    archive.addfile(directory)
    body = b"gnu"
    regular = tarfile.TarInfo(f"brain-notes/{'g' * 300}.txt")
    regular.size = len(body)
    archive.addfile(regular, io.BytesIO(body))

with tarfile.open(
    root / "brain-notes-20260101T000011Z-555555555555.tar.gz",
    "w:gz",
) as archive:
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    archive.addfile(directory)
    for index in range(4):
        body = b"path"
        regular = tarfile.TarInfo(
            f"brain-notes/path-budget-{index:02d}-{'p' * 30}.txt"
        )
        regular.size = len(body)
        archive.addfile(regular, io.BytesIO(body))

with tarfile.open(
    root / "brain-notes-20260101T000012Z-666666666666.tar.gz",
    "w:gz",
) as archive:
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    directory.size = 1
    archive.addfile(directory, io.BytesIO(b"x"))
    body = b"file"
    regular = tarfile.TarInfo("brain-notes/file.txt")
    regular.size = len(body)
    archive.addfile(regular, io.BytesIO(body))

def pax_record(key, value):
    body = f"{key}={value}\n".encode()
    length = len(body) + 2
    while True:
        record = f"{length} ".encode() + body
        if len(record) == length:
            return record
        length = len(record)

with tarfile.open(
    root / "brain-notes-20260101T000013Z-777777777777.tar.gz",
    "w:gz",
    format=tarfile.PAX_FORMAT,
) as archive:
    for index in range(3):
        payload = pax_record(f"brain.test.key{index}", "M" * 80)
        metadata = tarfile.TarInfo(f"global-pax-{index}")
        metadata.type = tarfile.XGLTYPE
        metadata.size = len(payload)
        archive.addfile(metadata, io.BytesIO(payload))
    directory = tarfile.TarInfo("brain-notes/")
    directory.type = tarfile.DIRTYPE
    archive.addfile(directory)
    body = b"aggregate metadata"
    regular = tarfile.TarInfo("brain-notes/metadata.txt")
    regular.size = len(body)
    archive.addfile(regular, io.BytesIO(body))
PY
printf '%s\n' "not a gzip archive" \
  >"$unsafe_root/brain-notes-20260101T000007Z-111111111111.tar.gz"

compressible_archive="$unsafe_root/brain-notes-20260101T000008Z-222222222222.tar.gz"
pax_archive="$unsafe_root/brain-notes-20260101T000009Z-333333333333.tar.gz"
gnu_archive="$unsafe_root/brain-notes-20260101T000010Z-444444444444.tar.gz"
path_budget_archive="$unsafe_root/brain-notes-20260101T000011Z-555555555555.tar.gz"
directory_body_archive="$unsafe_root/brain-notes-20260101T000012Z-666666666666.tar.gz"
aggregate_metadata_archive="$unsafe_root/brain-notes-20260101T000013Z-777777777777.tar.gz"
for unsafe_archive in \
  "$unsafe_root"/brain-notes-20260101T00000[1-7]Z-*.tar.gz \
  "$directory_body_archive"; do
  rejected_restore="$workspace/rejected-restore"
  rm -rf -- "$rejected_restore"
  mkdir -m 0700 "$rejected_restore"
  set +e
  "$verifier" "$unsafe_archive" "$rejected_restore" >/dev/null 2>&1
  verify_status=$?
  set -e
  if (( verify_status == 0 )); then
    echo "unsafe or corrupt archive passed rehearsal" >&2
    exit 1
  fi
  if find "$rejected_restore" -mindepth 1 -print -quit | grep -q .; then
    echo "rejected archive left extracted content" >&2
    exit 1
  fi
  cmp --silent "$status_baseline" "$status_file"
done

limit_cases=(
  '{"maxArchiveBytes":1}'
  '{"maxDecompressedTarBytes":1024}'
  '{"maxMembers":1}'
  '{"maxNormalizedPathBytes":5}'
  '{"maxPathDepth":1}'
  '{"maxFileBytes":1}'
  '{"maxTotalUncompressedBytes":1}'
  '{"minFreeHeadroomBytes":9223372036854775807}'
)
for limits in "${limit_cases[@]}"; do
  rejected_restore="$workspace/rejected-restore"
  rm -rf -- "$rejected_restore"
  mkdir -m 0700 "$rejected_restore"
  set +e
  BRAIN_BACKUP_TEST_MODE=1 BRAIN_BACKUP_TEST_LIMITS_JSON="$limits" \
    "$verifier" "$archive" "$rejected_restore" >/dev/null 2>&1
  verify_status=$?
  set -e
  if (( verify_status == 0 )); then
    echo "resource-bound archive passed rehearsal" >&2
    exit 1
  fi
  if find "$rejected_restore" -mindepth 1 -print -quit | grep -q .; then
    echo "resource-bound rejection left extracted content" >&2
    exit 1
  fi
  cmp --silent "$status_baseline" "$status_file"
done

rejected_restore="$workspace/rejected-restore"
rm -rf -- "$rejected_restore"
mkdir -m 0700 "$rejected_restore"
set +e
aggregate_metadata_output="$(BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxTarMetadataBytes":128,"maxTotalTarMetadataBytes":200}' \
  "$verifier" "$aggregate_metadata_archive" "$rejected_restore" 2>&1)"
aggregate_metadata_status=$?
set -e
if (( aggregate_metadata_status == 0 )); then
  echo "aggregate PAX metadata passed rehearsal" >&2
  exit 1
fi
if [[ "$aggregate_metadata_output" != *"aggregate tar metadata byte limit"* ]]; then
  echo "global PAX fixture did not reach the aggregate metadata guard" >&2
  exit 1
fi
test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
cmp --silent "$status_baseline" "$status_file"

rejected_restore="$workspace/rejected-restore"
rm -rf -- "$rejected_restore"
mkdir -m 0700 "$rejected_restore"
set +e
metadata_count_output="$(BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxTarMetadataRecords":2}' \
  "$verifier" "$aggregate_metadata_archive" "$rejected_restore" 2>&1)"
metadata_count_status=$?
set -e
if (( metadata_count_status == 0 )); then
  echo "excessive PAX metadata record count passed rehearsal" >&2
  exit 1
fi
if [[ "$metadata_count_output" != *"metadata record count limit"* ]]; then
  echo "global PAX fixture did not reach the metadata count guard" >&2
  exit 1
fi
test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
cmp --silent "$status_baseline" "$status_file"

rejected_restore="$workspace/rejected-restore"
rm -rf -- "$rejected_restore"
mkdir -m 0700 "$rejected_restore"
set +e
BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxCompressionRatio":1}' \
  "$verifier" "$compressible_archive" "$rejected_restore" >/dev/null 2>&1
compression_status=$?
set -e
if (( compression_status == 0 )); then
  echo "compression-ratio archive passed rehearsal" >&2
  exit 1
fi
test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
cmp --silent "$status_baseline" "$status_file"

for metadata_archive in "$pax_archive" "$gnu_archive"; do
  rejected_restore="$workspace/rejected-restore"
  rm -rf -- "$rejected_restore"
  mkdir -m 0700 "$rejected_restore"
  set +e
  metadata_output="$(BRAIN_BACKUP_TEST_MODE=1 \
    BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxTarMetadataBytes":128}' \
    "$verifier" "$metadata_archive" "$rejected_restore" 2>&1)"
  metadata_status=$?
  set -e
  if (( metadata_status == 0 )); then
    echo "oversized PAX or GNU metadata passed rehearsal" >&2
    exit 1
  fi
  if [[ "$metadata_output" != *"PAX or GNU metadata byte limit"* ]]; then
    echo "metadata fixture did not reach the raw tar metadata guard" >&2
    exit 1
  fi
  test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
  cmp --silent "$status_baseline" "$status_file"
done

rejected_restore="$workspace/rejected-restore"
rm -rf -- "$rejected_restore"
mkdir -m 0700 "$rejected_restore"
set +e
path_budget_output="$(BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxTotalNormalizedPathBytes":50}' \
  "$verifier" "$path_budget_archive" "$rejected_restore" 2>&1)"
path_budget_status=$?
set -e
if (( path_budget_status == 0 )); then
  echo "aggregate normalized path budget passed rehearsal" >&2
  exit 1
fi
if [[ "$path_budget_output" != *"aggregate normalized path byte limit"* ]]; then
  echo "path fixture did not reach the aggregate path guard" >&2
  exit 1
fi
test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
cmp --silent "$status_baseline" "$status_file"

for loose_limits in \
  '{"maxArchiveBytes":536870913}' \
  '{"maxTotalTarMetadataBytes":16777217}' \
  '{"minFreeHeadroomBytes":5368709119}'; do
  rejected_restore="$workspace/rejected-restore"
  rm -rf -- "$rejected_restore"
  mkdir -m 0700 "$rejected_restore"
  set +e
  BRAIN_BACKUP_TEST_MODE=1 BRAIN_BACKUP_TEST_LIMITS_JSON="$loose_limits" \
    "$verifier" "$archive" "$rejected_restore" >/dev/null 2>&1
  loose_status=$?
  set -e
  if (( loose_status == 0 )); then
    echo "test-only limits accepted a production-loosening override" >&2
    exit 1
  fi
  test -z "$(find "$rejected_restore" -mindepth 1 -print -quit)"
done

# The worst-case disk preflight must fail before the bounded git-archive mode is
# invoked. A PATH shim records only an actual `git archive` child.
printf '%s\n' "preflight fixture" >"$notes/index.md"
git -C "$notes" add index.md
git -C "$notes" commit -q -m "preflight fixture"
preflight_commit="$(git -C "$notes" rev-parse --verify HEAD)"
preflight_bin="$workspace/preflight-bin"
mkdir -m 0700 "$preflight_bin"
real_git="$(command -v git)"
archive_invocation_log="$workspace/git-archive-invoked"
cat >"$preflight_bin/git" <<'SH'
#!/usr/bin/env sh
for argument in "$@"; do
  if [ "$argument" = "archive" ]; then
    : >"$BRAIN_BACKUP_TEST_GIT_ARCHIVE_LOG"
  fi
done
exec "$BRAIN_BACKUP_REAL_GIT" "$@"
SH
chmod 0700 "$preflight_bin/git"
set +e
preflight_output="$(PATH="$preflight_bin:$PATH" \
  BRAIN_BACKUP_REAL_GIT="$real_git" \
  BRAIN_BACKUP_TEST_GIT_ARCHIVE_LOG="$archive_invocation_log" \
  NOTES_ROOT="$notes" BRAIN_BACKUP_ROOT="$backups" \
  BRAIN_NODE_RUNTIME="$(command -v node)" \
  BRAIN_BACKUP_VERIFIER="$verifier" \
  BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"minFreeHeadroomBytes":9223372036854775807}' \
  bash "$backup_script" 2>&1)"
preflight_status=$?
set -e
if (( preflight_status == 0 )); then
  echo "low-space preflight reported backup success" >&2
  exit 1
fi
if [[ "$preflight_output" != *"worst-case simultaneous staging space"* ]]; then
  echo "low-space fixture did not reach the staging preflight" >&2
  exit 1
fi
if [[ -e "$archive_invocation_log" ]]; then
  echo "low-space preflight invoked git archive" >&2
  exit 1
fi
cmp --silent "$status_baseline" "$status_file"
assert_no_backup_temps

# RLIMIT_FSIZE is byte-based on both Linux and macOS. Exercise the Python
# resource wrapper at one byte, then prove the nightly trap removes its partial
# archive and preserves the LKG.
size_limit_dir="$workspace/size-limit"
mkdir -m 0700 "$size_limit_dir"
size_limited_output="$size_limit_dir/archive.partial"
set +e
BRAIN_BACKUP_TEST_MODE=1 \
  BRAIN_BACKUP_TEST_LIMITS_JSON='{"maxArchiveBytes":1}' \
  "$verifier" --bounded-git-archive \
  "$notes" "$size_limited_output" "$preflight_commit" >/dev/null 2>&1
size_limit_status=$?
set -e
if (( size_limit_status == 0 )); then
  echo "bounded git archive ignored the one-byte file limit" >&2
  exit 1
fi
if [[ -f "$size_limited_output" ]]; then
  limited_bytes="$(wc -c <"$size_limited_output" | tr -d '[:space:]')"
  if (( limited_bytes > 1 )); then
    echo "bounded git archive exceeded RLIMIT_FSIZE" >&2
    exit 1
  fi
fi

set +e
run_backup_with_limits '{"maxArchiveBytes":1}' >/dev/null 2>&1
bounded_backup_status=$?
set -e
if (( bounded_backup_status == 0 )); then
  echo "nightly backup ignored the compressed archive file limit" >&2
  exit 1
fi
assert_attempt failed archive_create_failed
cmp --silent "$status_baseline" "$status_file"
if find "$backups" -maxdepth 1 -type f \
  -name "brain-notes-*-${preflight_commit:0:12}.tar.gz" -print -quit \
  | grep -q .; then
  echo "bounded archive failure published a partial archive" >&2
  exit 1
fi
assert_no_backup_temps

faults=(
  archive-rename
  archive-file-fsync
  archive-dir-fsync
  status-temp-fsync
  status-rename
  status-dir-fsync
)
fault_index=0
for fault in "${faults[@]}"; do
  fault_index=$((fault_index + 1))
  previous_status="$workspace/status-before-$fault.json"
  cp "$status_file" "$previous_status"
  previous_archive="$(status_archive)"
  printf 'fault %s\n' "$fault" >"$notes/index.md"
  git -C "$notes" add index.md
  git -C "$notes" commit -q -m "fault fixture $fault_index"
  fault_commit="$(git -C "$notes" rev-parse --verify HEAD)"

  set +e
  run_backup_with_fault "$fault" >/dev/null 2>&1
  fault_status=$?
  set -e
  if (( fault_status == 0 )); then
    echo "backup passed injected fault at $fault" >&2
    exit 1
  fi
  assert_attempt failed publish_failed
  assert_lkg_consistent
  assert_no_backup_temps

  case "$fault" in
    status-rename|status-dir-fsync)
      if [[ "$(status_archive)" != *"-${fault_commit:0:12}.tar.gz" ]]; then
        echo "status boundary did not retain its referenced archive" >&2
        exit 1
      fi
      test -f "$backups/$previous_archive"
      ;;
    *)
      cmp --silent "$previous_status" "$status_file"
      if find "$backups" -maxdepth 1 -type f \
        -name "brain-notes-*-${fault_commit:0:12}.tar.gz" -print -quit \
        | grep -q .; then
        echo "pre-status fault published a new archive" >&2
        exit 1
      fi
      ;;
  esac
done

# Force retention to have work. A fault after its first deletion must leave the
# durable status and its explicitly protected archive consistent.
retention_source="$backups/$(status_archive)"
for dummy in 1 2 3 4 5 6; do
  dummy_commit="$(printf '%012x' "$dummy")"
  cp "$retention_source" \
    "$backups/brain-notes-20240101T00000${dummy}Z-$dummy_commit.tar.gz"
done
previous_archive="$(status_archive)"
printf '%s\n' "retention fault" >"$notes/index.md"
git -C "$notes" add index.md
git -C "$notes" commit -q -m "retention fault fixture"
set +e
run_backup_with_fault retention >/dev/null 2>&1
retention_status=$?
set -e
if (( retention_status == 0 )); then
  echo "backup passed injected retention fault" >&2
  exit 1
fi
assert_attempt failed retention_failed
assert_lkg_consistent
assert_no_backup_temps
test -f "$backups/$previous_archive"

printf '%s\n' "retention success" >"$notes/index.md"
git -C "$notes" add index.md
git -C "$notes" commit -q -m "retention success fixture"
run_backup
assert_attempt success
assert_lkg_consistent
assert_no_backup_temps
archive_count="$(find "$backups" -maxdepth 1 -type f \
  -name 'brain-notes-*.tar.gz' | wc -l | tr -d '[:space:]')"
if [[ "$archive_count" != "7" ]]; then
  echo "retention kept $archive_count archives instead of 7" >&2
  exit 1
fi

# An unsafe Git snapshot inside the nightly flow must retain the prior status
# and archive, while the process exits non-zero for systemd/journal visibility.
cp "$status_file" "$status_baseline"
ln -s index.md "$notes/unsafe-link"
git -C "$notes" add unsafe-link
git -C "$notes" commit -q -m "unsafe backup fixture"
failed_commit="$(git -C "$notes" rev-parse --verify HEAD)"

set +e
run_backup >/dev/null 2>&1
failed_status=$?
set -e
if (( failed_status == 0 )); then
  echo "backup reported success for a symlink archive" >&2
  exit 1
fi
assert_attempt failed archive_check_failed
cmp --silent "$status_baseline" "$status_file"
if find "$backups" -maxdepth 1 -type f \
  -name "brain-notes-*-${failed_commit:0:12}.tar.gz" -print -quit \
  | grep -q .; then
  echo "failed rehearsal published a new archive" >&2
  exit 1
fi
assert_lkg_consistent
assert_no_backup_temps

echo "backup smoke passed"
