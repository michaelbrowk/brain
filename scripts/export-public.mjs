#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DENIED_PATHS, DENIED_PREFIXES, isDenied } from "./publication-denylist.mjs";

const execFileAsync = promisify(execFile);

// What `git status --porcelain` reports, or "" for a clean tree.
export async function workingTreeChanges(root) {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.trim();
}

// The guard belongs on the export, not only on the wrapper that calls it: at
// the cutover `pnpm export:public` is what produces the initial commit of the
// public repository, and there is no second chance at what that commit
// contains. The two halves come from different places: the file LIST is
// `git ls-files`, the index, while the BYTES are copied off the working tree.
// A dirty tree therefore exports a hybrid of the two — an unstaged edit to a
// tracked file travels, and a staged-then-deleted file fails the copy — which
// is something neither the working tree nor any commit ever was.
export async function assertExportableTree(root, { allowDirty = false } = {}) {
  if (allowDirty) return;
  const dirty = await workingTreeChanges(root);
  if (dirty === "") return;
  throw new Error(
    [
      "refusing to export a dirty working tree:",
      dirty,
      "",
      "The export reads the git index, not HEAD, so what this would produce is",
      "neither your working tree nor any commit. Commit or stash first.",
      "--allow-dirty exists for iterating and is never right for the cutover.",
    ].join("\n"),
  );
}

export async function trackedFiles(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).sort();
}

export function partition(files) {
  const kept = [];
  const denied = [];
  for (const file of files) (isDenied(file) ? denied : kept).push(file);
  return { kept, denied };
}

// Every file under `directory`, as directory-relative paths with "/" separators
// so they compare directly against the repo-relative paths git reports.
export async function walkFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path.join(directory, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

// The contract the spec states: a denied path that survived the copy is a
// failed export, not a warning. The check reads the destination tree itself and
// re-derives denial from DENIED_PATHS and DENIED_PREFIXES, so a bug in isDenied
// cannot hide a file from the verification that isDenied's own output produced.
// The second half — the walked set must equal `kept` exactly — catches what no
// denylist logic can see: a copy that brought something extra, or dropped one.
export async function verifyExport({ destination, kept }) {
  const present = await walkFiles(destination);

  const survivors = present.filter(
    (file) => DENIED_PATHS.includes(file) || DENIED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  if (survivors.length > 0) {
    throw new Error(`export carries denied paths:\n${survivors.join("\n")}`);
  }

  const keptSet = new Set(kept);
  const presentSet = new Set(present);
  const extra = present.filter((file) => !keptSet.has(file));
  const missing = kept.filter((file) => !presentSet.has(file));
  if (extra.length > 0 || missing.length > 0) {
    const detail = [
      extra.length > 0 ? `unexpected in the destination:\n${extra.join("\n")}` : "",
      missing.length > 0 ? `missing from the destination:\n${missing.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`export does not match the kept set:\n${detail}`);
  }

  return present;
}

export async function exportPublic({ root, destination }) {
  const existing = await readdir(destination).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length > 0) throw new Error(`destination is not empty: ${destination}`);

  const { kept, denied } = partition(await trackedFiles(root));
  for (const file of kept) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target);
  }

  await verifyExport({ destination, kept });
  return { kept: kept.length, denied: denied.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const usage = "usage: node scripts/export-public.mjs [--allow-dirty] <destination>";
  let allowDirty = false;
  let destination;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--allow-dirty") allowDirty = true;
    else if (!argument.startsWith("-") && destination === undefined) destination = argument;
    else {
      console.error(usage);
      process.exit(64);
    }
  }
  if (!destination) {
    console.error(usage);
    process.exit(64);
  }
  const root = process.cwd();
  try {
    await assertExportableTree(root, { allowDirty });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (allowDirty) {
    console.warn("--allow-dirty: exporting the index of a dirty tree, which is never right for the cutover");
  }
  const result = await exportPublic({ root, destination: path.resolve(destination) });
  console.log(`exported ${result.kept} files, withheld ${result.denied}`);
}
