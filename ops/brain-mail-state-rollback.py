#!/usr/bin/env python3
"""Create and restore exact stopped-service Brain Mail state snapshots."""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import sys
from typing import Callable, Iterator
import uuid


STATE_DIRECTORY = Path("/var/lib/brain-mail")
SNAPSHOT_ROOT = Path("/var/lib/brain-mail-state-rollbacks")
RESTORE_ROOT = Path("/var/lib/brain-mail-state-restores")
LOCK_FILE = Path("/run/brain-mail-state-rollback.lock")
UNITS = ("brain-mail-mime.socket", "brain-mail.socket", "brain-mail.service")
SNAPSHOT_NAME = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}$")
MANIFEST_VERSION = 1
COPY_CHUNK_BYTES = 1024 * 1024
RENAME_EXCHANGE = 2


class StateRollbackError(RuntimeError):
    """The state guard cannot prove that an operation is safe."""


def _snapshot_name() -> str:
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{uuid.uuid4().hex}"


def _lstat(path: Path) -> os.stat_result:
    try:
        return path.lstat()
    except FileNotFoundError as error:
        raise StateRollbackError(f"required path is missing: {path}") from error


def _require_directory(
    path: Path,
    *,
    owner: int | None = None,
    group: int | None = None,
    mode: int | None = None,
) -> os.stat_result:
    metadata = _lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise StateRollbackError(f"path is not a real directory: {path}")
    if owner is not None and metadata.st_uid != owner:
        raise StateRollbackError(f"directory owner is unsafe: {path}")
    if group is not None and metadata.st_gid != group:
        raise StateRollbackError(f"directory group is unsafe: {path}")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise StateRollbackError(f"directory mode is unsafe: {path}")
    return metadata


def _require_regular_file(
    path: Path,
    *,
    owner: int | None = None,
    mode: int | None = None,
) -> os.stat_result:
    metadata = _lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_nlink != 1
    ):
        raise StateRollbackError(f"path is not one real regular file: {path}")
    if owner is not None and metadata.st_uid != owner:
        raise StateRollbackError(f"file owner is unsafe: {path}")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise StateRollbackError(f"file mode is unsafe: {path}")
    return metadata


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_exact_file(path: Path, content: bytes, mode: int = 0o600) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
    )
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _marker(path: Path) -> None:
    _write_exact_file(path, b"")
    _fsync_directory(path.parent)


def _canonical_manifest(entries: list[dict[str, object]]) -> bytes:
    value = {
        "entries": sorted(entries, key=lambda entry: str(entry["path"])),
        "version": MANIFEST_VERSION,
    }
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _entry_path(relative: Path) -> str:
    return "." if relative == Path(".") else relative.as_posix()


def _directory_entry(relative: Path, metadata: os.stat_result) -> dict[str, object]:
    return {
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
        "mtimeNs": metadata.st_mtime_ns,
        "path": _entry_path(relative),
        "type": "directory",
        "uid": metadata.st_uid,
    }


def _file_entry(
    relative: Path,
    metadata: os.stat_result,
    digest: str,
) -> dict[str, object]:
    return {
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
        "mtimeNs": metadata.st_mtime_ns,
        "path": _entry_path(relative),
        "sha256": digest,
        "size": metadata.st_size,
        "type": "file",
        "uid": metadata.st_uid,
    }


def _same_source_file(before: os.stat_result, after: os.stat_result) -> bool:
    return all(
        (
            before.st_dev == after.st_dev,
            before.st_ino == after.st_ino,
            before.st_mode == after.st_mode,
            before.st_nlink == after.st_nlink,
            before.st_uid == after.st_uid,
            before.st_gid == after.st_gid,
            before.st_size == after.st_size,
            before.st_mtime_ns == after.st_mtime_ns,
        )
    )


def _copy_file(source: Path, destination: Path, relative: Path) -> dict[str, object]:
    before = _lstat(source)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise StateRollbackError(f"state contains a link or special file: {relative}")
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(source_fd)
        if not _same_source_file(before, opened):
            raise StateRollbackError(f"state file changed while opening: {relative}")
        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        digest = hashlib.sha256()
        copied = 0
        try:
            while chunk := os.read(source_fd, COPY_CHUNK_BYTES):
                copied += len(chunk)
                if copied > opened.st_size:
                    raise StateRollbackError(f"state file grew while copying: {relative}")
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_fd, view)
                    view = view[written:]
            if copied != opened.st_size:
                raise StateRollbackError(f"state file was truncated while copying: {relative}")
            os.fchown(destination_fd, opened.st_uid, opened.st_gid)
            os.fchmod(destination_fd, stat.S_IMODE(opened.st_mode))
            os.utime(
                destination_fd,
                ns=(opened.st_atime_ns, opened.st_mtime_ns),
            )
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)
        after = os.fstat(source_fd)
        if not _same_source_file(opened, after):
            raise StateRollbackError(f"state file changed while copying: {relative}")
        return _file_entry(relative, opened, digest.hexdigest())
    finally:
        os.close(source_fd)


def _copy_directory(
    source: Path,
    destination: Path,
    relative: Path,
    entries: list[dict[str, object]],
) -> None:
    before = _lstat(source)
    if not stat.S_ISDIR(before.st_mode) or source.is_symlink():
        raise StateRollbackError(f"state contains a non-directory path: {relative}")
    os.mkdir(destination, 0o700)
    initial_names = sorted(entry.name for entry in os.scandir(source))
    for name in initial_names:
        child_source = source / name
        child_destination = destination / name
        child_relative = Path(name) if relative == Path(".") else relative / name
        metadata = _lstat(child_source)
        if stat.S_ISDIR(metadata.st_mode) and not child_source.is_symlink():
            _copy_directory(
                child_source,
                child_destination,
                child_relative,
                entries,
            )
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            entries.append(_copy_file(child_source, child_destination, child_relative))
        else:
            raise StateRollbackError(
                f"state contains a symlink, hard link, or special file: {child_relative}"
            )
    final_names = sorted(entry.name for entry in os.scandir(source))
    after = _lstat(source)
    if initial_names != final_names or not _same_source_file(before, after):
        raise StateRollbackError(f"state directory changed while copying: {relative}")
    os.chown(destination, before.st_uid, before.st_gid, follow_symlinks=False)
    os.chmod(destination, stat.S_IMODE(before.st_mode), follow_symlinks=False)
    os.utime(
        destination,
        ns=(before.st_atime_ns, before.st_mtime_ns),
        follow_symlinks=False,
    )
    _fsync_directory(destination)
    entries.append(_directory_entry(relative, before))


def copy_state_tree(source: Path, destination: Path) -> bytes:
    if destination.exists() or destination.is_symlink():
        raise StateRollbackError(f"copy destination already exists: {destination}")
    entries: list[dict[str, object]] = []
    _copy_directory(source, destination, Path("."), entries)
    _fsync_directory(destination.parent)
    return _canonical_manifest(entries)


def _read_manifest(snapshot: Path, expected_owner: int | None) -> tuple[bytes, dict]:
    _require_directory(snapshot, owner=expected_owner, mode=0o700)
    expected_top = {"MANIFEST.json", "MANIFEST.sha256", "READY", "state"}
    if {entry.name for entry in os.scandir(snapshot)} != expected_top:
        raise StateRollbackError("snapshot top-level allowlist does not match")
    manifest_path = snapshot / "MANIFEST.json"
    digest_path = snapshot / "MANIFEST.sha256"
    ready_path = snapshot / "READY"
    _require_regular_file(manifest_path, owner=expected_owner, mode=0o600)
    _require_regular_file(digest_path, owner=expected_owner, mode=0o600)
    ready = _require_regular_file(ready_path, owner=expected_owner, mode=0o600)
    if ready.st_size != 0:
        raise StateRollbackError("snapshot READY marker is not empty")
    raw = manifest_path.read_bytes()
    digest_line = digest_path.read_bytes()
    expected_digest = hashlib.sha256(raw).hexdigest().encode() + b"\n"
    if digest_line != expected_digest:
        raise StateRollbackError("snapshot manifest digest does not match")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise StateRollbackError("snapshot manifest is invalid JSON") from error
    if not isinstance(manifest, dict) or set(manifest) != {"entries", "version"}:
        raise StateRollbackError("snapshot manifest shape is invalid")
    if manifest["version"] != MANIFEST_VERSION or not isinstance(
        manifest["entries"], list
    ):
        raise StateRollbackError("snapshot manifest version is unsupported")
    if raw != _canonical_manifest(manifest["entries"]):
        raise StateRollbackError("snapshot manifest is not canonical")
    return raw, manifest


def _validate_manifest_entry(entry: object) -> tuple[str, str]:
    if not isinstance(entry, dict):
        raise StateRollbackError("snapshot entry is not an object")
    entry_type = entry.get("type")
    base_keys = {"gid", "mode", "mtimeNs", "path", "type", "uid"}
    expected_keys = base_keys if entry_type == "directory" else base_keys | {
        "sha256",
        "size",
    }
    if entry_type not in {"directory", "file"} or set(entry) != expected_keys:
        raise StateRollbackError("snapshot entry shape is invalid")
    path = entry.get("path")
    if not isinstance(path, str):
        raise StateRollbackError("snapshot entry path is invalid")
    pure = PurePosixPath(path)
    if path != "." and (
        pure.is_absolute()
        or ".." in pure.parts
        or "." in pure.parts
        or pure.as_posix() != path
    ):
        raise StateRollbackError("snapshot entry escapes the state tree")
    for key in ("gid", "mode", "mtimeNs", "uid"):
        if not isinstance(entry.get(key), int) or entry[key] < 0:
            raise StateRollbackError("snapshot entry metadata is invalid")
    if entry["mode"] > 0o7777:
        raise StateRollbackError("snapshot entry mode is invalid")
    if entry_type == "file":
        if not isinstance(entry.get("size"), int) or entry["size"] < 0:
            raise StateRollbackError("snapshot file size is invalid")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(
            r"[a-f0-9]{64}", entry["sha256"]
        ):
            raise StateRollbackError("snapshot file digest is invalid")
    return path, entry_type


def _scan_tree(root: Path) -> bytes:
    entries: list[dict[str, object]] = []

    def scan(path: Path, relative: Path) -> None:
        metadata = _lstat(path)
        if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
            raise StateRollbackError(f"snapshot tree contains an unsafe directory: {relative}")
        initial_names = sorted(entry.name for entry in os.scandir(path))
        for name in initial_names:
            child = path / name
            child_relative = (
                Path(name) if relative == Path(".") else relative / name
            )
            child_metadata = _lstat(child)
            if stat.S_ISDIR(child_metadata.st_mode) and not child.is_symlink():
                scan(child, child_relative)
            elif stat.S_ISREG(child_metadata.st_mode) and child_metadata.st_nlink == 1:
                digest = hashlib.sha256()
                descriptor = os.open(child, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    opened = os.fstat(descriptor)
                    if not _same_source_file(child_metadata, opened):
                        raise StateRollbackError("snapshot file changed while opening")
                    read_bytes = 0
                    while chunk := os.read(descriptor, COPY_CHUNK_BYTES):
                        read_bytes += len(chunk)
                        digest.update(chunk)
                    after = os.fstat(descriptor)
                    if read_bytes != opened.st_size or not _same_source_file(opened, after):
                        raise StateRollbackError("snapshot file changed while reading")
                finally:
                    os.close(descriptor)
                entries.append(_file_entry(child_relative, opened, digest.hexdigest()))
            else:
                raise StateRollbackError(
                    f"snapshot tree contains a link or special file: {child_relative}"
                )
        final_names = sorted(entry.name for entry in os.scandir(path))
        after = _lstat(path)
        if initial_names != final_names or not _same_source_file(metadata, after):
            raise StateRollbackError(f"snapshot directory changed while reading: {relative}")
        entries.append(_directory_entry(relative, metadata))

    scan(root, Path("."))
    return _canonical_manifest(entries)


def verify_snapshot(
    snapshot: Path,
    snapshot_root: Path,
    expected_owner: int | None,
) -> bytes:
    snapshot_root = snapshot_root.resolve(strict=True)
    if not snapshot.is_absolute() or snapshot.is_symlink():
        raise StateRollbackError("snapshot path must be one absolute real directory")
    snapshot = snapshot.resolve(strict=True)
    if snapshot.parent != snapshot_root or not SNAPSHOT_NAME.fullmatch(snapshot.name):
        raise StateRollbackError("snapshot is not a direct guarded snapshot")
    raw, manifest = _read_manifest(snapshot, expected_owner)
    seen: set[str] = set()
    for entry in manifest["entries"]:
        path, _ = _validate_manifest_entry(entry)
        if path in seen:
            raise StateRollbackError("snapshot contains a duplicate path")
        seen.add(path)
    if "." not in seen:
        raise StateRollbackError("snapshot does not describe its state root")
    actual = _scan_tree(snapshot / "state")
    if actual != raw:
        raise StateRollbackError("snapshot state bytes or metadata do not match")
    return raw


def ensure_private_root(path: Path, expected_owner: int, expected_group: int) -> None:
    parent = path.parent
    _require_directory(parent, owner=expected_owner)
    if parent.lstat().st_mode & 0o022:
        raise StateRollbackError(f"private-root parent is writable by another user: {parent}")
    if not path.exists() and not path.is_symlink():
        os.mkdir(path, 0o700)
        os.chown(path, expected_owner, expected_group, follow_symlinks=False)
        _fsync_directory(parent)
    _require_directory(path, owner=expected_owner, group=expected_group, mode=0o700)


class SystemdStoppedGate:
    def assert_stopped(self) -> None:
        for unit in UNITS:
            result = subprocess.run(
                ["systemctl", "show", "--property=ActiveState", "--value", unit],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0 or result.stdout.strip() != "inactive":
                raise StateRollbackError(f"{unit} must be exactly inactive")


def _assert_no_unfinished_restore(restore_root: Path, expected_owner: int) -> None:
    if not restore_root.exists():
        return
    for entry in os.scandir(restore_root):
        path = restore_root / entry.name
        if entry.name.endswith(".preparing"):
            raise StateRollbackError(
                f"interrupted restore preparation requires inspection: {path}"
            )
        if (
            not SNAPSHOT_NAME.fullmatch(entry.name)
            or not entry.is_dir(follow_symlinks=False)
            or path.is_symlink()
        ):
            raise StateRollbackError(f"unsafe entry in restore root: {path}")
        _require_directory(path, owner=expected_owner, mode=0o700)
        committed = path / "COMMITTED"
        if not committed.is_file() or committed.is_symlink():
            raise StateRollbackError(f"unfinished state restore requires resume: {path}")
        marker = _require_regular_file(committed, owner=expected_owner, mode=0o600)
        if marker.st_size != 0:
            raise StateRollbackError(f"invalid committed restore marker: {committed}")


def _assert_snapshot_root_layout(snapshot_root: Path, expected_owner: int) -> None:
    for entry in os.scandir(snapshot_root):
        path = snapshot_root / entry.name
        if entry.name.endswith(".preparing"):
            raise StateRollbackError(
                f"interrupted snapshot preparation requires inspection: {path}"
            )
        if (
            not SNAPSHOT_NAME.fullmatch(entry.name)
            or not entry.is_dir(follow_symlinks=False)
            or path.is_symlink()
        ):
            raise StateRollbackError(f"unsafe entry in snapshot root: {path}")
        _require_directory(path, owner=expected_owner, mode=0o700)


def create_snapshot(
    state_directory: Path,
    snapshot_root: Path,
    restore_root: Path,
    gate: SystemdStoppedGate,
    *,
    expected_state_owner: int | None,
    expected_state_group: int | None,
    expected_root_owner: int,
    expected_root_group: int,
    name: str | None = None,
) -> Path:
    gate.assert_stopped()
    _require_directory(
        state_directory,
        owner=expected_state_owner,
        group=expected_state_group,
        mode=0o700,
    )
    ensure_private_root(snapshot_root, expected_root_owner, expected_root_group)
    ensure_private_root(restore_root, expected_root_owner, expected_root_group)
    _assert_snapshot_root_layout(snapshot_root, expected_root_owner)
    _assert_no_unfinished_restore(restore_root, expected_root_owner)
    snapshot_name = name or _snapshot_name()
    if not SNAPSHOT_NAME.fullmatch(snapshot_name):
        raise StateRollbackError("generated snapshot name is invalid")
    preparing = snapshot_root / f"{snapshot_name}.preparing"
    snapshot = snapshot_root / snapshot_name
    if preparing.exists() or preparing.is_symlink() or snapshot.exists() or snapshot.is_symlink():
        raise StateRollbackError("snapshot transaction already exists")
    os.mkdir(preparing, 0o700)
    try:
        manifest = copy_state_tree(state_directory, preparing / "state")
        _write_exact_file(preparing / "MANIFEST.json", manifest)
        _write_exact_file(
            preparing / "MANIFEST.sha256",
            hashlib.sha256(manifest).hexdigest().encode() + b"\n",
        )
        _marker(preparing / "READY")
        gate.assert_stopped()
        if _scan_tree(preparing / "state") != manifest:
            raise StateRollbackError("prepared snapshot failed its final verification")
        _fsync_directory(preparing)
        os.rename(preparing, snapshot)
        _fsync_directory(snapshot_root)
        return snapshot
    except BaseException:
        if preparing.exists() and not preparing.is_symlink():
            shutil.rmtree(preparing)
            _fsync_directory(snapshot_root)
        raise


def _exchange_directories(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise StateRollbackError("atomic directory exchange is unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(left),
        -100,
        os.fsencode(right),
        RENAME_EXCHANGE,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise StateRollbackError(
            f"atomic state-directory exchange failed: {os.strerror(error)}"
        )


def _read_restore_metadata(transaction: Path, expected_owner: int) -> dict[str, str]:
    metadata_path = transaction / "TRANSACTION.json"
    _require_regular_file(metadata_path, owner=expected_owner, mode=0o600)
    raw = metadata_path.read_bytes()
    try:
        metadata = json.loads(raw)
    except json.JSONDecodeError as error:
        raise StateRollbackError("restore transaction metadata is invalid") from error
    if not isinstance(metadata, dict) or set(metadata) != {
        "manifestSha256",
        "snapshot",
        "stateDirectory",
    }:
        raise StateRollbackError("restore transaction metadata shape is invalid")
    if not all(isinstance(value, str) for value in metadata.values()):
        raise StateRollbackError("restore transaction metadata values are invalid")
    canonical = (json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if raw != canonical:
        raise StateRollbackError("restore transaction metadata is not canonical")
    return metadata


def _assert_restore_transaction_layout(transaction: Path, expected_owner: int) -> None:
    names = {entry.name for entry in os.scandir(transaction)}
    required = {"PREPARED", "TRANSACTION.json"}
    allowed = required | {"stage", "replaced-state", "SWAPPED"}
    if not required.issubset(names) or not names.issubset(allowed):
        raise StateRollbackError("restore transaction allowlist does not match")
    if ("stage" in names) == ("replaced-state" in names):
        raise StateRollbackError("restore transaction must contain one state tree")
    if "replaced-state" in names and "SWAPPED" not in names:
        raise StateRollbackError("replaced state has no durable swap marker")
    if "SWAPPED" in names:
        marker = _require_regular_file(
            transaction / "SWAPPED",
            owner=expected_owner,
            mode=0o600,
        )
        if marker.st_size != 0:
            raise StateRollbackError("restore SWAPPED marker is invalid")


def _tree_matches(path: Path, manifest: bytes) -> bool:
    try:
        return _scan_tree(path) == manifest
    except (OSError, StateRollbackError):
        return False


def _resume_restore(
    transaction: Path,
    snapshot: Path,
    state_directory: Path,
    manifest: bytes,
    gate: SystemdStoppedGate,
    expected_root_owner: int,
    expected_state_owner: int | None,
    expected_state_group: int | None,
    exchange: Callable[[Path, Path], None],
    after_exchange: Callable[[], None] | None,
) -> Path:
    _require_directory(transaction, owner=expected_root_owner, mode=0o700)
    _assert_restore_transaction_layout(transaction, expected_root_owner)
    prepared = transaction / "PREPARED"
    _require_regular_file(prepared, owner=expected_root_owner, mode=0o600)
    if prepared.stat().st_size != 0:
        raise StateRollbackError("restore PREPARED marker is invalid")
    metadata = _read_restore_metadata(transaction, expected_root_owner)
    if metadata != {
        "manifestSha256": hashlib.sha256(manifest).hexdigest(),
        "snapshot": str(snapshot),
        "stateDirectory": str(state_directory),
    }:
        raise StateRollbackError("restore transaction does not match this request")
    stage = transaction / "stage"
    replaced = transaction / "replaced-state"
    _require_directory(
        state_directory,
        owner=expected_state_owner,
        group=expected_state_group,
        mode=0o700,
    )
    _scan_tree(state_directory)
    if stage.exists():
        _require_directory(stage, owner=expected_state_owner, group=expected_state_group)
        _scan_tree(stage)
    if stage.exists() and replaced.exists():
        raise StateRollbackError("restore transaction has two replaced-state trees")
    gate.assert_stopped()
    state_matches = _tree_matches(state_directory, manifest)
    stage_matches = _tree_matches(stage, manifest) if stage.exists() else False
    replaced_exists = replaced.exists() and not replaced.is_symlink()
    if replaced_exists:
        _require_directory(
            replaced,
            owner=expected_state_owner,
            group=expected_state_group,
            mode=0o700,
        )
        _scan_tree(replaced)
        if not state_matches:
            raise StateRollbackError("committing restore no longer matches its snapshot")
    elif stage.exists() and stage_matches and not state_matches:
        gate.assert_stopped()
        exchange(state_directory, stage)
        _fsync_directory(state_directory.parent)
        _fsync_directory(transaction)
        if after_exchange is not None:
            after_exchange()
        state_matches = _tree_matches(state_directory, manifest)
        if not state_matches:
            raise StateRollbackError("restored state failed verification after exchange")
        _marker(transaction / "SWAPPED")
    elif stage.exists() and state_matches:
        # The exchange either completed before its marker was durable, or both
        # sides were already identical. In both cases the live tree is exact.
        if not (transaction / "SWAPPED").exists():
            _marker(transaction / "SWAPPED")
    else:
        raise StateRollbackError("restore state is ambiguous; refusing another exchange")
    if stage.exists():
        os.rename(stage, replaced)
        _fsync_directory(transaction)
    gate.assert_stopped()
    _marker(transaction / "COMMITTED")
    return replaced


def restore_snapshot(
    snapshot: Path,
    state_directory: Path,
    snapshot_root: Path,
    restore_root: Path,
    gate: SystemdStoppedGate,
    *,
    expected_root_owner: int,
    expected_root_group: int,
    expected_state_owner: int | None,
    expected_state_group: int | None,
    exchange: Callable[[Path, Path], None] = _exchange_directories,
    after_exchange: Callable[[], None] | None = None,
) -> Path:
    gate.assert_stopped()
    _require_directory(
        state_directory,
        owner=expected_state_owner,
        group=expected_state_group,
        mode=0o700,
    )
    _scan_tree(state_directory)
    ensure_private_root(snapshot_root, expected_root_owner, expected_root_group)
    ensure_private_root(restore_root, expected_root_owner, expected_root_group)
    _assert_snapshot_root_layout(snapshot_root, expected_root_owner)
    manifest = verify_snapshot(snapshot, snapshot_root, expected_root_owner)
    snapshot = snapshot.resolve(strict=True)
    unfinished: list[Path] = []
    for entry in os.scandir(restore_root):
        path = restore_root / entry.name
        if entry.name.endswith(".preparing"):
            raise StateRollbackError(
                f"interrupted restore preparation requires inspection: {path}"
            )
        if (
            not SNAPSHOT_NAME.fullmatch(entry.name)
            or not entry.is_dir(follow_symlinks=False)
            or path.is_symlink()
        ):
            raise StateRollbackError(f"unsafe entry in restore root: {path}")
        _require_directory(path, owner=expected_root_owner, mode=0o700)
        committed = path / "COMMITTED"
        if not committed.is_file() or committed.is_symlink():
            unfinished.append(path)
        else:
            marker = _require_regular_file(
                committed,
                owner=expected_root_owner,
                mode=0o600,
            )
            if marker.st_size != 0:
                raise StateRollbackError(f"invalid committed restore marker: {committed}")
    if len(unfinished) > 1:
        raise StateRollbackError("multiple unfinished state restores require inspection")
    if unfinished:
        transaction = unfinished[0]
        return _resume_restore(
            transaction,
            snapshot,
            state_directory,
            manifest,
            gate,
            expected_root_owner,
            expected_state_owner,
            expected_state_group,
            exchange,
            after_exchange,
        )
    transaction_name = _snapshot_name()
    preparing = restore_root / f"{transaction_name}.preparing"
    transaction = restore_root / transaction_name
    os.mkdir(preparing, 0o700)
    try:
        copied_manifest = copy_state_tree(snapshot / "state", preparing / "stage")
        if copied_manifest != manifest:
            raise StateRollbackError("restore staging copy does not match the snapshot")
        metadata = {
            "manifestSha256": hashlib.sha256(manifest).hexdigest(),
            "snapshot": str(snapshot),
            "stateDirectory": str(state_directory),
        }
        _write_exact_file(
            preparing / "TRANSACTION.json",
            (json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n").encode(),
        )
        _marker(preparing / "PREPARED")
        gate.assert_stopped()
        _fsync_directory(preparing)
        os.rename(preparing, transaction)
        _fsync_directory(restore_root)
    except BaseException:
        if preparing.exists() and not preparing.is_symlink():
            shutil.rmtree(preparing)
            _fsync_directory(restore_root)
        raise
    return _resume_restore(
        transaction,
        snapshot,
        state_directory,
        manifest,
        gate,
        expected_root_owner,
        expected_state_owner,
        expected_state_group,
        exchange,
        after_exchange,
    )


@contextlib.contextmanager
def operation_lock(path: Path) -> Iterator[None]:
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise StateRollbackError("state rollback lock file is unsafe")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise StateRollbackError("another state rollback operation is running") from error
        yield
    finally:
        os.close(descriptor)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Snapshot or restore stopped Brain Mail local state.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("snapshot")
    restore = subcommands.add_parser("restore")
    restore.add_argument("snapshot", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    if os.geteuid() != 0:
        raise StateRollbackError("Brain Mail state rollback requires root")
    try:
        identity = pwd.getpwnam("brain-mail")
    except KeyError as error:
        raise StateRollbackError("brain-mail service identity is missing") from error
    arguments = _parser().parse_args(argv)
    os.umask(0o077)
    gate = SystemdStoppedGate()
    with operation_lock(LOCK_FILE):
        if arguments.command == "snapshot":
            snapshot = create_snapshot(
                STATE_DIRECTORY,
                SNAPSHOT_ROOT,
                RESTORE_ROOT,
                gate,
                expected_state_owner=identity.pw_uid,
                expected_state_group=identity.pw_gid,
                expected_root_owner=0,
                expected_root_group=0,
            )
            print(snapshot)
        else:
            replaced = restore_snapshot(
                arguments.snapshot,
                STATE_DIRECTORY,
                SNAPSHOT_ROOT,
                RESTORE_ROOT,
                gate,
                expected_root_owner=0,
                expected_root_group=0,
                expected_state_owner=identity.pw_uid,
                expected_state_group=identity.pw_gid,
            )
            print(f"restored {arguments.snapshot}; replaced state retained at {replaced}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, StateRollbackError, subprocess.SubprocessError) as error:
        print(f"brain-mail state rollback refused: {error}", file=sys.stderr)
        raise SystemExit(1) from None
