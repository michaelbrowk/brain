// The Docker credentials volume starts empty. Publish one durable key before
// Mail opens its state; a restart must never rotate the key that wraps it.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export async function ensureMailWrappingKey(stateDirectory, credentialsDirectory) {
  for (const directory of [stateDirectory, credentialsDirectory]) {
    if (!path.isAbsolute(directory)) throw new Error("mail directories must be absolute");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
      throw new Error("mail directory must be a private real directory");
    }
  }
  const keyPath = path.join(credentialsDirectory, "account-wrapping-key");
  const unsafeKey = () => new Error("existing mail wrapping key is unsafe; restore the original key");
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const syncCredentialsDirectory = async () => {
    const directory = await open(credentialsDirectory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const recoverStagedLinks = async (key, info) => {
    // A kill after link(temp, key) but before unlink(temp) leaves one extra
    // name for the SAME durable inode. Recover only our exact staging names
    // inside this owner-only directory; an unexplained hardlink stays fatal.
    const staged = [];
    for (const name of await readdir(credentialsDirectory)) {
      if (!/^\.account-wrapping-key\.[1-9]\d*\.[a-f0-9]{24}$/.test(name)) continue;
      const candidate = path.join(credentialsDirectory, name);
      const metadata = await lstat(candidate).catch((error) => {
        if (error.code === "ENOENT") return null; // another bootstrap finished
        throw error;
      });
      if (metadata?.isFile() && sameFile(info, metadata)) staged.push(candidate);
    }
    const current = await key.stat();
    if (current.nlink === 1) return;
    if (staged.length !== current.nlink - 1) throw unsafeKey();
    // Recheck every alias before removing any. Do not follow symlinks or
    // remove unrelated temporary keys from a concurrent first startup.
    for (const candidate of staged) {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || !sameFile(info, metadata)) throw unsafeKey();
    }
    for (const candidate of staged) {
      await unlink(candidate).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    await syncCredentialsDirectory();
  };
  const validateKey = async () => {
    const key = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!key) return false;
    try {
      const info = await key.stat();
      if (!info.isFile() || info.size !== 32 ||
          (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
        throw unsafeKey();
      }
      if (info.nlink > 1) await recoverStagedLinks(key, info);
      if ((await key.stat()).nlink !== 1) throw unsafeKey();
      return true;
    } finally { await key.close(); }
  };
  if (await validateKey()) return;
  // Fail closed for ANY existing state, not only today's credential table.
  // This also protects legacy state and unknown future formats. An instance
  // that lost its credentials volume needs its original key restored.
  if ((await readdir(stateDirectory)).length !== 0) {
    throw new Error("mail state exists but its wrapping key is missing; restore the original credentials volume");
  }
  const temporary = path.join(credentialsDirectory, `.account-wrapping-key.${process.pid}.${randomBytes(12).toString("hex")}`);
  const key = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const bytes = randomBytes(32);
  try {
    await key.writeFile(bytes);
    await key.sync();
    // Publish complete bytes atomically without replacing a race winner.
    try { await link(temporary, keyPath); } catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    bytes.fill(0);
    await key.close();
    // A concurrent bootstrap may already have recovered this published alias.
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  await syncCredentialsDirectory();
  if (!await validateKey()) throw unsafeKey();
}
