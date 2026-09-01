#!/usr/bin/env python3
"""Project the exact Brain Mail executable set into a private /run tree."""

from __future__ import annotations

import grp
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import uuid


SOURCE = Path("/opt/brain/current/mail-service")
RELEASES = Path("/opt/brain/releases")
RUNTIME_ROOT = Path("/run/brain-mail-runtime")
RUNTIME_GROUP = "brain-mail-runtime"
MAX_RUNTIME_BYTES = 8 * 1024 * 1024
IMAP_PROVIDER_DIRECTORY = Path("providers/imap")
REQUIRED_DIRECTORIES = (
    Path("service"),
    Path("providers"),
    Path("providers/gmail"),
    IMAP_PROVIDER_DIRECTORY,
)
LEGACY_REQUIRED_DIRECTORIES = tuple(
    relative
    for relative in REQUIRED_DIRECTORIES
    if relative != IMAP_PROVIDER_DIRECTORY
)
REQUIRED_FILES = (
    Path("address-identity.js"),
    Path("content-codec.js"),
    Path("content-types.js"),
    Path("draft-codec.js"),
    Path("draft-types.js"),
    Path("message-codec.js"),
    Path("search-query.js"),
    Path("message-types.js"),
    Path("ports.js"),
    Path("reader-content.js"),
    Path("raster-metadata.js"),
    Path("recipients.js"),
    Path("security.js"),
    Path("send-state.js"),
    Path("thread-contract.js"),
    Path("build.json"),
    Path("providers/gmail/access-token-port.js"),
    Path("providers/gmail/api-client.js"),
    Path("providers/gmail/api-types.js"),
    Path("providers/gmail/content-source-adapter.js"),
    Path("providers/gmail/contract.js"),
    Path("providers/gmail/credentials.js"),
    Path("providers/gmail/oauth.js"),
    Path("providers/gmail/raw-message-stream.js"),
    Path("providers/gmail/send-adapter.js"),
    Path("providers/gmail/service-adapter.js"),
    Path("providers/gmail/sync-adapter.js"),
    Path("providers/gmail/token-envelope.js"),
    Path("providers/imap/sync-adapter.js"),
    Path("service/account-store.js"),
    Path("service/account-types.js"),
    Path("service/accounts.js"),
    Path("service/admission.js"),
    Path("service/background-sync.js"),
    Path("service/content-blob-store.js"),
    Path("service/content-cache.js"),
    Path("service/content-coordinator.js"),
    Path("service/content-source.js"),
    Path("service/content-work-runner.js"),
    Path("service/dns.js"),
    Path("service/drafts.js"),
    Path("service/http.js"),
    Path("service/imapflow-adapter.js"),
    Path("service/limits.js"),
    Path("service/mail-html-sanitizer.js"),
    Path("service/main.js"),
    Path("service/message-cache.js"),
    Path("service/message-service-registry.js"),
    Path("service/message-service.js"),
    Path("service/mime-parser-client.js"),
    Path("service/mime-parser-runtime.js"),
    Path("service/mime-parser-worker.js"),
    Path("service/mime-protocol.js"),
    Path("service/outbound-message.js"),
    Path("service/outbound-store.js"),
    Path("service/outbound-worker.js"),
    Path("service/outbound.js"),
    Path("service/remote-image-fetcher.js"),
    Path("service/runtime-config.js"),
    Path("service/smtp-runtime.js"),
    Path("service/smtp-state-store.js"),
)
IMAP_PROVIDER_FILES = (Path("providers/imap/sync-adapter.js"),)
SMTP_RUNTIME_FILES = (
    Path("send-state.js"),
    Path("service/smtp-runtime.js"),
    Path("service/smtp-state-store.js"),
)
REMOTE_IMAGE_RUNTIME_FILES = (
    Path("reader-content.js"),
    Path("service/remote-image-fetcher.js"),
)
RECIPIENT_RUNTIME_FILES = (Path("recipients.js"),)
LEGACY_REQUIRED_FILES = tuple(
    relative for relative in REQUIRED_FILES if relative not in IMAP_PROVIDER_FILES
)


class UnsafeMailRuntime(ValueError):
    pass


def _require_real_directory(
    path: Path,
    owner: int,
    group: int | None = None,
    mode: int | None = None,
) -> None:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise UnsafeMailRuntime("mail runtime path is not a real directory")
    if metadata.st_uid != owner:
        raise UnsafeMailRuntime("mail runtime directory owner is invalid")
    if group is not None and metadata.st_gid != group:
        raise UnsafeMailRuntime("mail runtime directory group is invalid")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise UnsafeMailRuntime("mail runtime directory mode is invalid")
    if metadata.st_mode & 0o022:
        raise UnsafeMailRuntime("mail runtime directory is writable by another identity")


def _copy_required_file(
    source_root: Path,
    destination_root: Path,
    relative: Path,
    owner: int,
    runtime_gid: int,
) -> int:
    source = source_root / relative
    metadata = source.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != owner
        or metadata.st_mode & 0o022
    ):
        raise UnsafeMailRuntime("mail runtime source file is unsafe")
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(source_fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
            or opened.st_nlink != 1
            or opened.st_size > MAX_RUNTIME_BYTES
        ):
            raise UnsafeMailRuntime("mail runtime source changed during projection")
        destination = destination_root / relative
        destination_fd = os.open(
            destination,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o400,
        )
        copied = 0
        try:
            while chunk := os.read(source_fd, 1024 * 1024):
                copied += len(chunk)
                if copied > opened.st_size or copied > MAX_RUNTIME_BYTES:
                    raise UnsafeMailRuntime("mail runtime source exceeded its bound")
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_fd, view)
                    view = view[written:]
            if copied != opened.st_size:
                raise UnsafeMailRuntime("mail runtime source was truncated")
            os.fchown(destination_fd, owner, runtime_gid)
            os.fchmod(destination_fd, 0o440)
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)
        return copied
    finally:
        os.close(source_fd)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _required_runtime_layout(source: Path) -> tuple[tuple[Path, ...], tuple[Path, ...]]:
    if os.path.lexists(source / IMAP_PROVIDER_DIRECTORY):
        required_directories = REQUIRED_DIRECTORIES
        required_files = REQUIRED_FILES
    else:
        required_directories = LEGACY_REQUIRED_DIRECTORIES
        required_files = LEGACY_REQUIRED_FILES

    smtp_presence = tuple(
        os.path.lexists(source / relative) for relative in SMTP_RUNTIME_FILES
    )
    if any(smtp_presence) and not all(smtp_presence):
        raise UnsafeMailRuntime("mail SMTP runtime layout is incomplete")
    if not any(smtp_presence):
        required_files = tuple(
            relative
            for relative in required_files
            if relative not in SMTP_RUNTIME_FILES
        )

    remote_image_presence = tuple(
        os.path.lexists(source / relative)
        for relative in REMOTE_IMAGE_RUNTIME_FILES
    )
    if any(remote_image_presence) and not all(remote_image_presence):
        raise UnsafeMailRuntime("mail remote-image runtime layout is incomplete")
    if not any(remote_image_presence):
        required_files = tuple(
            relative
            for relative in required_files
            if relative not in REMOTE_IMAGE_RUNTIME_FILES
        )

    recipient_presence = tuple(
        os.path.lexists(source / relative)
        for relative in RECIPIENT_RUNTIME_FILES
    )
    if not any(recipient_presence):
        required_files = tuple(
            relative
            for relative in required_files
            if relative not in RECIPIENT_RUNTIME_FILES
        )
    return required_directories, required_files


def project_mail_runtime(
    source: Path,
    runtime_root: Path,
    runtime_gid: int,
    owner: int,
    runtime_mode: int = 0o550,
    seal_before_swap: bool = True,
) -> Path:
    source = source.resolve(strict=True)
    runtime_root = runtime_root.absolute()
    _require_real_directory(source, owner)
    required_directories, required_files = _required_runtime_layout(source)
    for relative in required_directories:
        _require_real_directory(source / relative, owner)
    _require_real_directory(runtime_root, owner, runtime_gid, runtime_mode)

    staging = Path(tempfile.mkdtemp(prefix=".stage-", dir=runtime_root))
    backup: Path | None = None
    try:
        os.chown(staging, owner, runtime_gid)
        for relative in required_directories:
            directory = staging / relative
            directory.mkdir(mode=0o700)
            os.chown(directory, owner, runtime_gid)
        total = 0
        for relative in required_files:
            total += _copy_required_file(
                source,
                staging,
                relative,
                owner,
                runtime_gid,
            )
            if total > MAX_RUNTIME_BYTES:
                raise UnsafeMailRuntime("mail runtime projection is too large")
        if seal_before_swap:
            for relative in reversed(required_directories):
                os.chmod(staging / relative, 0o550)
            os.chmod(staging, 0o550)
        for relative in reversed(required_directories):
            _sync_directory(staging / relative)
        _sync_directory(staging)

        current = runtime_root / "current"
        if os.path.lexists(current):
            _require_real_directory(current, owner, runtime_gid, 0o550)
            backup = runtime_root / f".old-{uuid.uuid4().hex}"
            os.rename(current, backup)
        try:
            os.rename(staging, current)
        except BaseException:
            if backup is not None and not os.path.lexists(current):
                os.rename(backup, current)
                backup = None
            raise
        if not seal_before_swap:
            for relative in reversed(required_directories):
                os.chmod(current / relative, 0o550)
            os.chmod(current, 0o550)
            for relative in reversed(required_directories):
                _sync_directory(current / relative)
            _sync_directory(current)
        _sync_directory(runtime_root)
        if backup is not None:
            shutil.rmtree(backup)
            backup = None
            _sync_directory(runtime_root)
        return current
    finally:
        if os.path.lexists(staging):
            shutil.rmtree(staging, ignore_errors=True)
        if backup is not None and os.path.lexists(backup):
            shutil.rmtree(backup, ignore_errors=True)


def main() -> int:
    if os.geteuid() != 0:
        raise UnsafeMailRuntime("mail runtime projection requires root")
    runtime_gid = grp.getgrnam(RUNTIME_GROUP).gr_gid
    releases = RELEASES.resolve(strict=True)
    source = SOURCE.resolve(strict=True)
    relative = source.relative_to(releases)
    if len(relative.parts) != 2 or relative.parts[1] != "mail-service":
        raise UnsafeMailRuntime("mail runtime source is outside an immutable release")
    project_mail_runtime(source, RUNTIME_ROOT, runtime_gid, 0)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, OSError, UnsafeMailRuntime, ValueError):
        print("brain-mail runtime projection failed", file=sys.stderr)
        raise SystemExit(1) from None
