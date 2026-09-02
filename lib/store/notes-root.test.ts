import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store";
import { ensureWritableNotesRoot } from "./notes-root";

// uid 0 bypasses mode bits, so a 0500 folder refuses root nothing and the
// refusal cases below would fail for the wrong reason. They are skipped there.
const runningAsRoot = process.geteuid?.() === 0;

async function unwritableRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(root, 0o500);
  return root;
}

async function failure(work: Promise<unknown>): Promise<Error> {
  return work.then(
    () => {
      throw new Error("expected the notes root to be refused");
    },
    (error: unknown) => error as Error,
  );
}

describe("ensureWritableNotesRoot", () => {
  it("accepts a writable root and leaves nothing behind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-root-ok-"));

    await expect(ensureWritableNotesRoot(root)).resolves.toBeUndefined();

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("creates a missing root before probing it", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "brain-root-new-"));
    const root = path.join(parent, "nested", "notes");

    await expect(ensureWritableNotesRoot(root)).resolves.toBeUndefined();

    expect((await fs.stat(root)).isDirectory()).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.skipIf(runningAsRoot)(
    "refuses a root the process cannot write and names the cure",
    async () => {
      const root = await unwritableRoot("brain-root-ro-");
      try {
        const error = await failure(ensureWritableNotesRoot(root));

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(root);
        expect(error.message).toContain(`uid ${process.getuid?.()}`);
        expect(error.message).toContain("chown");
        expect(await fs.readdir(root)).toEqual([]);
      } finally {
        await fs.chmod(root, 0o700);
      }
    },
  );
});

describe("Store.init on a notes root it cannot write", () => {
  it.skipIf(runningAsRoot)(
    "fails closed at boot instead of at the first save",
    async () => {
      const root = await unwritableRoot("brain-store-ro-");
      try {
        const error = await failure(new Store(root).init());

        expect(error.message).toContain(root);
        expect(error.message).toContain("chown");
      } finally {
        await fs.chmod(root, 0o700);
      }
    },
  );
});

it("treats a probe that was created but could not be removed as writable, and says where it is", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-root-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rmdir = vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error("EBUSY: simulated"));
  try {
    await expect(ensureWritableNotesRoot(root)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(".brain-writable-");
    expect(warn.mock.calls[0][0]).toContain("EBUSY: simulated");
  } finally {
    rmdir.mockRestore();
    warn.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
