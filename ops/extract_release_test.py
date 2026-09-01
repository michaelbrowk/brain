from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

from extract_release import (
    ARCHIVE_NAME,
    MANIFEST_NAME,
    UnsafeArtifact,
    _verify_release_tree,
    extract,
)


COMMIT = "a" * 40
BUILT_AT = "2026-07-12T10:00:00Z"


class ExtractReleaseTest(unittest.TestCase):
    def _release_tree(self, root: Path) -> Path:
        release = root / "release"
        (release / ".next" / "static").mkdir(parents=True)
        (release / "public").mkdir()
        (release / "mail-service" / "service").mkdir(parents=True)
        (release / "mail-service" / "providers" / "gmail").mkdir(parents=True)
        (release / "mail-service" / "providers" / "imap").mkdir(parents=True)
        (release / "server.js").write_text("server\n", encoding="utf-8")
        (release / "brain-next-server.js").write_text("next\n", encoding="utf-8")
        (release / "brain-shutdown-preload.mjs").write_text(
            "preload\n", encoding="utf-8"
        )
        (release / "package.json").write_text("{}\n", encoding="utf-8")
        for name in (
            "address-identity.js",
            "content-codec.js",
            "content-types.js",
            "draft-codec.js",
            "draft-types.js",
            "message-codec.js",
            "search-query.js",
            "message-types.js",
            "ports.js",
            "reader-content.js",
            "raster-metadata.js",
            "recipients.js",
            "security.js",
            "send-state.js",
            "thread-contract.js",
            "THIRD_PARTY_NOTICES.txt",
        ):
            (release / "mail-service" / name).write_text("module\n", encoding="utf-8")
        for name in (
            "content-source-adapter.js",
            "contract.js",
            "credentials.js",
            "oauth.js",
            "raw-message-stream.js",
            "service-adapter.js",
            "token-envelope.js",
        ):
            (release / "mail-service" / "providers" / "gmail" / name).write_text(
                "module\n", encoding="utf-8"
            )
        (release / "mail-service" / "providers" / "imap" / "sync-adapter.js").write_text(
            "module\n", encoding="utf-8"
        )
        for name in (
            "account-store.js",
            "account-types.js",
            "accounts.js",
            "admission.js",
            "background-sync.js",
            "content-blob-store.js",
            "content-cache.js",
            "content-coordinator.js",
            "content-source.js",
            "content-work-runner.js",
            "dns.js",
            "drafts.js",
            "http.js",
            "imapflow-adapter.js",
            "limits.js",
            "mail-html-sanitizer.js",
            "main.js",
            "message-cache.js",
            "message-service-registry.js",
            "message-service.js",
            "mime-parser-client.js",
            "mime-parser-runtime.js",
            "mime-parser-worker.js",
            "mime-protocol.js",
            "outbound-message.js",
            "outbound-store.js",
            "outbound.js",
            "remote-image-fetcher.js",
            "runtime-config.js",
            "smtp-runtime.js",
            "smtp-state-store.js",
        ):
            (release / "mail-service" / "service" / name).write_text(
                "module\n", encoding="utf-8"
            )
        (release / "mail-service" / "build.json").write_text(
            json.dumps({"commit": COMMIT, "builtAt": BUILT_AT}), encoding="utf-8"
        )
        return release

    def _artifact(
        self,
        root: Path,
        *,
        extra_zip_entry: bool = False,
        mutate_manifest=None,
        malicious_member: tarfile.TarInfo | None = None,
        mail_commit: str = COMMIT,
        omit_mail_file: str | None = None,
    ) -> Path:
        archive = root / ARCHIVE_NAME
        with tarfile.open(archive, "w:gz") as bundle:
            members = (
                ("server.js", b"require('./brain-next-server.js')\n"),
                ("brain-next-server.js", b"console.log('brain')\n"),
                ("brain-shutdown-preload.mjs", b"// preload\n"),
                ("package.json", b'{"name":"brain"}\n'),
                (".next/static/app.js", b"static\n"),
                ("public/icon.txt", b"icon\n"),
                ("mail-service/address-identity.js", b"module\n"),
                ("mail-service/content-codec.js", b"module\n"),
                ("mail-service/content-types.js", b"module\n"),
                ("mail-service/draft-codec.js", b"module\n"),
                ("mail-service/draft-types.js", b"module\n"),
                ("mail-service/message-codec.js", b"module\n"),
                ("mail-service/search-query.js", b"module\n"),
                ("mail-service/message-types.js", b"module\n"),
                ("mail-service/ports.js", b"module\n"),
                ("mail-service/reader-content.js", b"module\n"),
                ("mail-service/raster-metadata.js", b"module\n"),
                ("mail-service/recipients.js", b"module\n"),
                ("mail-service/security.js", b"module\n"),
                ("mail-service/send-state.js", b"module\n"),
                ("mail-service/thread-contract.js", b"module\n"),
                ("mail-service/THIRD_PARTY_NOTICES.txt", b"notices\n"),
                (
                    "mail-service/build.json",
                    json.dumps({"commit": mail_commit, "builtAt": BUILT_AT}).encode(),
                ),
                ("mail-service/providers/gmail/content-source-adapter.js", b"module\n"),
                ("mail-service/providers/gmail/contract.js", b"module\n"),
                ("mail-service/providers/gmail/credentials.js", b"module\n"),
                ("mail-service/providers/gmail/oauth.js", b"module\n"),
                ("mail-service/providers/gmail/raw-message-stream.js", b"module\n"),
                ("mail-service/providers/gmail/service-adapter.js", b"module\n"),
                ("mail-service/providers/gmail/token-envelope.js", b"module\n"),
                ("mail-service/providers/imap/sync-adapter.js", b"module\n"),
                ("mail-service/service/account-store.js", b"module\n"),
                ("mail-service/service/account-types.js", b"module\n"),
                ("mail-service/service/accounts.js", b"module\n"),
                ("mail-service/service/admission.js", b"module\n"),
                ("mail-service/service/background-sync.js", b"module\n"),
                ("mail-service/service/content-blob-store.js", b"module\n"),
                ("mail-service/service/content-cache.js", b"module\n"),
                ("mail-service/service/content-coordinator.js", b"module\n"),
                ("mail-service/service/content-source.js", b"module\n"),
                ("mail-service/service/content-work-runner.js", b"module\n"),
                ("mail-service/service/dns.js", b"module\n"),
                ("mail-service/service/drafts.js", b"module\n"),
                ("mail-service/service/http.js", b"module\n"),
                ("mail-service/service/imapflow-adapter.js", b"module\n"),
                ("mail-service/service/limits.js", b"module\n"),
                ("mail-service/service/mail-html-sanitizer.js", b"module\n"),
                ("mail-service/service/main.js", b"module\n"),
                ("mail-service/service/message-cache.js", b"module\n"),
                ("mail-service/service/message-service-registry.js", b"module\n"),
                ("mail-service/service/message-service.js", b"module\n"),
                ("mail-service/service/mime-parser-client.js", b"module\n"),
                ("mail-service/service/mime-parser-runtime.js", b"module\n"),
                ("mail-service/service/mime-parser-worker.js", b"module\n"),
                ("mail-service/service/mime-protocol.js", b"module\n"),
                ("mail-service/service/outbound-message.js", b"module\n"),
                ("mail-service/service/outbound-store.js", b"module\n"),
                ("mail-service/service/outbound.js", b"module\n"),
                ("mail-service/service/remote-image-fetcher.js", b"module\n"),
                ("mail-service/service/runtime-config.js", b"module\n"),
                ("mail-service/service/smtp-runtime.js", b"module\n"),
                ("mail-service/service/smtp-state-store.js", b"module\n"),
            )
            for name, payload in members:
                if name == omit_mail_file:
                    continue
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                bundle.addfile(info, io.BytesIO(payload))
            if malicious_member is not None:
                payload = b"escape\n"
                if malicious_member.isreg():
                    malicious_member.size = len(payload)
                    bundle.addfile(malicious_member, io.BytesIO(payload))
                else:
                    malicious_member.size = 0
                    bundle.addfile(malicious_member)

        payload = archive.read_bytes()
        manifest = {
            "schema": 1,
            "commit": COMMIT,
            "builtAt": BUILT_AT,
            "platform": "linux",
            "arch": "x64",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
        }
        if mutate_manifest is not None:
            mutate_manifest(manifest)
        manifest_path = root / MANIFEST_NAME
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        artifact = root / "artifact.zip"
        with zipfile.ZipFile(artifact, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.write(archive, ARCHIVE_NAME)
            bundle.write(manifest_path, MANIFEST_NAME)
            if extra_zip_entry:
                bundle.writestr("unexpected", b"no")
        archive.unlink()
        manifest_path.unlink()
        return artifact

    def _release_tarball(self, root: Path, commit: str = COMMIT) -> Path:
        release = self._release_tree(root)
        (release / "release.json").write_text(
            json.dumps({"schema": 1, "version": "0.9.0", "commit": commit,
                        "buildTime": BUILT_AT, "minUpgradeFrom": "0.9.0"}),
            encoding="utf-8",
        )
        (release / "ops").mkdir()
        (release / "ops" / "MANIFEST.sha256").write_text("", encoding="utf-8")
        archive = root / "artifact"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(release, arcname=".")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (root / "artifact.sha256").write_text(f"{digest}\n", encoding="utf-8")
        return archive

    def test_extracts_a_release_tarball_verified_by_its_sidecar_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self._release_tarball(root)
            work = root / "work"
            self.assertEqual(extract(archive, work, COMMIT), BUILT_AT)
            self.assertTrue((work / "release" / "release.json").is_file())
            self.assertTrue((work / "release" / "ops" / "MANIFEST.sha256").is_file())

    def test_rejects_a_tarball_whose_digest_or_metadata_commit_differs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self._release_tarball(root)
            (root / "artifact.sha256").write_text(f"{'0' * 64}\n", encoding="utf-8")
            with self.assertRaisesRegex(UnsafeArtifact, "SHA256SUMS"):
                extract(archive, root / "work-a", COMMIT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self._release_tarball(root, commit="b" * 40)
            with self.assertRaisesRegex(UnsafeArtifact, "release metadata is invalid"):
                extract(archive, root / "work-b", COMMIT)
            self.assertFalse((root / "work-b" / "release").exists())

    def test_extracts_only_the_pinned_regular_release_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = self._artifact(root)
            work = root / "work"

            self.assertEqual(extract(artifact, work, COMMIT), BUILT_AT)
            self.assertEqual(
                (work / "release" / "server.js").read_text(),
                "require('./brain-next-server.js')\n",
            )
            self.assertEqual(
                (work / "release" / "brain-next-server.js").read_text(),
                "console.log('brain')\n",
            )
            self.assertTrue((work / "release" / ".next" / "static").is_dir())
            self.assertEqual(
                json.loads(
                    (work / "release" / "mail-service" / "build.json").read_text()
                ),
                {"commit": COMMIT, "builtAt": BUILT_AT},
            )

    def test_rejects_missing_or_mismatched_mail_runtime(self):
        for case in (
            "missing-main",
            "missing-gmail",
            "missing-imap",
            "missing-send-state",
            "missing-recipients",
            "mismatched",
        ):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifact = self._artifact(
                    root,
                    omit_mail_file=(
                        "mail-service/service/main.js"
                        if case == "missing-main"
                        else (
                            "mail-service/providers/gmail/service-adapter.js"
                            if case == "missing-gmail"
                            else (
                                "mail-service/providers/imap/sync-adapter.js"
                                if case == "missing-imap"
                                else (
                                    "mail-service/send-state.js"
                                    if case == "missing-send-state"
                                    else (
                                        "mail-service/recipients.js"
                                        if case == "missing-recipients"
                                        else None
                                    )
                                )
                            )
                        )
                    ),
                    mail_commit=("b" * 40 if case == "mismatched" else COMMIT),
                )
                with self.assertRaises(UnsafeArtifact):
                    extract(artifact, root / "work", COMMIT)

    def test_verify_tree_requires_every_projected_gmail_oauth_module(self):
        for name in (
            "contract.js",
            "credentials.js",
            "oauth.js",
            "service-adapter.js",
            "token-envelope.js",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                release = self._release_tree(Path(directory))
                (release / "mail-service" / "providers" / "gmail" / name).unlink()

                with self.assertRaises(UnsafeArtifact):
                    _verify_release_tree(release)

    def test_verify_tree_requires_custom_domain_sync_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            release = self._release_tree(Path(directory))
            (release / "mail-service" / "providers" / "imap" / "sync-adapter.js").unlink()

            with self.assertRaises(UnsafeArtifact):
                _verify_release_tree(release)

    def test_rejects_path_traversal_and_links(self):
        for member in (
            tarfile.TarInfo("../escape"),
            tarfile.TarInfo("public/link"),
            tarfile.TarInfo("public/relative-link"),
            tarfile.TarInfo("public/broken-link"),
        ):
            with self.subTest(member=member.name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if member.name == "public/link":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                elif member.name == "public/relative-link":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "../../etc/passwd"
                elif member.name == "public/broken-link":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "missing-target"
                artifact = self._artifact(root, malicious_member=member)

                with self.assertRaises(UnsafeArtifact):
                    extract(artifact, root / "work", COMMIT)
                self.assertFalse((root / "escape").exists())

    def test_accepts_a_relative_link_that_resolves_inside_the_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            link = tarfile.TarInfo("node_modules/package-link")
            link.type = tarfile.SYMTYPE
            link.linkname = "../package.json"
            artifact = self._artifact(root, malicious_member=link)

            extract(artifact, root / "work", COMMIT)
            extracted_link = root / "work" / "release" / "node_modules" / "package-link"
            self.assertTrue(extracted_link.is_symlink())
            self.assertEqual(extracted_link.resolve().name, "package.json")

    def test_verify_tree_rejects_broken_cyclic_and_out_of_root_links(self):
        for name, target in (
            ("broken", "missing-target"),
            ("outside", "/etc/passwd"),
            ("cycle", "cycle"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                release = self._release_tree(Path(directory))
                (release / "public" / name).symlink_to(target)
                with self.assertRaises(UnsafeArtifact):
                    _verify_release_tree(release)

    def test_verify_tree_rejects_a_symlink_in_a_required_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = self._release_tree(root)
            real_next = release / "real-next"
            (real_next / "static").mkdir(parents=True)
            (release / ".next" / "static").rmdir()
            (release / ".next").rmdir()
            (release / ".next").symlink_to("real-next")

            with self.assertRaisesRegex(UnsafeArtifact, "crosses a symbolic link"):
                _verify_release_tree(release)

    def test_verify_tree_requires_the_shutdown_runtime_files(self):
        for name in ("brain-next-server.js", "brain-shutdown-preload.mjs"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                release = self._release_tree(Path(directory))
                (release / name).unlink()

                with self.assertRaisesRegex(
                    UnsafeArtifact, "required standalone file"
                ):
                    _verify_release_tree(release)

    def test_rejects_extra_zip_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = self._artifact(root, extra_zip_entry=True)
            with self.assertRaisesRegex(UnsafeArtifact, "exactly two"):
                extract(artifact, root / "work", COMMIT)

    def test_rejects_manifest_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = self._artifact(
                root, mutate_manifest=lambda manifest: manifest.update(platform="darwin")
            )
            with self.assertRaisesRegex(UnsafeArtifact, "manifest is invalid"):
                extract(artifact, root / "work", COMMIT)


if __name__ == "__main__":
    unittest.main()
