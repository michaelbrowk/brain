import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Persist directory-entry changes (create, rename, unlink) across a crash. */
export async function syncDirectory(dir: string): Promise<void> {
  const directory = await fs.open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Write a file atomically: temp file in the same dir → fsync → rename over.
 *  A crash mid-write never leaves a torn note. */
export async function atomicWrite(
  file: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const fh = await fs.open(tmp, "w");
    try {
      if (typeof data === "string") await fh.writeFile(data, "utf8");
      else await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    // fsyncing the file protects its bytes; fsyncing the directory protects
    // the rename itself so an acknowledged save survives a kernel/power crash.
    await syncDirectory(dir);
  } catch (error) {
    // Best effort: a failed write/rename must not accumulate temp files in the
    // canonical notes tree. Ignore cleanup failure and preserve the root cause.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    // The rename may already have installed the complete target and only the
    // directory fsync failed. Verify the exact postcondition and retry that
    // fsync before reporting failure; callers must not create a duplicate after
    // an operation that is already visible on disk.
    try {
      const current = await fs.readFile(file);
      const expected =
        typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (current.equals(expected)) {
        await syncDirectory(dir);
        return;
      }
    } catch {
      // Preserve the original write/sync failure below.
    }
    throw error;
  }
}

/** Content hash → rev token for optimistic concurrency. */
export function hashRev(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 12);
}
