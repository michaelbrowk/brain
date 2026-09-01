#!/usr/bin/env python3
"""Project a built Mail artifact for the exact-artifact smoke test."""

from __future__ import annotations

import os
from pathlib import Path
import stat
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops"))

from project_mail_runtime import project_mail_runtime  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: project-mail-runtime-for-smoke.py SOURCE RUNTIME_ROOT", file=sys.stderr)
        return 2
    source = Path(sys.argv[1]).resolve(strict=True)
    runtime_root = Path(sys.argv[2]).resolve(strict=True)
    mode = stat.S_IMODE(runtime_root.stat().st_mode)
    current = project_mail_runtime(
        source,
        runtime_root,
        os.getegid(),
        os.geteuid(),
        mode,
        seal_before_swap=False,
    )
    print(current)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
