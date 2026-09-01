#!/usr/bin/env python3
"""Safely rehearse extraction of one Brain notes backup archive."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import gzip
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tarfile
import tempfile


ARCHIVE_NAME = re.compile(
    r"^brain-notes-\d{8}T\d{6}Z-[0-9a-f]{12,64}\.tar\.gz$"
)
STAGING_NAME = re.compile(
    r"^\.brain-notes-(\d{8}T\d{6}Z)\.[A-Za-z0-9]{6}$"
)

# Fixed production resource envelope. Test overrides are accepted only when the
# caller explicitly sets BRAIN_BACKUP_TEST_MODE=1.
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_DECOMPRESSED_TAR_BYTES = 1536 * 1024 * 1024
MAX_TAR_METADATA_BYTES = 8 * 1024 * 1024
MAX_TOTAL_TAR_METADATA_BYTES = 16 * 1024 * 1024
MAX_TAR_METADATA_RECORDS = 1_024
MAX_MEMBERS = 20_000
MAX_NORMALIZED_PATH_BYTES = 1_024
MAX_TOTAL_NORMALIZED_PATH_BYTES = 8 * 1024 * 1024
MAX_PATH_DEPTH = 32
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 20
MIN_FREE_HEADROOM_BYTES = 5 * 1024 * 1024 * 1024
MIN_FREE_HEADROOM_FRACTION = 0.10
STALE_STAGING_AGE_SECONDS = 6 * 60 * 60
MAX_BACKUP_ROOT_ENTRIES = 4_096
MAX_STALE_STAGING_DIRS_PER_RUN = 8
MAX_STALE_TREE_ENTRIES = 25_000
MAX_STALE_TREE_DEPTH = 40


class VerificationError(Exception):
    pass


class UnsafeStagingCandidate(Exception):
    pass


@dataclass(frozen=True)
class Limits:
    max_archive_bytes: int = MAX_ARCHIVE_BYTES
    max_decompressed_tar_bytes: int = MAX_DECOMPRESSED_TAR_BYTES
    max_tar_metadata_bytes: int = MAX_TAR_METADATA_BYTES
    max_total_tar_metadata_bytes: int = MAX_TOTAL_TAR_METADATA_BYTES
    max_tar_metadata_records: int = MAX_TAR_METADATA_RECORDS
    max_members: int = MAX_MEMBERS
    max_normalized_path_bytes: int = MAX_NORMALIZED_PATH_BYTES
    max_total_normalized_path_bytes: int = MAX_TOTAL_NORMALIZED_PATH_BYTES
    max_path_depth: int = MAX_PATH_DEPTH
    max_file_bytes: int = MAX_FILE_BYTES
    max_total_uncompressed_bytes: int = MAX_TOTAL_UNCOMPRESSED_BYTES
    max_compression_ratio: int = MAX_COMPRESSION_RATIO
    min_free_headroom_bytes: int = MIN_FREE_HEADROOM_BYTES


TEST_LIMIT_KEYS = {
    "maxArchiveBytes": "max_archive_bytes",
    "maxDecompressedTarBytes": "max_decompressed_tar_bytes",
    "maxTarMetadataBytes": "max_tar_metadata_bytes",
    "maxTotalTarMetadataBytes": "max_total_tar_metadata_bytes",
    "maxTarMetadataRecords": "max_tar_metadata_records",
    "maxMembers": "max_members",
    "maxNormalizedPathBytes": "max_normalized_path_bytes",
    "maxTotalNormalizedPathBytes": "max_total_normalized_path_bytes",
    "maxPathDepth": "max_path_depth",
    "maxFileBytes": "max_file_bytes",
    "maxTotalUncompressedBytes": "max_total_uncompressed_bytes",
    "maxCompressionRatio": "max_compression_ratio",
    "minFreeHeadroomBytes": "min_free_headroom_bytes",
}


def configured_limits() -> Limits:
    raw = os.environ.get("BRAIN_BACKUP_TEST_LIMITS_JSON")
    if raw is None:
        return Limits()
    if os.environ.get("BRAIN_BACKUP_TEST_MODE") != "1":
        raise VerificationError("test limit overrides require explicit test mode")
    try:
        overrides = json.loads(raw)
    except json.JSONDecodeError as error:
        raise VerificationError("test limit override is not valid JSON") from error
    if not isinstance(overrides, dict) or not overrides:
        raise VerificationError("test limit override must be a non-empty object")
    unknown = set(overrides) - set(TEST_LIMIT_KEYS)
    if unknown:
        raise VerificationError("test limit override contains an unknown key")
    defaults = Limits()
    values: dict[str, int] = {}
    for key, value in overrides.items():
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise VerificationError("test limit override must be a positive integer")
        field = TEST_LIMIT_KEYS[key]
        production_value = getattr(defaults, field)
        if field == "min_free_headroom_bytes":
            if value < production_value:
                raise VerificationError(
                    "test free-headroom override may only tighten the limit"
                )
        elif value > production_value:
            raise VerificationError("test override may only tighten the limit")
        values[field] = value
    return replace(defaults, **values)


def member_parts(member: tarfile.TarInfo, limits: Limits) -> tuple[str, ...]:
    name = member.name
    if (
        not name
        or "\x00" in name
        or "\\" in name
        or name.startswith("/")
        or re.match(r"^[A-Za-z]:", name)
    ):
        raise VerificationError("archive contains an absolute or unusual path")

    normalized = name[:-1] if name.endswith("/") else name
    parts = tuple(normalized.split("/"))
    if (
        not parts
        or parts[0] != "brain-notes"
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise VerificationError("archive entries must stay under brain-notes/")
    if len(parts) > limits.max_path_depth:
        raise VerificationError("archive path exceeds the depth limit")
    normalized_bytes = len("/".join(parts).encode("utf-8"))
    if normalized_bytes > limits.max_normalized_path_bytes:
        raise VerificationError("archive path exceeds the length limit")
    if len(parts) == 1 and not member.isdir():
        raise VerificationError("brain-notes archive root must be a directory")
    return parts


def open_archive(path: Path, limits: Limits):
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    archive_stat = os.fstat(descriptor)
    if not stat.S_ISREG(archive_stat.st_mode):
        os.close(descriptor)
        raise VerificationError("archive is not a regular file")
    if archive_stat.st_size <= 0 or archive_stat.st_size > limits.max_archive_bytes:
        os.close(descriptor)
        raise VerificationError("archive exceeds the compressed byte limit")
    return os.fdopen(descriptor, "rb")


def filesystem_capacity(path: Path) -> tuple[int, int]:
    filesystem = os.statvfs(path)
    fragment_size = filesystem.f_frsize
    return (
        filesystem.f_bavail * fragment_size,
        filesystem.f_blocks * fragment_size,
    )


def required_reserve_bytes(filesystem_bytes: int, limits: Limits) -> int:
    fractional_reserve = int(filesystem_bytes * MIN_FREE_HEADROOM_FRACTION)
    return max(limits.min_free_headroom_bytes, fractional_reserve)


def validate_private_directory(directory: Path) -> None:
    directory_stat = directory.lstat()
    if not stat.S_ISDIR(directory_stat.st_mode):
        raise VerificationError("staging destination is not a real directory")
    if stat.S_IMODE(directory_stat.st_mode) & 0o077:
        raise VerificationError("staging destination is not private")


def validate_cleanup_entry(entry_stat: os.stat_result, root_device: int) -> str:
    if entry_stat.st_dev != root_device:
        raise UnsafeStagingCandidate("entry crosses a filesystem boundary")
    if entry_stat.st_uid != os.geteuid():
        raise UnsafeStagingCandidate("entry has a foreign owner")
    if stat.S_IMODE(entry_stat.st_mode) & 0o077:
        raise UnsafeStagingCandidate("entry is not private")
    if stat.S_ISREG(entry_stat.st_mode):
        if entry_stat.st_nlink != 1:
            raise UnsafeStagingCandidate("regular file has multiple links")
        return "file"
    if stat.S_ISDIR(entry_stat.st_mode):
        return "directory"
    raise UnsafeStagingCandidate("entry is a link or special file")


def open_cleanup_directory(
    parent_descriptor: int,
    name: str,
    expected_stat: os.stat_result,
    root_device: int,
) -> int:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=parent_descriptor)
    except OSError as error:
        raise UnsafeStagingCandidate("directory changed during cleanup") from error
    opened_stat = os.fstat(descriptor)
    try:
        if (
            opened_stat.st_dev != expected_stat.st_dev
            or opened_stat.st_ino != expected_stat.st_ino
        ):
            raise UnsafeStagingCandidate("directory changed during cleanup")
        if validate_cleanup_entry(opened_stat, root_device) != "directory":
            raise UnsafeStagingCandidate("cleanup target is not a real directory")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def account_cleanup_entry(counter: list[int], depth: int) -> None:
    if depth > MAX_STALE_TREE_DEPTH:
        raise UnsafeStagingCandidate("staging tree exceeds the cleanup depth limit")
    counter[0] += 1
    if counter[0] > MAX_STALE_TREE_ENTRIES:
        raise UnsafeStagingCandidate("staging tree exceeds the cleanup entry limit")


def validate_cleanup_tree(
    directory_descriptor: int,
    root_device: int,
    depth: int,
    counter: list[int],
) -> None:
    with os.scandir(directory_descriptor) as entries:
        for entry in entries:
            account_cleanup_entry(counter, depth)
            entry_stat = entry.stat(follow_symlinks=False)
            entry_type = validate_cleanup_entry(entry_stat, root_device)
            if entry_type == "file":
                continue
            child_descriptor = open_cleanup_directory(
                directory_descriptor,
                entry.name,
                entry_stat,
                root_device,
            )
            try:
                validate_cleanup_tree(
                    child_descriptor,
                    root_device,
                    depth + 1,
                    counter,
                )
            finally:
                os.close(child_descriptor)


def remove_cleanup_tree(
    directory_descriptor: int,
    root_device: int,
    depth: int,
    counter: list[int],
) -> None:
    names: list[str] = []
    with os.scandir(directory_descriptor) as entries:
        for entry in entries:
            account_cleanup_entry(counter, depth)
            names.append(entry.name)
    for name in names:
        entry_stat = os.stat(
            name,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
        entry_type = validate_cleanup_entry(entry_stat, root_device)
        if entry_type == "file":
            os.unlink(name, dir_fd=directory_descriptor)
            continue
        child_descriptor = open_cleanup_directory(
            directory_descriptor,
            name,
            entry_stat,
            root_device,
        )
        try:
            remove_cleanup_tree(
                child_descriptor,
                root_device,
                depth + 1,
                counter,
            )
        finally:
            os.close(child_descriptor)
        os.rmdir(name, dir_fd=directory_descriptor)


def cleanup_stale_staging(backup_root: Path) -> None:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    root_descriptor = os.open(backup_root, flags)
    removed = False
    try:
        root_stat = os.fstat(root_descriptor)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise VerificationError("backup root is not a real directory")

        candidates: list[tuple[float, str, os.stat_result]] = []
        root_entries = 0
        now = datetime.now(timezone.utc).timestamp()
        with os.scandir(root_descriptor) as entries:
            for entry in entries:
                root_entries += 1
                if root_entries > MAX_BACKUP_ROOT_ENTRIES:
                    raise VerificationError(
                        "backup root exceeds the cleanup scan entry limit"
                    )
                match = STAGING_NAME.fullmatch(entry.name)
                if match is None:
                    continue
                entry_stat = entry.stat(follow_symlinks=False)
                try:
                    if (
                        validate_cleanup_entry(entry_stat, root_stat.st_dev)
                        != "directory"
                    ):
                        raise UnsafeStagingCandidate(
                            "cleanup target is not a real directory"
                        )
                except UnsafeStagingCandidate as error:
                    print(
                        "skipping unusual backup staging candidate "
                        f"{entry.name}: {error}",
                        file=sys.stderr,
                    )
                    continue
                try:
                    created_at = datetime.strptime(
                        match.group(1),
                        "%Y%m%dT%H%M%SZ",
                    ).replace(tzinfo=timezone.utc).timestamp()
                except ValueError:
                    print(
                        "skipping unusual backup staging candidate "
                        f"{entry.name}: timestamp is invalid",
                        file=sys.stderr,
                    )
                    continue
                newest_age_source = max(created_at, entry_stat.st_mtime)
                if now - newest_age_source < STALE_STAGING_AGE_SECONDS:
                    continue
                candidates.append((newest_age_source, entry.name, entry_stat))

        candidates.sort(key=lambda candidate: (candidate[0], candidate[1]))
        selected = candidates[:MAX_STALE_STAGING_DIRS_PER_RUN]
        for _, name, expected_stat in selected:
            try:
                candidate_descriptor = open_cleanup_directory(
                    root_descriptor,
                    name,
                    expected_stat,
                    root_stat.st_dev,
                )
                try:
                    validate_cleanup_tree(
                        candidate_descriptor,
                        root_stat.st_dev,
                        0,
                        [0],
                    )
                    remove_cleanup_tree(
                        candidate_descriptor,
                        root_stat.st_dev,
                        0,
                        [0],
                    )
                finally:
                    os.close(candidate_descriptor)
                current_stat = os.stat(
                    name,
                    dir_fd=root_descriptor,
                    follow_symlinks=False,
                )
                if (
                    current_stat.st_dev != expected_stat.st_dev
                    or current_stat.st_ino != expected_stat.st_ino
                ):
                    raise VerificationError(
                        "staging directory changed before final cleanup"
                    )
                os.rmdir(name, dir_fd=root_descriptor)
                removed = True
                print(f"removed abandoned backup staging directory: {name}")
            except UnsafeStagingCandidate as error:
                print(
                    f"skipping unusual backup staging candidate {name}: {error}",
                    file=sys.stderr,
                )
        if len(candidates) > len(selected):
            print(
                "deferred abandoned backup staging directories after bounded "
                f"cleanup: {len(candidates) - len(selected)}",
                file=sys.stderr,
            )
        if removed:
            os.fsync(root_descriptor)
    finally:
        os.close(root_descriptor)


def preflight_staging_space(destination: Path, limits: Limits) -> None:
    validate_private_directory(destination)
    available, filesystem_bytes = filesystem_capacity(destination)
    reserve = required_reserve_bytes(filesystem_bytes, limits)
    simultaneous_staging = (
        limits.max_archive_bytes
        + limits.max_decompressed_tar_bytes
        + limits.max_total_uncompressed_bytes
    )
    if available < reserve + simultaneous_staging:
        raise VerificationError(
            "backup filesystem lacks worst-case simultaneous staging space"
        )


def run_bounded_git_archive(
    notes_root: Path,
    output: Path,
    commit: str,
    limits: Limits,
) -> None:
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise VerificationError("archive commit is not a full Git object id")
    if output.exists() or output.is_symlink():
        raise VerificationError("bounded archive output already exists")
    validate_private_directory(output.parent)

    def set_file_size_limit() -> None:
        resource.setrlimit(
            resource.RLIMIT_FSIZE,
            (limits.max_archive_bytes, limits.max_archive_bytes),
        )

    result = subprocess.run(
        [
            "git",
            "-C",
            os.fspath(notes_root),
            "archive",
            "--format=tar.gz",
            "--prefix=brain-notes/",
            f"--output={os.fspath(output)}",
            commit,
        ],
        check=False,
        preexec_fn=set_file_size_limit,
    )
    if result.returncode != 0:
        raise VerificationError(
            "git archive failed or exceeded the compressed byte limit"
        )
    output_stat = output.lstat()
    if (
        not stat.S_ISREG(output_stat.st_mode)
        or output_stat.st_size <= 0
        or output_stat.st_size > limits.max_archive_bytes
    ):
        raise VerificationError("git archive output is missing or oversized")


def decompress_bounded_tar(
    archive_file,
    destination: Path,
    limits: Limits,
) -> tuple[Path, int]:
    available, filesystem_bytes = filesystem_capacity(destination)
    reserve = required_reserve_bytes(filesystem_bytes, limits)
    if available < reserve + limits.max_decompressed_tar_bytes:
        raise VerificationError(
            "restore filesystem lacks bounded tar staging headroom"
        )

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".brain-notes-tar-",
        suffix=".tmp",
        dir=destination,
    )
    temporary = Path(temporary_name)
    decompressed_bytes = 0
    try:
        with os.fdopen(descriptor, "wb") as output:
            with gzip.GzipFile(fileobj=archive_file, mode="rb") as compressed:
                while True:
                    chunk = compressed.read(1024 * 1024)
                    if not chunk:
                        break
                    decompressed_bytes += len(chunk)
                    if decompressed_bytes > limits.max_decompressed_tar_bytes:
                        raise VerificationError(
                            "archive exceeds the decompressed tar byte limit"
                        )
                    output.write(chunk)
        if decompressed_bytes == 0:
            raise VerificationError("archive contains an empty tar stream")
        return temporary, decompressed_bytes
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def parse_octal_tar_size(field: bytes) -> int:
    if field and field[0] & 0x80:
        raise VerificationError("archive uses an unusual binary tar size")
    stripped = field.rstrip(b"\0 ").lstrip(b" ")
    if not stripped:
        return 0
    if any(byte not in b"01234567" for byte in stripped):
        raise VerificationError("archive contains an invalid tar size")
    return int(stripped, 8)


def preflight_tar_metadata(
    tar_path: Path,
    tar_bytes: int,
    limits: Limits,
) -> None:
    metadata_types = {b"L", b"K", b"x", b"g"}
    position = 0
    zero_blocks = 0
    total_metadata_bytes = 0
    metadata_records = 0
    with tar_path.open("rb") as raw_tar:
        while position < tar_bytes:
            header = raw_tar.read(512)
            if len(header) != 512:
                raise VerificationError("archive has a truncated tar header")
            position += 512
            if header == b"\0" * 512:
                zero_blocks += 1
                if zero_blocks == 2:
                    return
                continue
            zero_blocks = 0
            size = parse_octal_tar_size(header[124:136])
            if header[156:157] in metadata_types:
                metadata_records += 1
                if metadata_records > limits.max_tar_metadata_records:
                    raise VerificationError(
                        "archive exceeds the tar metadata record count limit"
                    )
                if size > limits.max_tar_metadata_bytes:
                    raise VerificationError(
                        "archive exceeds the PAX or GNU metadata byte limit"
                    )
                total_metadata_bytes += size
                if (
                    total_metadata_bytes
                    > limits.max_total_tar_metadata_bytes
                ):
                    raise VerificationError(
                        "archive exceeds the aggregate tar metadata byte limit"
                    )
            padded_size = ((size + 511) // 512) * 512
            if position + padded_size > tar_bytes:
                raise VerificationError("archive member exceeds the tar stream")
            raw_tar.seek(padded_size, os.SEEK_CUR)
            position += padded_size
    raise VerificationError("archive is missing its tar end marker")


def validate_members(
    archive: tarfile.TarFile,
    archive_bytes: int,
    limits: Limits,
) -> tuple[list[tuple[tarfile.TarInfo, tuple[str, ...]]], int]:
    validated: list[tuple[tarfile.TarInfo, tuple[str, ...]]] = []
    path_types: dict[tuple[str, ...], str] = {}
    regular_files = 0
    total_uncompressed_bytes = 0
    total_normalized_path_bytes = 0

    for member in archive:
        if len(validated) >= limits.max_members:
            raise VerificationError("archive exceeds the member count limit")
        parts = member_parts(member, limits)
        total_normalized_path_bytes += len("/".join(parts).encode("utf-8"))
        if (
            total_normalized_path_bytes
            > limits.max_total_normalized_path_bytes
        ):
            raise VerificationError(
                "archive exceeds the aggregate normalized path byte limit"
            )
        if parts in path_types:
            raise VerificationError("archive contains duplicate paths")
        if member.isdir():
            if member.size != 0:
                raise VerificationError(
                    "archive directory has a non-zero body size"
                )
            entry_type = "directory"
        elif member.isreg() and not member.sparse:
            if member.size < 0 or member.size > limits.max_file_bytes:
                raise VerificationError("archive file exceeds the byte limit")
            total_uncompressed_bytes += member.size
            if total_uncompressed_bytes > limits.max_total_uncompressed_bytes:
                raise VerificationError(
                    "archive exceeds the total uncompressed byte limit"
                )
            if (
                total_uncompressed_bytes
                > archive_bytes * limits.max_compression_ratio
            ):
                raise VerificationError(
                    "archive exceeds the compression ratio limit"
                )
            entry_type = "file"
            regular_files += 1
        else:
            raise VerificationError(
                "archive contains a link, device, or other special entry"
            )
        path_types[parts] = entry_type
        validated.append((member, parts))

    if path_types.get(("brain-notes",)) != "directory":
        raise VerificationError("archive is missing its brain-notes/ root")
    if regular_files == 0:
        raise VerificationError("archive contains no regular note files")
    for parts in path_types:
        for end in range(1, len(parts)):
            parent_type = path_types.get(parts[:end])
            if parent_type is not None and parent_type != "directory":
                raise VerificationError("archive places an entry below a file")
    return validated, total_uncompressed_bytes


def verify_free_space(
    destination: Path,
    total_uncompressed_bytes: int,
    limits: Limits,
) -> None:
    available, filesystem_bytes = filesystem_capacity(destination)
    required = total_uncompressed_bytes + required_reserve_bytes(
        filesystem_bytes,
        limits,
    )
    if available < required:
        raise VerificationError("restore filesystem lacks required free headroom")


def extract_members(
    archive: tarfile.TarFile,
    destination: Path,
    members: list[tuple[tarfile.TarInfo, tuple[str, ...]]],
    limits: Limits,
) -> None:
    aggregate_copied = 0
    for member, parts in members:
        target = destination.joinpath(*parts)
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue

        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise VerificationError("archive regular file has no readable body")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(target, flags, 0o600)
        copied = 0
        try:
            with os.fdopen(descriptor, "wb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    copied += len(chunk)
                    aggregate_copied += len(chunk)
                    if (
                        copied > limits.max_file_bytes
                        or aggregate_copied
                        > limits.max_total_uncompressed_bytes
                    ):
                        raise VerificationError(
                            "archive exceeded extraction byte limits"
                        )
        finally:
            source.close()
        if copied != member.size:
            raise VerificationError("archive file size changed during extraction")


def verify(archive_path: Path, destination: Path, limits: Limits) -> None:
    if not ARCHIVE_NAME.fullmatch(archive_path.name):
        raise VerificationError("archive basename is not a Brain backup name")
    validate_private_directory(destination)
    if any(destination.iterdir()):
        raise VerificationError("restore destination is not empty")

    tar_path: Path | None = None
    with open_archive(archive_path, limits) as archive_file:
        archive_bytes = os.fstat(archive_file.fileno()).st_size
        try:
            tar_path, tar_bytes = decompress_bounded_tar(
                archive_file,
                destination,
                limits,
            )
            preflight_tar_metadata(tar_path, tar_bytes, limits)
            with tarfile.open(tar_path, mode="r:") as archive:
                members, total_uncompressed_bytes = validate_members(
                    archive,
                    archive_bytes,
                    limits,
                )
            verify_free_space(destination, total_uncompressed_bytes, limits)
            with tarfile.open(tar_path, mode="r:") as archive:
                extract_members(archive, destination, members, limits)
        finally:
            if tar_path is not None:
                tar_path.unlink(missing_ok=True)


def main() -> int:
    try:
        limits = configured_limits()
        if len(sys.argv) == 3 and sys.argv[1] == "--cleanup-stale-staging":
            cleanup_stale_staging(Path(sys.argv[2]))
            return 0
        if len(sys.argv) == 3 and sys.argv[1] == "--preflight-staging":
            preflight_staging_space(Path(sys.argv[2]), limits)
            return 0
        if len(sys.argv) == 5 and sys.argv[1] == "--bounded-git-archive":
            run_bounded_git_archive(
                Path(sys.argv[2]),
                Path(sys.argv[3]),
                sys.argv[4],
                limits,
            )
            return 0
        if len(sys.argv) == 3 and not sys.argv[1].startswith("--"):
            verify(Path(sys.argv[1]), Path(sys.argv[2]), limits)
            return 0
        print(
            "usage: verify-notes-backup.py ARCHIVE EMPTY_PRIVATE_DIRECTORY\n"
            "       verify-notes-backup.py --cleanup-stale-staging BACKUP_ROOT\n"
            "       verify-notes-backup.py --preflight-staging PRIVATE_DIRECTORY\n"
            "       verify-notes-backup.py --bounded-git-archive "
            "NOTES_ROOT OUTPUT COMMIT",
            file=sys.stderr,
        )
        return 64
    except VerificationError as error:
        print(f"backup archive verification failed: {error}", file=sys.stderr)
        return 1
    except (EOFError, OSError, tarfile.TarError):
        print(
            "backup archive verification failed: archive is corrupt or unreadable",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
