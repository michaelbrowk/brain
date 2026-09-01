#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DENIED_PATHS, isDenied } from "./publication-denylist.mjs";
import { trackedFiles } from "./export-public.mjs";

// The archive is the tree that carries this file; the export never does,
// because the denylist denies it. So the same flag-free command is a drift
// audit here and a tracked-path check there.
export const ROLE_MARKER = ".publication-role";

export async function resolveMode(root, requested = "") {
  if (requested) return requested;
  const role = await readFile(path.join(root, ROLE_MARKER), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  // Anything but the archive's own word for itself reads as the public tree,
  // so a truncated or garbled marker fails loudly in the archive rather than
  // waving the export through.
  return role.trim() === "archive" ? "archive" : "public";
}

export async function forbiddenPaths(root) {
  return (await trackedFiles(root)).filter(isDenied);
}

// A denylist that names a path the tree no longer has is a denylist nobody has
// re-read. Every exact entry must still exist; prefixes are not audited because
// a directory may legitimately be empty between captures.
export async function auditDenylist(root) {
  const tracked = new Set(await trackedFiles(root));
  const missing = DENIED_PATHS.filter((entry) => !tracked.has(entry));
  return { checked: DENIED_PATHS.length, missing };
}

// The whole decision the CLI makes, as a function a test can drive without a
// subprocess. The drift audit is an archive-mode concern only: the denylist is
// maintained in the archive, and in an exported tree every denied path is
// absent by design, so auditing there would report the export as drift.
export async function runCheck({ root, mode = "" }) {
  const resolved = await resolveMode(root, mode);
  if (resolved !== "archive" && resolved !== "public") {
    return { code: 64, error: `unknown mode: ${resolved}` };
  }
  if (resolved === "archive") {
    const audit = await auditDenylist(root);
    if (audit.missing.length > 0) {
      return { code: 1, error: `the denylist names paths this tree no longer has:\n${audit.missing.join("\n")}` };
    }
  }
  if (resolved === "public") {
    const found = await forbiddenPaths(root);
    if (found.length > 0) {
      return { code: 1, error: `the public tree tracks denied paths:\n${found.join("\n")}` };
    }
  }
  return { code: 0, message: `denylist ok (${DENIED_PATHS.length} exact paths, mode ${resolved})` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.find((argument) => argument.startsWith("--mode="));
  const result = await runCheck({ root: process.cwd(), mode: flag?.slice("--mode=".length) });
  if (result.code !== 0) {
    console.error(result.error);
    process.exit(result.code);
  }
  console.log(result.message);
}
