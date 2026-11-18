from __future__ import annotations

import os
from pathlib import Path
import pwd
import shutil
import stat
import tempfile
import unittest

from project_mail_runtime import (
    LEGACY_REQUIRED_DIRECTORIES,
    LEGACY_REQUIRED_FILES,
    REQUIRED_DIRECTORIES,
    REQUIRED_FILES,
    RECIPIENT_RUNTIME_FILES,
    REMOTE_IMAGE_RUNTIME_FILES,
    SMTP_RUNTIME_FILES,
    UnsafeMailRuntime,
    project_mail_runtime,
)


class ProjectMailRuntimeTest(unittest.TestCase):
    def _source(self, root: Path, owner: int, group: int) -> Path:
        source = root / "source"
        source.mkdir()
        for relative in REQUIRED_DIRECTORIES:
            (source / relative).mkdir()
        for relative in REQUIRED_FILES:
            path = source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"runtime:{relative}\n", encoding="utf-8")
            os.chown(path, owner, group)
            path.chmod(0o440)
        for directory in (
            *(source / relative for relative in reversed(REQUIRED_DIRECTORIES)),
            source,
        ):
            os.chown(directory, owner, group)
            directory.chmod(0o550)
        return source

    def _runtime_root(
        self,
        root: Path,
        owner: int,
        group: int,
        mode: int = 0o550,
    ) -> Path:
        runtime = root / "runtime"
        runtime.mkdir()
        os.chown(runtime, owner, group)
        runtime.chmod(mode)
        return runtime

    def test_projects_only_exact_read_only_runtime_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            (source / "credential.txt").write_text("must-not-copy", encoding="utf-8")
            gmail_source = source / "providers" / "gmail"
            gmail_source.chmod(0o700)
            (gmail_source / "unrelated.js").write_text(
                "must-not-copy", encoding="utf-8"
            )
            gmail_source.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            current = project_mail_runtime(
                source,
                runtime,
                group,
                owner,
                0o750,
                seal_before_swap=False,
            )
            projected = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_file()
            }
            projected_directories = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_dir()
            }
            self.assertEqual(projected, set(REQUIRED_FILES))
            self.assertEqual(projected_directories, set(REQUIRED_DIRECTORIES))
            self.assertFalse((current / "credential.txt").exists())
            self.assertFalse(
                (current / "providers" / "gmail" / "unrelated.js").exists()
            )
            for relative in REQUIRED_FILES:
                metadata = (current / relative).stat()
                self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o440)
                self.assertEqual(metadata.st_uid, owner)
                self.assertEqual(metadata.st_gid, group)
            for relative in (Path("."), *REQUIRED_DIRECTORIES):
                metadata = (current / relative).stat()
                self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o550)

    def test_rejects_a_linked_runtime_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            target = source / "ports.js"
            replacement = source / "linked.js"
            source.chmod(0o700)
            target.rename(replacement)
            target.symlink_to(replacement.name)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            with self.assertRaises(UnsafeMailRuntime):
                project_mail_runtime(
                    source,
                    runtime,
                    group,
                    owner,
                    0o750,
                    seal_before_swap=False,
                )

    def test_rejects_a_missing_gmail_runtime_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            gmail = source / "providers" / "gmail"
            gmail.chmod(0o700)
            (gmail / "service-adapter.js").unlink()
            gmail.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            with self.assertRaises((OSError, UnsafeMailRuntime)):
                project_mail_runtime(
                    source,
                    runtime,
                    group,
                    owner,
                    0o750,
                    seal_before_swap=False,
                )

    def test_rejects_a_missing_imap_runtime_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            imap = source / "providers" / "imap"
            imap.chmod(0o700)
            (imap / "sync-adapter.js").unlink()
            imap.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            with self.assertRaises((OSError, UnsafeMailRuntime)):
                project_mail_runtime(
                    source,
                    runtime,
                    group,
                    owner,
                    0o750,
                    seal_before_swap=False,
                )

    def test_projects_previous_release_without_an_imap_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            providers = source / "providers"
            imap = providers / "imap"
            source.chmod(0o700)
            providers.chmod(0o700)
            imap.chmod(0o700)
            (imap / "sync-adapter.js").unlink()
            imap.rmdir()
            providers.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            current = project_mail_runtime(
                source,
                runtime,
                group,
                owner,
                0o750,
                seal_before_swap=False,
            )

            projected = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_file()
            }
            projected_directories = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_dir()
            }
            self.assertEqual(projected, set(LEGACY_REQUIRED_FILES))
            self.assertEqual(
                projected_directories,
                set(LEGACY_REQUIRED_DIRECTORIES),
            )

    def test_projects_previous_release_without_an_smtp_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            for relative in SMTP_RUNTIME_FILES:
                parent = source / relative.parent
                parent.chmod(0o700)
                (source / relative).unlink()
                parent.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            current = project_mail_runtime(
                source,
                runtime,
                group,
                owner,
                0o750,
                seal_before_swap=False,
            )

            projected = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_file()
            }
            self.assertEqual(projected, set(REQUIRED_FILES) - set(SMTP_RUNTIME_FILES))

    def test_rejects_a_partial_smtp_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            missing = source / SMTP_RUNTIME_FILES[-1]
            missing.parent.chmod(0o700)
            missing.unlink()
            missing.parent.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            with self.assertRaisesRegex(
                UnsafeMailRuntime,
                "mail SMTP runtime layout is incomplete",
            ):
                project_mail_runtime(
                    source,
                    runtime,
                    group,
                    owner,
                    0o750,
                    seal_before_swap=False,
                )

    def test_projects_previous_release_without_a_remote_image_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            for relative in REMOTE_IMAGE_RUNTIME_FILES:
                parent = source / relative.parent
                parent.chmod(0o700)
                (source / relative).unlink()
                parent.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            current = project_mail_runtime(
                source,
                runtime,
                group,
                owner,
                0o750,
                seal_before_swap=False,
            )

            projected = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_file()
            }
            self.assertEqual(
                projected,
                set(REQUIRED_FILES) - set(REMOTE_IMAGE_RUNTIME_FILES),
            )

    def test_rejects_a_partial_remote_image_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            missing = source / REMOTE_IMAGE_RUNTIME_FILES[-1]
            missing.parent.chmod(0o700)
            missing.unlink()
            missing.parent.chmod(0o550)
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            with self.assertRaisesRegex(
                UnsafeMailRuntime,
                "mail remote-image runtime layout is incomplete",
            ):
                project_mail_runtime(
                    source,
                    runtime,
                    group,
                    owner,
                    0o750,
                    seal_before_swap=False,
                )

    def test_projects_previous_release_without_a_recipient_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = os.geteuid()
            group = os.getegid()
            source = self._source(root, owner, group)
            source.chmod(0o700)
            for relative in RECIPIENT_RUNTIME_FILES:
                (source / relative).unlink()
            source.chmod(0o550)
            runtime = self._runtime_root(root, owner, group, 0o750)

            current = project_mail_runtime(
                source,
                runtime,
                group,
                owner,
                0o750,
                seal_before_swap=False,
            )

            projected = {
                path.relative_to(current)
                for path in current.rglob("*")
                if path.is_file()
            }
            self.assertEqual(
                projected,
                set(REQUIRED_FILES) - set(RECIPIENT_RUNTIME_FILES),
            )

    @unittest.skipUnless(os.geteuid() == 0, "root-only ownership isolation proof")
    def test_runtime_user_reads_projection_but_not_release_or_brain_env(self):
        nobody = pwd.getpwnam("nobody")
        runtime_gid = 60000 if nobody.pw_gid != 60000 else 60001
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.chown(root, 0, runtime_gid)
            root.chmod(0o710)
            source = self._source(root, 0, 0)
            worker = source / "service" / "mime-parser-worker.js"
            worker.write_text("process.exit(0);\n", encoding="utf-8")
            worker.chmod(0o440)
            runtime = self._runtime_root(root, 0, runtime_gid)
            current = project_mail_runtime(source, runtime, runtime_gid, 0)
            updated_main = source / "service" / "main.js"
            updated_main.write_text("runtime:updated-main\n", encoding="utf-8")
            updated_main.chmod(0o440)
            current = project_mail_runtime(source, runtime, runtime_gid, 0)
            self.assertEqual(
                (current / "service" / "main.js").read_text(encoding="utf-8"),
                "runtime:updated-main\n",
            )
            self.assertEqual(list(runtime.glob(".old-*")), [])
            secrets = root / "etc-brain"
            secrets.mkdir(mode=0o750)
            environment = secrets / "brain.env"
            environment.write_text("SECRET=hidden\n", encoding="utf-8")
            environment.chmod(0o640)

            pid = os.fork()
            if pid == 0:
                try:
                    os.setgroups([])
                    os.setgid(nobody.pw_gid)
                    os.setuid(nobody.pw_uid)
                    (current / "service" / "mime-parser-worker.js").read_bytes()
                    os._exit(2)
                except PermissionError:
                    os._exit(0)
                except BaseException:
                    os._exit(3)
            _child, status = os.waitpid(pid, 0)
            self.assertTrue(os.WIFEXITED(status))
            self.assertEqual(os.WEXITSTATUS(status), 0)

            pid = os.fork()
            if pid == 0:
                try:
                    os.setgroups([runtime_gid])
                    os.setgid(nobody.pw_gid)
                    os.setuid(nobody.pw_uid)
                    (current / "service" / "main.js").read_bytes()
                    try:
                        list(root.iterdir())
                    except PermissionError:
                        pass
                    else:
                        os._exit(2)
                    for forbidden in (source / "service" / "main.js", environment):
                        try:
                            forbidden.read_bytes()
                        except PermissionError:
                            continue
                        os._exit(4)
                    os.chdir(current)
                    os.execve(
                        node,
                        [node, str(current / "service" / "mime-parser-worker.js")],
                        {"NODE_ENV": "production"},
                    )
                except BaseException:
                    os._exit(5)
            _child, status = os.waitpid(pid, 0)
            self.assertTrue(os.WIFEXITED(status))
            self.assertEqual(os.WEXITSTATUS(status), 0)


if __name__ == "__main__":
    unittest.main()
