import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Create the notes root if it is missing, then prove this process can write
 *  in it, so a root the process cannot write fails at boot with the cure
 *  spelled out rather than at the first save with a bare EACCES. A bind
 *  mount can arrive owned by root whatever the host folder says (colima's
 *  virtiofs does this, and Compose creates a missing bind source as root on
 *  Linux), while `mkdir -p` on an existing folder is a no-op that proves
 *  nothing.
 *
 *  The probe is a `mkdir` and `rmdir` of an empty dot-directory rather than
 *  `fs.access(W_OK)`. `access` predicts from the mode bits the mount reports,
 *  the create asks the mount to do what the first save will do, so its answer
 *  cannot disagree with that save. An empty directory is safe on a root that
 *  is a Git repository: `git add -A` never records one, so a snapshot that
 *  raced the probe could not commit it, and it is gone before the store reads
 *  the tree or arms its snapshot debounce. */
export async function ensureWritableNotesRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const probe = path.join(
    root,
    `.brain-writable-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    await fs.mkdir(probe, { recursive: false });
  } catch (error) {
    throw new Error(await describeUnwritableRoot(root, error), { cause: error });
  }
  try {
    await fs.rmdir(probe);
  } catch (error) {
    // The write succeeded — that is the question this probe asks — so a
    // failed cleanup is not an unwritable root and must not be reported as
    // one. The stray dot-directory is harmless: the tree walk skips
    // dot-entries and git never records an empty directory. Say where it is.
    console.warn(
      `[brain/store] could not remove the writability probe ${probe}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function describeUnwritableRoot(
  root: string,
  error: unknown,
): Promise<string> {
  const { code, syscall } = error as NodeJS.ErrnoException;
  const uid = process.getuid?.() ?? "unknown";
  const gid = process.getgid?.() ?? "unknown";
  const stat = await fs.stat(root).catch(() => null);
  const owner = stat
    ? `owned by uid ${stat.uid} gid ${stat.gid} with mode ${(stat.mode & 0o7777)
        .toString(8)
        .padStart(4, "0")}`
    : "of unknown ownership";
  return (
    `Brain cannot write to NOTES_ROOT ${root} (${code ?? "error"} from ` +
    `${syscall ?? "the probe"}). The process runs as uid ${uid} gid ${gid}, ` +
    `while the folder is ${owner}. Either give the folder to that user, ` +
    `which for a bind mount into a container means chown ${uid}:${gid} ` +
    `<host folder> on the host, or mount a Docker named volume at ${root} ` +
    `instead of a bind mount.`
  );
}
