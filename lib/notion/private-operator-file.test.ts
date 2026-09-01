import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPrivateOperatorText,
  writeNewPrivateOperatorText,
} from "./private-operator-file";

const temporaryDirectories: string[] = [];

async function privateDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await fs.chmod(directory, 0o700);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("private operator files", () => {
  it("creates and reads owner-only text with an explicit byte ceiling", async () => {
    const directory = await privateDirectory("brain-operator-happy-");
    const file = path.join(directory, "state.json");
    const text = '{"version":1,"scope":"synthetic"}\n';

    await writeNewPrivateOperatorText(file, text, {
      label: "operator state",
      maxBytes: 1024,
    });

    await expect(
      readPrivateOperatorText(file, {
        label: "operator state",
        maxBytes: 1024,
      }),
    ).resolves.toBe(text);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("requires an absolute path and an absolute forbidden root", async () => {
    await expect(
      readPrivateOperatorText("relative.json", { maxBytes: 100 }),
    ).rejects.toThrow(/absolute/);
    await expect(
      writeNewPrivateOperatorText("relative.json", "{}", { maxBytes: 100 }),
    ).rejects.toThrow(/absolute/);

    const directory = await privateDirectory("brain-operator-roots-");
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "{}", { mode: 0o600 });
    await expect(
      readPrivateOperatorText(file, {
        maxBytes: 100,
        forbiddenRoots: ["relative-export"],
      }),
    ).rejects.toThrow(/forbidden roots must be absolute/);
  });

  it("rejects wrong parent and file modes", async () => {
    const publicParent = await privateDirectory("brain-operator-parent-");
    await fs.chmod(publicParent, 0o750);
    const absent = path.join(publicParent, "state.json");
    await expect(
      writeNewPrivateOperatorText(absent, "{}", { maxBytes: 100 }),
    ).rejects.toThrow(/0700/);
    await expect(fs.lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });

    const directory = await privateDirectory("brain-operator-mode-");
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "{}", { mode: 0o600 });
    await fs.chmod(file, 0o640);
    await expect(
      readPrivateOperatorText(file, { maxBytes: 100 }),
    ).rejects.toThrow(/0600/);
  });

  it("rejects symlinks without exposing or changing their target", async () => {
    const directory = await privateDirectory("brain-operator-link-");
    const target = path.join(directory, "target.json");
    const linked = path.join(directory, "linked.json");
    await fs.writeFile(target, "private target bytes", { mode: 0o600 });
    await fs.symlink(target, linked);

    let readMessage = "";
    try {
      await readPrivateOperatorText(linked, { maxBytes: 1024 });
    } catch (error) {
      readMessage = error instanceof Error ? error.message : String(error);
    }
    expect(readMessage).toMatch(/regular file|symlink/);
    expect(readMessage).not.toContain(target);

    await expect(
      writeNewPrivateOperatorText(linked, "replacement", { maxBytes: 1024 }),
    ).rejects.toThrow(/already exists|symlink/);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "private target bytes",
    );
  });

  it("refuses overwrite and leaves the existing bytes intact", async () => {
    const directory = await privateDirectory("brain-operator-overwrite-");
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "reviewed", { mode: 0o600 });

    await expect(
      writeNewPrivateOperatorText(file, "new", { maxBytes: 100 }),
    ).rejects.toThrow(/already exists/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("reviewed");
  });

  it("rejects paths inside an explicitly forbidden export tree", async () => {
    const directory = await privateDirectory("brain-operator-export-");
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "{}", { mode: 0o600 });

    await expect(
      readPrivateOperatorText(file, {
        maxBytes: 100,
        forbiddenRoots: [directory],
      }),
    ).rejects.toThrow(/outside repository, notes, and export roots/);
  });

  it("rejects the source repository even when process.cwd points elsewhere", async () => {
    const repositoryRoot = process.cwd();
    const file = path.join(repositoryRoot, ".synthetic-private-operator-state.json");

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
    try {
      await expect(
        readPrivateOperatorText(file, { maxBytes: 100 }),
      ).rejects.toThrow(/outside repository, notes, and export roots/);
    } finally {
      cwd.mockRestore();
    }
  });

  it("fails closed when the pathname inode is swapped after opening", async () => {
    const directory = await privateDirectory("brain-operator-swap-");
    const file = path.join(directory, "state.json");
    const displaced = path.join(directory, "displaced.json");
    await fs.writeFile(file, "reviewed", { mode: 0o600 });

    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!swapped && String(args[0]) === file) {
        swapped = true;
        await fs.rename(file, displaced);
        await fs.writeFile(file, "replacement", { mode: 0o600 });
      }
      return handle;
    });

    await expect(
      readPrivateOperatorText(file, { maxBytes: 100 }),
    ).rejects.toThrow(/changed while opening|changed while reading/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("replacement");
  });

  it("enforces the byte ceiling for both reads and writes", async () => {
    const directory = await privateDirectory("brain-operator-limit-");
    const existing = path.join(directory, "existing.txt");
    const created = path.join(directory, "created.txt");
    await fs.writeFile(existing, "12345", { mode: 0o600 });

    await expect(
      readPrivateOperatorText(existing, { maxBytes: 4 }),
    ).rejects.toThrow(/byte limit/);
    await expect(
      writeNewPrivateOperatorText(created, "12345", { maxBytes: 4 }),
    ).rejects.toThrow(/byte limit/);
    await expect(fs.lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
