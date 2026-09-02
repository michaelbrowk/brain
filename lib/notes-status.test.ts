import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { readNotesStatus } from "./notes-status";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), "brain-notes-status-"));
  roots.push(r);
  mocks.getStore.mockResolvedValue({ root: r });
  return r;
}

describe("readNotesStatus", () => {
  it("names the root and says there is no repository yet", async () => {
    const r = await root();
    expect(await readNotesStatus()).toEqual({
      apiVersion: 1,
      root: r,
      repository: false,
      head: null,
      commitDelaySeconds: 4,
    });
  });

  it("reports HEAD once a commit exists", async () => {
    const r = await root();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd: r, encoding: "utf8" }).trim();
    git("init", "-q");
    await fs.writeFile(path.join(r, "index.md"), "# a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const status = await readNotesStatus();
    expect(status.repository).toBe(true);
    expect(status.head?.hash).toBe(git("rev-parse", "HEAD"));
  });
});
