import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "ops" / "brain-mail-state-rollback.py"
SPEC = importlib.util.spec_from_file_location("brain_mail_state_rollback", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
rollback = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollback)


SNAPSHOT_NAME = "20260714T120000Z-0123456789abcdef0123456789abcdef"


class StoppedGate:
    def __init__(self, fail_on: int | None = None) -> None:
        self.calls = 0
        self.fail_on = fail_on

    def assert_stopped(self) -> None:
        self.calls += 1
        if self.calls == self.fail_on:
            raise rollback.StateRollbackError("brain-mail.service must be exactly inactive")


class InjectedCrash(BaseException):
    pass


class BrainMailStateRollbackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="brain-mail-state-rollback-")
        self.base = Path(self.temp.name)
        self.base.chmod(0o700)
        self.state = self.base / "brain-mail"
        self.state.mkdir(mode=0o700)
        self.snapshots = self.base / "snapshots"
        self.restores = self.base / "restores"
        self.uid = os.getuid()
        self.gid = os.getgid()
        self.seed_v1_state()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def seed_v1_state(self) -> None:
        account = self.state / "account.v1.json"
        account.write_bytes(b'{"ciphertext":"legacy"}\n')
        account.chmod(0o600)
        cache = self.state / "cache" / "legacy-account"
        cache.mkdir(parents=True, mode=0o700)
        message = cache / "message.bin"
        message.write_bytes(b"legacy-cache\x00bytes")
        message.chmod(0o640)

    def snapshot(self, gate: StoppedGate | None = None) -> Path:
        return rollback.create_snapshot(
            self.state,
            self.snapshots,
            self.restores,
            gate or StoppedGate(),
            expected_state_owner=self.uid,
            expected_state_group=self.gid,
            expected_root_owner=self.uid,
            expected_root_group=self.gid,
            name=SNAPSHOT_NAME,
        )

    def restore(
        self,
        snapshot: Path,
        gate: StoppedGate | None = None,
        after_exchange=None,
    ) -> Path:
        return rollback.restore_snapshot(
            snapshot,
            self.state,
            self.snapshots,
            self.restores,
            gate or StoppedGate(),
            expected_root_owner=self.uid,
            expected_root_group=self.gid,
            expected_state_owner=self.uid,
            expected_state_group=self.gid,
            exchange=self.exchange_directories,
            after_exchange=after_exchange,
        )

    def exchange_directories(self, left: Path, right: Path) -> None:
        temporary = self.base / ".test-exchange"
        os.rename(left, temporary)
        os.rename(right, left)
        os.rename(temporary, right)

    def seed_v2_state(self) -> None:
        for child in list(self.state.iterdir()):
            if child.is_dir():
                import shutil

                shutil.rmtree(child)
            else:
                child.unlink()
        database = self.state / "local.sqlite3"
        database.write_bytes(b"sqlite-v2")
        database.chmod(0o600)
        wal = self.state / "local.sqlite3-wal"
        wal.write_bytes(b"wal-v2")
        wal.chmod(0o600)
        shared = self.state / "local.sqlite3-shm"
        shared.write_bytes(b"shm-v2")
        shared.chmod(0o600)
        cache = self.state / "cache" / "gmail-account"
        cache.mkdir(parents=True, mode=0o700)
        (cache / "thread.json").write_text("new local state\n", encoding="utf-8")

    def test_snapshot_copies_the_complete_tree_and_exact_metadata(self) -> None:
        gate = StoppedGate()

        snapshot = self.snapshot(gate)

        self.assertEqual(gate.calls, 2)
        self.assertEqual(
            {path.relative_to(snapshot).as_posix() for path in snapshot.rglob("*")},
            {
                "MANIFEST.json",
                "MANIFEST.sha256",
                "READY",
                "state",
                "state/account.v1.json",
                "state/cache",
                "state/cache/legacy-account",
                "state/cache/legacy-account/message.bin",
            },
        )
        rollback.verify_snapshot(snapshot, self.snapshots, self.uid)
        copied = snapshot / "state/cache/legacy-account/message.bin"
        self.assertEqual(copied.read_bytes(), b"legacy-cache\x00bytes")
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o640)
        self.assertEqual(copied.stat().st_uid, self.uid)
        self.assertEqual(copied.stat().st_gid, self.gid)

    def test_snapshot_refuses_symlinks_and_removes_unpublished_preparation(self) -> None:
        (self.state / "unsafe-link").symlink_to(self.state / "account.v1.json")

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "symlink, hard link, or special file",
        ):
            self.snapshot()

        self.assertEqual(list(self.snapshots.iterdir()), [])

    def test_snapshot_rechecks_stopped_state_before_publish(self) -> None:
        gate = StoppedGate(fail_on=2)

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "must be exactly inactive",
        ):
            self.snapshot(gate)

        self.assertEqual(gate.calls, 2)
        self.assertEqual(list(self.snapshots.iterdir()), [])

    def test_snapshot_keeps_sqlite_wal_and_shared_memory_in_the_same_tree(self) -> None:
        for name, content in (
            ("local.sqlite3", b"database"),
            ("local.sqlite3-wal", b"write-ahead-log"),
            ("local.sqlite3-shm", b"shared-memory"),
        ):
            (self.state / name).write_bytes(content)

        snapshot = self.snapshot()

        for name, content in (
            ("local.sqlite3", b"database"),
            ("local.sqlite3-wal", b"write-ahead-log"),
            ("local.sqlite3-shm", b"shared-memory"),
        ):
            self.assertEqual((snapshot / "state" / name).read_bytes(), content)
        rollback.verify_snapshot(snapshot, self.snapshots, self.uid)

    def test_tampered_snapshot_fails_before_live_state_changes(self) -> None:
        snapshot = self.snapshot()
        self.seed_v2_state()
        before = (self.state / "local.sqlite3").read_bytes()
        (snapshot / "state/account.v1.json").write_bytes(b"tampered")

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "snapshot state bytes or metadata do not match",
        ):
            self.restore(snapshot)

        self.assertEqual((self.state / "local.sqlite3").read_bytes(), before)
        self.assertEqual(list(self.restores.iterdir()), [])

    def test_restore_atomically_replaces_the_whole_tree_and_retains_v2_state(self) -> None:
        snapshot = self.snapshot()
        self.seed_v2_state()
        gate = StoppedGate()

        replaced = self.restore(snapshot, gate)

        self.assertGreaterEqual(gate.calls, 3)
        self.assertEqual(
            (self.state / "account.v1.json").read_bytes(),
            b'{"ciphertext":"legacy"}\n',
        )
        self.assertFalse((self.state / "local.sqlite3").exists())
        self.assertEqual((replaced / "local.sqlite3").read_bytes(), b"sqlite-v2")
        self.assertEqual((replaced / "local.sqlite3-wal").read_bytes(), b"wal-v2")
        self.assertEqual((replaced / "local.sqlite3-shm").read_bytes(), b"shm-v2")
        self.assertTrue((replaced.parent / "COMMITTED").is_file())
        rollback.verify_snapshot(snapshot, self.snapshots, self.uid)

    def test_restore_resumes_when_exchange_completed_before_marker(self) -> None:
        snapshot = self.snapshot()
        self.seed_v2_state()

        with self.assertRaises(InjectedCrash):
            self.restore(snapshot, after_exchange=lambda: (_ for _ in ()).throw(InjectedCrash()))

        transactions = list(self.restores.iterdir())
        self.assertEqual(len(transactions), 1)
        transaction = transactions[0]
        self.assertFalse((transaction / "COMMITTED").exists())
        self.assertTrue((self.state / "account.v1.json").exists())
        self.assertTrue((transaction / "stage/local.sqlite3").exists())

        replaced = self.restore(snapshot)

        self.assertEqual(replaced, transaction / "replaced-state")
        self.assertTrue((transaction / "COMMITTED").is_file())
        self.assertEqual((replaced / "local.sqlite3").read_bytes(), b"sqlite-v2")

    def test_restore_rechecks_stopped_state_immediately_before_exchange(self) -> None:
        snapshot = self.snapshot()
        self.seed_v2_state()
        gate = StoppedGate(fail_on=4)

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "must be exactly inactive",
        ):
            self.restore(snapshot, gate)

        self.assertEqual(gate.calls, 4)
        self.assertEqual((self.state / "local.sqlite3").read_bytes(), b"sqlite-v2")
        transaction = next(self.restores.iterdir())
        self.assertTrue((transaction / "stage/account.v1.json").is_file())
        self.assertFalse((transaction / "COMMITTED").exists())

        replaced = self.restore(snapshot)

        self.assertEqual((self.state / "account.v1.json").read_bytes(), b'{"ciphertext":"legacy"}\n')
        self.assertEqual((replaced / "local.sqlite3").read_bytes(), b"sqlite-v2")

    def test_restore_fails_closed_when_interrupted_trees_are_ambiguous(self) -> None:
        snapshot = self.snapshot()
        self.seed_v2_state()

        with self.assertRaises(InjectedCrash):
            self.restore(snapshot, after_exchange=lambda: (_ for _ in ()).throw(InjectedCrash()))

        transaction = next(self.restores.iterdir())
        (self.state / "account.v1.json").write_bytes(b"unknown-live-state")
        (transaction / "stage/local.sqlite3").write_bytes(b"unknown-replaced-state")

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "restore state is ambiguous",
        ):
            self.restore(snapshot)

        self.assertEqual(
            (self.state / "account.v1.json").read_bytes(), b"unknown-live-state"
        )
        self.assertFalse((transaction / "COMMITTED").exists())

    def test_snapshot_path_must_be_a_direct_guarded_child(self) -> None:
        snapshot = self.snapshot()

        with self.assertRaisesRegex(
            rollback.StateRollbackError,
            "direct guarded snapshot",
        ):
            rollback.verify_snapshot(snapshot / "state", self.snapshots, self.uid)

    @unittest.skipUnless(sys.platform.startswith("linux"), "renameat2 is Linux-only")
    def test_linux_directory_exchange_never_exposes_a_missing_live_path(self) -> None:
        left = self.base / "left"
        right = self.base / "right"
        left.mkdir()
        right.mkdir()
        (left / "identity").write_text("left", encoding="utf-8")
        (right / "identity").write_text("right", encoding="utf-8")

        rollback._exchange_directories(left, right)

        self.assertEqual((left / "identity").read_text(encoding="utf-8"), "right")
        self.assertEqual((right / "identity").read_text(encoding="utf-8"), "left")


if __name__ == "__main__":
    unittest.main()
