import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

SOURCES = (
    "brain-mail.service",
    "brain-mail.socket",
    "brain-mail-mime.socket",
    "brain-mail-mime@.service",
    "brain-mail.sysusers.conf",
    "brain-mail-mime.sysusers.conf",
    "brain-mail.tmpfiles.conf",
    "brain-mail-mime.tmpfiles.conf",
    "project_mail_runtime.py",
    "create-brain-mail-key.sh",
    "brain-mail-state-rollback.py",
    "install-brain-mail.sh",
    "rollback-brain-mail-install.sh",
    "brain.service.d/90-brain-mail-client.conf",
    "mail-account-connect-operations.md",
    "brain-mail.service.d/90-smtp-egress.conf.example",
    "mail-egress-operations.md",
)
DESTINATIONS = (
    "etc/systemd/system/brain-mail.service",
    "etc/systemd/system/brain-mail.socket",
    "etc/systemd/system/brain-mail-mime.socket",
    "etc/systemd/system/brain-mail-mime@.service",
    "usr/lib/sysusers.d/brain-mail.conf",
    "usr/lib/sysusers.d/brain-mail-mime.conf",
    "usr/lib/tmpfiles.d/brain-mail.conf",
    "usr/lib/tmpfiles.d/brain-mail-mime.conf",
    "opt/brain/bin/project_mail_runtime.py",
    "opt/brain/bin/create-brain-mail-key.sh",
    "opt/brain/bin/brain-mail-state-rollback.py",
    "opt/brain/bin/install-brain-mail.sh",
    "opt/brain/bin/rollback-brain-mail-install.sh",
    "etc/systemd/system/brain.service.d/90-brain-mail-client.conf",
    "opt/brain/share/mail-account-connect-operations.md",
    "opt/brain/share/brain-mail.service.d/90-smtp-egress.conf.example",
    "opt/brain/share/mail-egress-operations.md",
)
MODES = (
    0o644,
    0o644,
    0o644,
    0o644,
    0o644,
    0o644,
    0o644,
    0o644,
    0o755,
    0o755,
    0o755,
    0o755,
    0o755,
    0o644,
    0o644,
    0o644,
    0o644,
)


@unittest.skipUnless(sys.platform.startswith("linux"), "GNU/Linux ops rehearsal")
class BrainMailInstallRehearsal(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="brain-mail-install-")
        self.base = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_fixture(self, name: str) -> tuple[Path, Path]:
        case = self.base / name
        install_root = case / "root"
        source = case / "brain-mail-ops"
        install_root.mkdir(parents=True, mode=0o700)
        source.mkdir(parents=True, mode=0o750)
        for relative in SOURCES:
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if relative in {
                "mail-account-connect-operations.md",
                "mail-egress-operations.md",
            }:
                original = ROOT / "docs" / relative
            elif relative.startswith("brain.service.d/"):
                original = ROOT / "ops" / relative
            else:
                original = ROOT / "ops" / relative
            shutil.copyfile(original, destination)
            destination.chmod(0o440)
        manifest = source / "MANIFEST.sha256"
        manifest.write_text(
            "".join(
                f"{hashlib.sha256((source / relative).read_bytes()).hexdigest()}  {relative}\n"
                for relative in SOURCES
            ),
            encoding="utf-8",
        )
        manifest.chmod(0o440)
        (source / "brain.service.d").chmod(0o550)
        (source / "brain-mail.service.d").chmod(0o550)
        source.chmod(0o550)
        return install_root, source

    def environment(self, install_root: Path, **extra: str) -> dict[str, str]:
        return {
            **os.environ,
            "BRAIN_MAIL_INSTALL_ROOT": str(install_root),
            **extra,
        }

    def seed_existing(self, install_root: Path) -> dict[int, tuple[bytes, int, int, int]]:
        expected: dict[int, tuple[bytes, int, int, int]] = {}
        for index in (0, 4, 9):
            destination = install_root / DESTINATIONS[index]
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = f"old-{index}\n".encode()
            destination.write_bytes(content)
            destination.chmod(0o600 + index % 2 * 0o040)
            metadata = destination.stat()
            expected[index] = (
                content,
                stat.S_IMODE(metadata.st_mode),
                metadata.st_uid,
                metadata.st_gid,
            )
        return expected

    def transaction(self, install_root: Path) -> Path:
        transactions = install_root / "var/lib/brain-mail-install-transactions"
        entries = list(transactions.iterdir())
        self.assertEqual(len(entries), 1)
        return entries[0]

    def install_command(self, source: Path) -> list[str]:
        return ["/bin/bash", str(source / "install-brain-mail.sh"), str(source)]

    def rollback_command(self, transaction: Path) -> list[str]:
        return [
            "/bin/bash",
            str(transaction / "rollback-recovery.sh"),
            str(transaction),
        ]

    def assert_restored(
        self,
        install_root: Path,
        existing: dict[int, tuple[bytes, int, int, int]],
    ) -> None:
        for index, relative in enumerate(DESTINATIONS):
            destination = install_root / relative
            if index not in existing:
                self.assertFalse(destination.exists(), relative)
                continue
            content, mode, uid, gid = existing[index]
            self.assertEqual(destination.read_bytes(), content)
            metadata = destination.stat()
            self.assertEqual(stat.S_IMODE(metadata.st_mode), mode)
            self.assertEqual(metadata.st_uid, uid)
            self.assertEqual(metadata.st_gid, gid)

    def destination_snapshot(
        self, install_root: Path
    ) -> dict[str, tuple[bytes, int, int, int] | None]:
        snapshot: dict[str, tuple[bytes, int, int, int] | None] = {}
        for relative in DESTINATIONS:
            destination = install_root / relative
            if not destination.exists():
                snapshot[relative] = None
                continue
            metadata = destination.stat()
            snapshot[relative] = (
                destination.read_bytes(),
                stat.S_IMODE(metadata.st_mode),
                metadata.st_uid,
                metadata.st_gid,
            )
        return snapshot

    def test_install_and_manual_rollback_restore_exact_files(self) -> None:
        install_root, source = self.make_fixture("normal")
        existing = self.seed_existing(install_root)
        installed = subprocess.run(
            self.install_command(source),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertIn("installed but disabled", installed.stdout)
        self.assertNotRegex(installed.stdout + installed.stderr, r"systemctl\s+(enable|start|restart)")
        transaction = self.transaction(install_root)
        self.assertTrue((transaction / "COMMITTED").is_file())
        for relative, source_relative, mode in zip(
            DESTINATIONS, SOURCES, MODES, strict=True
        ):
            destination = install_root / relative
            self.assertEqual(destination.read_bytes(), (source / source_relative).read_bytes())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), mode)

        rolled_back = subprocess.run(
            self.rollback_command(transaction),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertIn("rolled back Brain Mail files", rolled_back.stdout)
        self.assert_restored(install_root, existing)
        self.assertTrue((transaction / "ROLLED_BACK").is_file())
        repeated = subprocess.run(
            self.rollback_command(transaction),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(repeated.returncode, 0)

    def test_every_injected_install_failure_rolls_back(self) -> None:
        for failure_after in range(1, len(SOURCES) + 1):
            with self.subTest(failure_after=failure_after):
                install_root, source = self.make_fixture(f"failure-{failure_after}")
                existing = self.seed_existing(install_root)
                result = subprocess.run(
                    self.install_command(source),
                    env=self.environment(
                        install_root,
                        BRAIN_MAIL_INSTALL_TEST_FAIL_AFTER=str(failure_after),
                    ),
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assert_restored(install_root, existing)
                self.assertTrue(
                    (self.transaction(install_root) / "AUTO_ROLLED_BACK").is_file()
                )
                self.assertTrue(
                    (self.transaction(install_root) / "ROLLED_BACK").is_file()
                )

    def test_sigkill_after_each_install_rename_or_marker_is_recoverable(self) -> None:
        for hook in (
            "BRAIN_MAIL_INSTALL_TEST_KILL_AFTER_MV",
            "BRAIN_MAIL_INSTALL_TEST_KILL_AFTER_MARKER",
        ):
            for kill_after in range(1, len(SOURCES) + 1):
                with self.subTest(hook=hook, kill_after=kill_after):
                    install_root, source = self.make_fixture(
                        f"install-kill-{hook}-{kill_after}"
                    )
                    existing = self.seed_existing(install_root)
                    killed = subprocess.run(
                        self.install_command(source),
                        env=self.environment(
                            install_root,
                            **{hook: str(kill_after)},
                        ),
                        text=True,
                        capture_output=True,
                    )
                    self.assertEqual(killed.returncode, -signal.SIGKILL)
                    transaction = self.transaction(install_root)
                    self.assertTrue((transaction / "PREPARED").is_file())
                    self.assertFalse((transaction / "COMMITTED").exists())

                    blocked = subprocess.run(
                        self.install_command(source),
                        env=self.environment(install_root),
                        text=True,
                        capture_output=True,
                    )
                    self.assertNotEqual(blocked.returncode, 0)
                    self.assertIn("requires rollback", blocked.stderr)

                    if kill_after <= 8:
                        self.assertFalse(
                            (install_root / DESTINATIONS[8]).exists(),
                            "installed rollback must still be absent before index 8",
                        )
                    source.rename(source.with_name(f"{source.name}.pruned"))

                    subprocess.run(
                        self.rollback_command(transaction),
                        env=self.environment(install_root),
                        text=True,
                        capture_output=True,
                        check=True,
                    )
                    self.assert_restored(install_root, existing)
                    self.assertTrue((transaction / "ROLLED_BACK").is_file())

    def test_sigkill_after_each_rollback_restore_or_marker_is_resumable(self) -> None:
        for hook in (
            "BRAIN_MAIL_ROLLBACK_TEST_KILL_AFTER_RESTORE",
            "BRAIN_MAIL_ROLLBACK_TEST_KILL_AFTER_MARKER",
        ):
            for kill_after in range(1, len(DESTINATIONS) + 1):
                with self.subTest(hook=hook, kill_after=kill_after):
                    install_root, source = self.make_fixture(
                        f"rollback-kill-{hook}-{kill_after}"
                    )
                    existing = self.seed_existing(install_root)
                    subprocess.run(
                        self.install_command(source),
                        env=self.environment(install_root),
                        text=True,
                        capture_output=True,
                        check=True,
                    )
                    transaction = self.transaction(install_root)
                    killed = subprocess.run(
                        self.rollback_command(transaction),
                        env=self.environment(
                            install_root,
                            **{hook: str(kill_after)},
                        ),
                        text=True,
                        capture_output=True,
                    )
                    self.assertEqual(killed.returncode, -signal.SIGKILL)
                    self.assertFalse((transaction / "ROLLED_BACK").exists())

                    subprocess.run(
                        self.rollback_command(transaction),
                        env=self.environment(install_root),
                        text=True,
                        capture_output=True,
                        check=True,
                    )
                    self.assert_restored(install_root, existing)
                    self.assertTrue((transaction / "ROLLED_BACK").is_file())

    def test_manual_rollback_refuses_content_or_mode_tampering(self) -> None:
        for kind in ("content", "mode"):
            with self.subTest(kind=kind):
                install_root, source = self.make_fixture(f"tamper-{kind}")
                self.seed_existing(install_root)
                subprocess.run(
                    self.install_command(source),
                    env=self.environment(install_root),
                    check=True,
                    capture_output=True,
                )
                transaction = self.transaction(install_root)
                destination = install_root / DESTINATIONS[1]
                if kind == "content":
                    destination.write_text("operator change\n", encoding="utf-8")
                else:
                    destination.chmod(0o600)
                result = subprocess.run(
                    self.rollback_command(transaction),
                    env=self.environment(install_root),
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((transaction / "ROLLED_BACK").exists())

    def test_corrupt_later_backup_refuses_before_any_destination_change(self) -> None:
        install_root, source = self.make_fixture("corrupt-later-backup")
        self.seed_existing(install_root)
        subprocess.run(
            self.install_command(source),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
            check=True,
        )
        transaction = self.transaction(install_root)
        installed_snapshot = self.destination_snapshot(install_root)
        backups = sorted(
            transaction.glob("*.backup"),
            key=lambda path: int(path.stem),
        )
        self.assertGreaterEqual(len(backups), 2)
        backups[-1].write_bytes(b"corrupt-backup\n")

        refused = subprocess.run(
            self.rollback_command(transaction),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("backup hash", refused.stderr)
        self.assertEqual(self.destination_snapshot(install_root), installed_snapshot)
        self.assertEqual(list(transaction.glob("*.RESTORING")), [])

    def test_rollback_refuses_while_an_install_lock_is_held(self) -> None:
        install_root, source = self.make_fixture("concurrent-lock")
        existing = self.seed_existing(install_root)
        subprocess.run(
            self.install_command(source),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
            check=True,
        )
        transaction = self.transaction(install_root)
        lock_path = install_root / "run/brain-mail-install.lock"
        with lock_path.open("w", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            blocked = subprocess.run(
                self.rollback_command(transaction),
                env=self.environment(install_root),
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("another Brain Mail install or rollback", blocked.stderr)
        subprocess.run(
            self.rollback_command(transaction),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
            check=True,
        )
        self.assert_restored(install_root, existing)

    def test_exact_tree_rejects_extra_symlink(self) -> None:
        install_root, source = self.make_fixture("extra-symlink")
        source.chmod(0o750)
        (source / "unexpected").symlink_to("brain-mail.service")
        source.chmod(0o550)
        result = subprocess.run(
            self.install_command(source),
            env=self.environment(install_root),
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("allowlist mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
