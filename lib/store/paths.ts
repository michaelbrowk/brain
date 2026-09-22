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

/** A folder name that is not a page (attachments, task records, an app's own
 *  files, dotfiles, git). `app` joins the list because an app page holds its
 *  entry, its assets and its state in a folder beside its `index.md`, and the
 *  walk would otherwise descend into them looking for pages. See the
 *  exception in `Store.walk()` for the page somebody already called "App". */
export function isReservedDir(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "_attachments" ||
    name === "_tasks" ||
    name === "app" ||
    name === "node_modules"
  );
}
