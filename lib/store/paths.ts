import path from "node:path";

/** kebab-case slug for a folder name from a title. Keeps unicode letters. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "untitled";
}

/** Ensure `abs` stays inside `root` (path-jail against traversal). */
export function assertInRoot(root: string, abs: string): string {
  const r = path.resolve(root);
  const p = path.resolve(abs);
  if (p !== r && !p.startsWith(r + path.sep)) {
    throw new Error(`path escapes notes root: ${abs}`);
  }
  return p;
}

/** A folder name that is not a page (attachments, dotfiles, git). */
export function isReservedDir(name: string): boolean {
  return (
    name.startsWith(".") || name === "_attachments" || name === "node_modules"
  );
}
