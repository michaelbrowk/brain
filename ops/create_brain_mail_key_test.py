import hashlib
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
KEY_SCRIPT = ROOT / "ops" / "create-brain-mail-key.sh"


@unittest.skipUnless(sys.platform.startswith("linux"), "GNU/Linux key rehearsal")
@unittest.skipUnless(os.geteuid() == 0, "root-only key ownership proof")
class BrainMailKeyRehearsal(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="brain-mail-key-")
        self.base = Path(self.temp.name)
        self.nonzero_gid = os.getgid() if os.getgid() != 0 else 65534
        self.nonroot_uid = os.getuid() if os.getuid() != 0 else 65534

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_as_root(
        self, *command: str, check: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=check,
        )

    def make_case(
        self, name: str, *, owner_uid: int = 0, mode: int = 0o750
    ) -> tuple[Path, Path]:
        case = self.base / name
        case.mkdir(mode=0o700)
        key_dir = case / "etc-brain"
        key_dir.mkdir(mode=0o700)
        os.chown(key_dir, owner_uid, self.nonzero_gid)
        key_dir.chmod(mode)

        source = KEY_SCRIPT.read_text(encoding="utf-8")
        self.assertEqual(source.count("key_dir=/etc/brain"), 1)
        script = case / "create-brain-mail-key.sh"
        script.write_text(
            source.replace(
                "key_dir=/etc/brain",
                f"key_dir={shlex.quote(str(key_dir))}",
                1,
            ),
            encoding="utf-8",
        )
        script.chmod(0o700)
        return key_dir, script

    def assert_exact_key(self, key_dir: Path) -> None:
        key = key_dir / "brain-mail-account.key"
        metadata = key.stat()
        self.assertEqual(metadata.st_size, 32)
        self.assertEqual(metadata.st_uid, 0)
        self.assertEqual(metadata.st_gid, 0)
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o400)
        self.assertEqual(metadata.st_nlink, 1)
        self.assertEqual(list(key_dir.glob(".brain-mail-account.key.*")), [])

    def test_accepts_root_owned_nonzero_group_directory_and_refuses_overwrite(
        self,
    ) -> None:
        key_dir, script = self.make_case("root-nonzero-group")
        self.assertEqual(key_dir.stat().st_gid, self.nonzero_gid)

        created = self.run_as_root("/bin/bash", str(script))
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertIn("wrapping key created", created.stdout)
        self.assert_exact_key(key_dir)
        key = key_dir / "brain-mail-account.key"
        original_sha256 = hashlib.sha256(key.read_bytes()).digest()

        repeated = self.run_as_root("/bin/bash", str(script))
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("refusing to overwrite or rotate", repeated.stderr)
        self.assert_exact_key(key_dir)
        self.assertEqual(hashlib.sha256(key.read_bytes()).digest(), original_sha256)

    def test_refuses_existing_key_symlink_without_mutating_target(self) -> None:
        key_dir, script = self.make_case("existing-key-symlink")
        target = key_dir.parent / "outside-key"
        original = b"must remain unchanged\n"
        target.write_bytes(original)
        key = key_dir / "brain-mail-account.key"
        key.symlink_to(target)

        refused = self.run_as_root("/bin/bash", str(script))
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("refusing to overwrite or rotate", refused.stderr)
        self.assertTrue(key.is_symlink())
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(list(key_dir.glob(".brain-mail-account.key.*")), [])

    def test_refuses_nonroot_directory_owner(self) -> None:
        key_dir, script = self.make_case(
            "nonroot-owner", owner_uid=self.nonroot_uid
        )
        refused = self.run_as_root("/bin/bash", str(script))
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("directory ownership is unsafe", refused.stderr)
        self.assertFalse((key_dir / "brain-mail-account.key").exists())

    def test_refuses_group_or_world_writable_directory(self) -> None:
        for name, mode in (("group-writable", 0o770), ("world-writable", 0o752)):
            with self.subTest(mode=oct(mode)):
                key_dir, script = self.make_case(name, mode=mode)
                refused = self.run_as_root("/bin/bash", str(script))
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn("writable by another identity", refused.stderr)
                self.assertFalse((key_dir / "brain-mail-account.key").exists())

    def test_refuses_symlink_directory(self) -> None:
        key_dir, script = self.make_case("symlink-directory")
        real_key_dir = key_dir.with_name("real-etc-brain")
        key_dir.rename(real_key_dir)
        key_dir.symlink_to(real_key_dir, target_is_directory=True)

        refused = self.run_as_root("/bin/bash", str(script))
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("key directory is unsafe", refused.stderr)
        self.assertFalse((real_key_dir / "brain-mail-account.key").exists())

    def test_concurrent_creation_publishes_exactly_one_key(self) -> None:
        key_dir, script = self.make_case("concurrent")
        command = ["/bin/bash", str(script)]
        first = subprocess.Popen(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        second = subprocess.Popen(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        first_output = first.communicate(timeout=15)
        second_output = second.communicate(timeout=15)

        returncodes = sorted((first.returncode, second.returncode))
        self.assertEqual(returncodes.count(0), 1, (first_output, second_output))
        self.assertEqual(sum(code != 0 for code in returncodes), 1)
        self.assert_exact_key(key_dir)


if __name__ == "__main__":
    unittest.main()
