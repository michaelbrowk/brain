import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_STAGING_DIR } from "../apps/model";
import { scheduleDirtyCommit } from "./git";
import { Store } from "./store";

/** The smaller findings of the PR 1 review, each with the guard it asked
 *  for: what the trash list says about an app page, and what the notes
 *  repository is allowed to carry. */

let root: string;
let store: Store;

const ENTRY = "<!doctype html><p>hi</p>";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-notes-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("an app page in the Trash", () => {
  it("is named as one on the trash list", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    const plain = await store.createPage(null, "Spanish");
    await store.deletePage(meta.id);
    await store.deletePage(plain.id);

    const trash = store.trashList();
    expect(trash.find((item) => item.id === meta.id)?.kind).toBe("app");
    expect(trash.find((item) => item.id === plain.id)?.kind).toBeUndefined();
  });
});

describe("the notes repository", () => {
  it("never commits an app's staging folder", async () => {
    // `scheduleCommit` runs `git add -A` on a debounce and outside the store
    // lock, so a commit can fire while a rewrite has `.app-next/` on disk.
    // Committing a half-written app into somebody's notes history is noise
    // they cannot read and did not ask for.
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    const dir = store.resolve(meta.id);
    await mkdir(path.join(dir, APP_STAGING_DIR), { recursive: true });
    await writeFile(path.join(dir, APP_STAGING_DIR, "index.html"), "half");
    await mkdir(path.join(dir, `${APP_STAGING_DIR}-old`), { recursive: true });
    await writeFile(path.join(dir, `${APP_STAGING_DIR}-old`, "index.html"), "old");

    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["config", "user.name", "Brain Test"]);
    expect(await scheduleDirtyCommit(root)).toBe(true);

    const tracked = await trackedPaths(root);
    expect(tracked.some((file) => file.includes(APP_STAGING_DIR))).toBe(false);
    // and the app's real files are there
    expect(tracked.some((file) => file.endsWith("app/index.html"))).toBe(true);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", args, { cwd });
  return stdout;
}

async function trackedPaths(notesRoot: string): Promise<string[]> {
  return (await git(notesRoot, ["ls-files"])).split("\n").filter(Boolean);
}
