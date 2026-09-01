#!/usr/bin/env python3
"""Extract one pinned Brain Actions artifact without trusting archive paths."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import zipfile


ARCHIVE_NAME = "brain-standalone-linux-x64.tar.gz"
MANIFEST_NAME = "brain-standalone-linux-x64.json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
BUILT_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
DEFAULT_MAX_FILES = 100_000
DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
RELEASE_METADATA_NAME = "release.json"
VERSION_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)


class UnsafeArtifact(ValueError):
    pass


def _positive_limit(name: str, default: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    if not raw.isdecimal():
        raise UnsafeArtifact(f"{name} must be a positive integer")
    value = int(raw)
    if value < 1 or value > maximum:
        raise UnsafeArtifact(f"{name} is outside the safe range")
    return value


def _normalise_member(name: str) -> Path | None:
    if not name or "\0" in name or "\\" in name or name.startswith("/"):
        raise UnsafeArtifact("archive contains an unsafe path")
    parts = []
    for part in PurePosixPath(name).parts:
        if part in ("", "."):
            continue
        if part == ".." or any(ord(char) < 32 for char in part):
            raise UnsafeArtifact("archive contains an unsafe path")
        parts.append(part)
    if not parts:
        return None
    return Path(*parts)


def _normalise_link(relative: Path, linkname: str) -> Path:
    if (
        not linkname
        or "\0" in linkname
        or "\\" in linkname
        or linkname.startswith("/")
    ):
        raise UnsafeArtifact("archive contains an unsafe symbolic link")
    parts = list(relative.parent.parts)
    for part in PurePosixPath(linkname).parts:
        if part in ("", "."):
            continue
        if any(ord(char) < 32 for char in part):
            raise UnsafeArtifact("archive contains an unsafe symbolic link")
        if part == "..":
            if not parts:
                raise UnsafeArtifact("symbolic link escapes the release root")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        raise UnsafeArtifact("symbolic link resolves to the release root")
    return Path(*parts)


def _safe_parent(root: Path, relative: Path) -> Path:
    target = root.joinpath(relative)
    if os.path.commonpath((root, target)) != str(root):
        raise UnsafeArtifact("archive path escaped the release root")
    parent = root
    for part in relative.parts[:-1]:
        parent = parent / part
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            if not parent.is_dir() or parent.is_symlink():
                raise UnsafeArtifact("archive parent is not a real directory")
    return target


def _zip_regular(info: zipfile.ZipInfo) -> bool:
    if info.flag_bits & 0x1:
        return False
    file_type = (info.external_attr >> 16) & 0o170000
    return file_type in (0, stat.S_IFREG)


def _extract_actions_zip(source: Path, work: Path) -> tuple[Path, Path]:
    max_archive = _positive_limit(
        "BRAIN_DEPLOY_MAX_ZIP_UNPACKED_BYTES",
        DEFAULT_MAX_ARCHIVE_BYTES + 1024 * 1024,
        2 * 1024 * 1024 * 1024,
    )
    with zipfile.ZipFile(source, "r") as bundle:
        entries = bundle.infolist()
        by_name = {entry.filename: entry for entry in entries}
        if len(entries) != 2 or set(by_name) != {ARCHIVE_NAME, MANIFEST_NAME}:
            raise UnsafeArtifact("Actions artifact must contain exactly two pinned files")
        if any(not _zip_regular(entry) for entry in entries):
            raise UnsafeArtifact("Actions artifact contains a non-regular entry")
        if sum(entry.file_size for entry in entries) > max_archive:
            raise UnsafeArtifact("Actions artifact expands past the configured limit")

        extracted = {}
        for name in (ARCHIVE_NAME, MANIFEST_NAME):
            entry = by_name[name]
            destination = work / entry.filename
            descriptor = os.open(
                destination,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o400,
            )
            written = 0
            try:
                with os.fdopen(descriptor, "wb") as output, bundle.open(entry) as input_file:
                    while chunk := input_file.read(1024 * 1024):
                        written += len(chunk)
                        if written > entry.file_size:
                            raise UnsafeArtifact("zip entry exceeded its declared size")
                        output.write(chunk)
                if written != entry.file_size:
                    raise UnsafeArtifact("zip entry was shorter than its declared size")
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
            extracted[name] = destination
    return extracted[ARCHIVE_NAME], extracted[MANIFEST_NAME]


def _verify_manifest(archive: Path, manifest_path: Path, expected_commit: str) -> str:
    if not SHA_RE.fullmatch(expected_commit):
        raise UnsafeArtifact("expected commit is malformed")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise UnsafeArtifact("release manifest is not valid JSON") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != 1
        or manifest.get("commit") != expected_commit
        or manifest.get("platform") != "linux"
        or manifest.get("arch") != "x64"
        or not isinstance(manifest.get("builtAt"), str)
        or not BUILT_AT_RE.fullmatch(manifest["builtAt"])
        or not isinstance(manifest.get("sha256"), str)
        or not DIGEST_RE.fullmatch(manifest["sha256"])
        or not isinstance(manifest.get("bytes"), int)
        or isinstance(manifest.get("bytes"), bool)
        or manifest["bytes"] < 1
    ):
        raise UnsafeArtifact("release artifact manifest is invalid")
    size = archive.stat().st_size
    if size != manifest["bytes"]:
        raise UnsafeArtifact("release archive size does not match its manifest")
    digest = hashlib.sha256()
    with archive.open("rb") as input_file:
        while chunk := input_file.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != manifest["sha256"]:
        raise UnsafeArtifact("release archive checksum does not match its manifest")
    return manifest["builtAt"]


def _verify_release_tree(
    release: Path,
    expected_commit: str | None = None,
    expected_built_at: str | None = None,
) -> None:
    if not release.is_dir() or release.is_symlink():
        raise UnsafeArtifact("release root must be a real directory")
    release = release.resolve(strict=True)
    max_files = _positive_limit(
        "BRAIN_DEPLOY_MAX_RELEASE_FILES", DEFAULT_MAX_FILES, 1_000_000
    )
    max_expanded = _positive_limit(
        "BRAIN_DEPLOY_MAX_RELEASE_BYTES",
        DEFAULT_MAX_EXPANDED_BYTES,
        4 * 1024 * 1024 * 1024,
    )
    pending = [release]
    symlinks: list[Path] = []
    count = 0
    total_size = 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                relative = path.relative_to(release)
                metadata = entry.stat(follow_symlinks=False)
                count += 1
                if count > max_files:
                    raise UnsafeArtifact("release contains too many filesystem entries")
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(metadata.st_mode):
                    if metadata.st_nlink != 1:
                        raise UnsafeArtifact("release contains a hard-linked file")
                    total_size += metadata.st_size
                    if total_size > max_expanded:
                        raise UnsafeArtifact("release expands past the configured limit")
                elif stat.S_ISLNK(metadata.st_mode):
                    _normalise_link(relative, os.readlink(path))
                    symlinks.append(path)
                else:
                    raise UnsafeArtifact("release tree contains a special file")

    for link in symlinks:
        try:
            resolved = link.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise UnsafeArtifact("release contains a broken or cyclic link") from error
        if os.path.commonpath((release, resolved)) != str(release):
            raise UnsafeArtifact("symbolic link resolves outside the release root")

    def require_real_chain(path: Path, expected: str) -> None:
        cursor = release
        for part in path.relative_to(release).parts:
            cursor /= part
            try:
                metadata = cursor.lstat()
            except OSError as error:
                raise UnsafeArtifact(
                    f"release is missing a required standalone {expected}"
                ) from error
            if stat.S_ISLNK(metadata.st_mode):
                raise UnsafeArtifact(
                    f"required standalone {expected} crosses a symbolic link"
                )
        metadata = path.lstat()
        if expected == "file" and not stat.S_ISREG(metadata.st_mode):
            raise UnsafeArtifact("release is missing a required standalone file")
        if expected == "directory" and not stat.S_ISDIR(metadata.st_mode):
            raise UnsafeArtifact("release is missing a required standalone directory")

    required_files = (
        release / "server.js",
        release / "brain-next-server.js",
        release / "brain-shutdown-preload.mjs",
        release / "package.json",
        release / "mail-service" / "address-identity.js",
        release / "mail-service" / "content-codec.js",
        release / "mail-service" / "content-types.js",
        release / "mail-service" / "draft-codec.js",
        release / "mail-service" / "draft-types.js",
        release / "mail-service" / "message-codec.js",
        release / "mail-service" / "search-query.js",
        release / "mail-service" / "message-types.js",
        release / "mail-service" / "ports.js",
        release / "mail-service" / "reader-content.js",
        release / "mail-service" / "raster-metadata.js",
        release / "mail-service" / "recipients.js",
        release / "mail-service" / "security.js",
        release / "mail-service" / "send-state.js",
        release / "mail-service" / "thread-contract.js",
        release / "mail-service" / "build.json",
        release / "mail-service" / "THIRD_PARTY_NOTICES.txt",
        release / "mail-service" / "providers" / "gmail" / "content-source-adapter.js",
        release / "mail-service" / "providers" / "gmail" / "contract.js",
        release / "mail-service" / "providers" / "gmail" / "credentials.js",
        release / "mail-service" / "providers" / "gmail" / "oauth.js",
        release / "mail-service" / "providers" / "gmail" / "raw-message-stream.js",
        release / "mail-service" / "providers" / "gmail" / "service-adapter.js",
        release / "mail-service" / "providers" / "gmail" / "token-envelope.js",
        release / "mail-service" / "providers" / "imap" / "sync-adapter.js",
        release / "mail-service" / "service" / "account-store.js",
        release / "mail-service" / "service" / "account-types.js",
        release / "mail-service" / "service" / "accounts.js",
        release / "mail-service" / "service" / "admission.js",
        release / "mail-service" / "service" / "background-sync.js",
        release / "mail-service" / "service" / "content-blob-store.js",
        release / "mail-service" / "service" / "content-cache.js",
        release / "mail-service" / "service" / "content-coordinator.js",
        release / "mail-service" / "service" / "content-source.js",
        release / "mail-service" / "service" / "content-work-runner.js",
        release / "mail-service" / "service" / "dns.js",
        release / "mail-service" / "service" / "drafts.js",
        release / "mail-service" / "service" / "http.js",
        release / "mail-service" / "service" / "imapflow-adapter.js",
        release / "mail-service" / "service" / "limits.js",
        release / "mail-service" / "service" / "mail-html-sanitizer.js",
        release / "mail-service" / "service" / "main.js",
        release / "mail-service" / "service" / "message-cache.js",
        release / "mail-service" / "service" / "message-service-registry.js",
        release / "mail-service" / "service" / "message-service.js",
        release / "mail-service" / "service" / "mime-parser-client.js",
        release / "mail-service" / "service" / "mime-parser-runtime.js",
        release / "mail-service" / "service" / "mime-parser-worker.js",
        release / "mail-service" / "service" / "mime-protocol.js",
        release / "mail-service" / "service" / "outbound-message.js",
        release / "mail-service" / "service" / "outbound-store.js",
        release / "mail-service" / "service" / "outbound.js",
        release / "mail-service" / "service" / "remote-image-fetcher.js",
        release / "mail-service" / "service" / "runtime-config.js",
        release / "mail-service" / "service" / "smtp-runtime.js",
        release / "mail-service" / "service" / "smtp-state-store.js",
    )
    for required_file in required_files:
        require_real_chain(required_file, "file")
    for required_directory in (release / ".next" / "static", release / "public"):
        require_real_chain(required_directory, "directory")

    build_path = release / "mail-service" / "build.json"
    try:
        build = json.loads(build_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise UnsafeArtifact("mail service build identity is not valid JSON") from error
    if (
        not isinstance(build, dict)
        or set(build) != {"commit", "builtAt"}
        or not isinstance(build.get("commit"), str)
        or not SHA_RE.fullmatch(build["commit"])
        or not isinstance(build.get("builtAt"), str)
        or not BUILT_AT_RE.fullmatch(build["builtAt"])
    ):
        raise UnsafeArtifact("mail service build identity is invalid")
    if expected_commit is not None and build["commit"] != expected_commit:
        raise UnsafeArtifact("mail service commit does not match the release manifest")
    if expected_built_at is not None and build["builtAt"] != expected_built_at:
        raise UnsafeArtifact("mail service build time does not match the release manifest")


def _extract_release(
    archive: Path,
    release: Path,
    expected_commit: str,
    expected_built_at: str,
) -> None:
    max_files = _positive_limit(
        "BRAIN_DEPLOY_MAX_RELEASE_FILES", DEFAULT_MAX_FILES, 1_000_000
    )
    max_expanded = _positive_limit(
        "BRAIN_DEPLOY_MAX_RELEASE_BYTES",
        DEFAULT_MAX_EXPANDED_BYTES,
        4 * 1024 * 1024 * 1024,
    )
    release.mkdir(mode=0o700)
    seen: set[Path] = set()
    count = 0
    total_size = 0

    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle:
                relative = _normalise_member(member.name)
                if relative is None:
                    if not member.isdir():
                        raise UnsafeArtifact("archive root entry is not a directory")
                    continue
                if relative in seen:
                    raise UnsafeArtifact("archive contains a duplicate path")
                seen.add(relative)
                count += 1
                if count > max_files:
                    raise UnsafeArtifact("release contains too many files")
                if member.isdir():
                    destination = _safe_parent(release, relative)
                    try:
                        destination.mkdir(mode=0o700)
                    except FileExistsError:
                        if not destination.is_dir() or destination.is_symlink():
                            raise UnsafeArtifact("archive directory conflicts with a file")
                    continue
                if member.issym():
                    _normalise_link(relative, member.linkname)
                    destination = _safe_parent(release, relative)
                    try:
                        os.symlink(member.linkname, destination)
                    except FileExistsError as error:
                        raise UnsafeArtifact("archive link conflicts with another path") from error
                    continue
                if not member.isfile() or member.issparse():
                    raise UnsafeArtifact("release archive contains a link or special file")
                total_size += member.size
                if total_size > max_expanded:
                    raise UnsafeArtifact("release expands past the configured limit")
                destination = _safe_parent(release, relative)
                source = bundle.extractfile(member)
                if source is None:
                    raise UnsafeArtifact("release file has no readable payload")
                descriptor = os.open(
                    destination,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                    0o400,
                )
                written = 0
                try:
                    with os.fdopen(descriptor, "wb") as output, source:
                        while chunk := source.read(1024 * 1024):
                            written += len(chunk)
                            if written > member.size:
                                raise UnsafeArtifact("tar entry exceeded its declared size")
                            output.write(chunk)
                    if written != member.size:
                        raise UnsafeArtifact("tar entry was shorter than its declared size")
                except BaseException:
                    destination.unlink(missing_ok=True)
                    raise
        _verify_release_tree(release, expected_commit, expected_built_at)
    except BaseException:
        shutil.rmtree(release, ignore_errors=True)
        raise


def _archive_kind(source: Path) -> str:
    with source.open("rb") as handle:
        magic = handle.read(4)
    if magic[:2] == b"\x1f\x8b":
        return "tarball"
    if magic == b"PK\x03\x04":
        return "zip"
    raise UnsafeArtifact("artifact is neither a zip nor a gzip tarball")


def _verify_sidecar_digest(archive: Path, sidecar: Path) -> None:
    if not sidecar.is_file() or sidecar.is_symlink() or sidecar.stat().st_size > 128:
        raise UnsafeArtifact("release digest sidecar from SHA256SUMS is missing")
    expected = sidecar.read_text(encoding="utf-8").strip()
    if not DIGEST_RE.fullmatch(expected):
        raise UnsafeArtifact("release digest sidecar from SHA256SUMS is malformed")
    digest = hashlib.sha256()
    with archive.open("rb") as input_file:
        while chunk := input_file.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise UnsafeArtifact("release archive checksum does not match SHA256SUMS")


def _read_shipped_release_metadata(release: Path, expected_commit: str) -> str:
    metadata_path = release / RELEASE_METADATA_NAME
    if metadata_path.is_symlink() or not metadata_path.is_file() or metadata_path.stat().st_size > 4096:
        raise UnsafeArtifact("release metadata is missing or oversized")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise UnsafeArtifact("release metadata is not valid JSON") from error
    if (
        not isinstance(metadata, dict)
        or set(metadata) != {"schema", "version", "commit", "buildTime", "minUpgradeFrom"}
        or metadata.get("schema") != 1
        or metadata.get("commit") != expected_commit
        or not isinstance(metadata.get("version"), str)
        or not VERSION_RE.fullmatch(metadata["version"])
        or not isinstance(metadata.get("minUpgradeFrom"), str)
        or not VERSION_RE.fullmatch(metadata["minUpgradeFrom"])
        or not isinstance(metadata.get("buildTime"), str)
        or not BUILT_AT_RE.fullmatch(metadata["buildTime"])
    ):
        raise UnsafeArtifact("release metadata is invalid")
    return metadata["buildTime"]


def _extract_release_tarball(source: Path, work: Path, expected_commit: str) -> str:
    if not SHA_RE.fullmatch(expected_commit):
        raise UnsafeArtifact("expected commit is malformed")
    _verify_sidecar_digest(source, source.with_name(f"{source.name}.sha256"))
    release = work / "release"
    _extract_release(source, release, expected_commit, None)
    try:
        built_at = _read_shipped_release_metadata(release, expected_commit)
        _verify_release_tree(release, expected_commit, built_at)
    except BaseException:
        shutil.rmtree(release, ignore_errors=True)
        raise
    return built_at


def extract(source: Path, work: Path, expected_commit: str) -> str:
    if not source.is_file() or source.is_symlink():
        raise UnsafeArtifact("artifact must be a regular file")
    if work.exists():
        if not work.is_dir() or work.is_symlink() or any(work.iterdir()):
            raise UnsafeArtifact("work directory must be an empty real directory")
    else:
        work.mkdir(mode=0o700)
    if _archive_kind(source) == "tarball":
        return _extract_release_tarball(source, work, expected_commit)
    archive, manifest = _extract_actions_zip(source, work)
    built_at = _verify_manifest(archive, manifest, expected_commit)
    _extract_release(archive, work / "release", expected_commit, built_at)
    return built_at


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == "extract":
        source = Path(sys.argv[2]).resolve(strict=True)
        work = Path(sys.argv[3]).resolve(strict=False)
        built_at = extract(source, work, sys.argv[4])
        print(built_at)
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "verify-tree":
        release = Path(sys.argv[2]).resolve(strict=True)
        _verify_release_tree(release)
        print("release tree verified")
        return 0
    else:
        raise UnsafeArtifact(
            "usage: extract_release.py extract <artifact.zip|artifact.tar.gz> "
            "<empty-work-dir> <commit> | verify-tree <release-dir>"
        )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnsafeArtifact, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"release extraction rejected: {error}", file=sys.stderr)
        raise SystemExit(1) from None
