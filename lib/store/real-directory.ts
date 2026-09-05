import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { syncDirectory } from "./atomic";

/** The (dev, ino) pair of a directory opened without following symlinks.
 *  Taken before a write into that directory and checked again after it, so
 *  a directory swapped for a symlink under the write is noticed instead of
 *  written through. Shared by the attachment bytes and the attachment scope
 *  index, which is a security control and gets the same treatment. */
export interface DirectoryIdentity {
  dev: number;
  ino: number;
}

/** Create the directory if it is missing, then prove it is a real one. */
export async function ensureRealDirectory(
  directory: string,
): Promise<DirectoryIdentity> {
  try {
    await fs.mkdir(directory);
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return assertRealDirectory(directory);
}

/** Prove `directory` is a real directory, not a symlink, and when `expected`
 *  is given, still the same directory it was. */
export async function assertRealDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("attachment store must be a real directory");
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(directory);
    const identity = { dev: opened.dev, ino: opened.ino };
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (expected &&
        (expected.dev !== identity.dev || expected.ino !== identity.ino))
    ) {
      throw new Error("attachment store directory identity changed");
    }
    return identity;
  } finally {
    await handle.close();
  }
}
