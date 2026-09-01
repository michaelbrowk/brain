import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PilotJournal } from "./journal";

const temporaryDirectories: string[] = [];

async function temporaryJournal(): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brain-journal-"));
  temporaryDirectories.push(directory);
  return { directory, file: path.join(directory, "pilot.jsonl") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Notion pilot journal", () => {
  it("creates a 0600 chained journal and resumes its sequence", async () => {
    const { file } = await temporaryJournal();
    const first = await PilotJournal.open(file);
    const one = await first.append({
      type: "token_prepared",
      notionId: "1".repeat(32),
      reservationToken: "synthetic_token_0001",
    });
    const two = await first.append({
      type: "page_reserved",
      notionId: "1".repeat(32),
      pageId: "brain-synthetic",
    });
    await first.close();

    expect(one.seq).toBe(1);
    expect(two.prevHash).toBe(one.hash);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const resumed = await PilotJournal.open(file);
    expect(resumed.records).toHaveLength(2);
    expect(resumed.latest("page_reserved", "1".repeat(32))).toMatchObject({
      pageId: "brain-synthetic",
    });
    expect((await resumed.append({ type: "run_completed", pages: 1 })).seq).toBe(3);
    await resumed.close();
  });

  it("fails closed on tampering, truncation, and unsafe permissions", async () => {
    const { file } = await temporaryJournal();
    const journal = await PilotJournal.open(file);
    await journal.append({ type: "run_started", runId: "synthetic" });
    await journal.close();

    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, original.replace("synthetic", "tampered"));
    await expect(PilotJournal.open(file)).rejects.toThrow(/hash/);

    await fs.writeFile(file, original.slice(0, -1));
    await expect(PilotJournal.open(file)).rejects.toThrow(/truncated/);

    await fs.writeFile(file, original, { mode: 0o600 });
    await fs.chmod(file, 0o644);
    await expect(PilotJournal.open(file)).rejects.toThrow(/0600/);
  });

  it("never follows an existing journal symlink", async () => {
    const { directory, file } = await temporaryJournal();
    const target = path.join(directory, "private-target");
    await fs.writeFile(target, "private target bytes", { mode: 0o600 });
    await fs.symlink(target, file);

    let message = "";
    try {
      await PilotJournal.open(file);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/regular file/);
    expect(message).not.toContain(target);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "private target bytes",
    );
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an existing journal with another hard link", async () => {
    const { directory, file } = await temporaryJournal();
    const journal = await PilotJournal.open(file);
    await journal.close();
    await fs.link(file, path.join(directory, "journal-alias.jsonl"));

    await expect(PilotJournal.open(file)).rejects.toThrow(/multiple hard links/);
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a same-user pathname swap after opening the existing journal", async () => {
    const { directory, file } = await temporaryJournal();
    const seeded = await PilotJournal.open(file);
    await seeded.append({ type: "seeded" });
    await seeded.close();
    const target = path.join(directory, "private-target");
    const displaced = path.join(directory, "displaced-journal");
    await fs.writeFile(target, "private target bytes", { mode: 0o600 });

    const realOpen = fs.open.bind(fs);
    let swapped = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!swapped && String(args[0]) === file && typeof args[1] === "number") {
        swapped = true;
        await fs.rename(file, displaced);
        await fs.symlink(target, file);
      }
      return handle;
    });
    try {
      await expect(PilotJournal.open(file)).rejects.toThrow(/path changed/);
    } finally {
      open.mockRestore();
    }
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "private target bytes",
    );
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a same-user pathname swap after creating a new journal", async () => {
    const { directory, file } = await temporaryJournal();
    const displaced = path.join(directory, "displaced-new-journal");
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!swapped && String(args[0]) === file) {
        swapped = true;
        await fs.rename(file, displaced);
        await fs.writeFile(file, "replacement", { mode: 0o600 });
      }
      return handle;
    });
    try {
      await expect(PilotJournal.open(file)).rejects.toThrow(/path changed/);
    } finally {
      open.mockRestore();
    }
    await expect(fs.readFile(file, "utf8")).resolves.toBe("replacement");
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects note bodies, credentials, byte fields, and URLs recursively", async () => {
    const { file } = await temporaryJournal();
    const journal = await PilotJournal.open(file);
    await expect(
      journal.append({ type: "unsafe", nested: { markdown: "secret note" } }),
    ).rejects.toThrow(/forbidden field/);
    await expect(
      journal.append({ type: "unsafe", nested: { mcpToken: "secret" } }),
    ).rejects.toThrow(/forbidden field/);
    await expect(
      journal.append({ type: "unsafe", bytes: [1, 2, 3] }),
    ).rejects.toThrow(/forbidden field/);
    await expect(
      journal.append({ type: "unsafe", value: "https://example.test/signed" }),
    ).rejects.toThrow(/URLs/);
    await expect(
      journal.append({ type: "unsafe", value: undefined }),
    ).rejects.toThrow(/non-JSON/);
    await expect(
      journal.append({ type: "unsafe", value: Number.NaN }),
    ).rejects.toThrow(/non-finite/);
    expect(journal.records).toHaveLength(0);
    await journal.close();
  });

  it("holds a process-exclusive lock until close", async () => {
    const { file } = await temporaryJournal();
    const first = await PilotJournal.open(file);
    await expect(PilotJournal.open(file)).rejects.toThrow(/locked/);
    await first.close();
    const reopened = await PilotJournal.open(file);
    await reopened.close();
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never removes a successor lock after manual recovery replaces its directory", async () => {
    const { file } = await temporaryJournal();
    const lockPath = file + ".lock";
    const predecessor = await PilotJournal.open(file);

    // Simulate an operator recovering a lock while the predecessor is still
    // alive, then a successor acquiring the same journal immediately.
    await fs.rm(lockPath, { recursive: true, force: true });
    const successor = await PilotJournal.open(file);
    const successorMarkers = await fs.readdir(lockPath);
    expect(successorMarkers).toHaveLength(1);
    expect(successorMarkers[0]).toMatch(/^owner-[a-f0-9]{48}$/);

    await predecessor.close();
    await expect(fs.readdir(lockPath)).resolves.toEqual(successorMarkers);
    await expect(PilotJournal.open(file)).rejects.toThrow(/locked/);

    await successor.close();
    const afterSuccessor = await PilotJournal.open(file);
    await afterSuccessor.close();
  });

  it("advances the in-memory chain when a visible append reports fsync failure", async () => {
    const { file } = await temporaryJournal();
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!injected && String(args[0]) === file) {
        injected = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("synthetic journal fsync failure"),
        );
      }
      return handle;
    });
    const journal = await PilotJournal.open(file);
    try {
      await expect(
        journal.append({ type: "page_reserved", notionId: "1".repeat(32) }),
      ).rejects.toThrow("synthetic journal fsync failure");
      expect(journal.records).toHaveLength(1);
      await journal.append({ type: "run_stopped", code: "indeterminate_failure" });
      expect(journal.records.map((record) => record.seq)).toEqual([1, 2]);
    } finally {
      open.mockRestore();
      await journal.close();
    }

    const reopened = await PilotJournal.open(file);
    expect(reopened.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(reopened.latest("run_stopped")).toMatchObject({
      code: "indeterminate_failure",
    });
    await reopened.close();
  });

  it("never guesses that a stale-looking lock is safe to remove", async () => {
    const { file } = await temporaryJournal();
    const lockPath = file + ".lock";
    await fs.writeFile(lockPath, "999999999\n", { mode: 0o600 });

    await expect(PilotJournal.open(file)).rejects.toThrow(/locked/);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("999999999\n");
  });

  it("requires an effective-user-owned 0700 parent and rejects direct /tmp", async () => {
    const modeCase = await temporaryJournal();
    await fs.chmod(modeCase.directory, 0o750);
    await expect(PilotJournal.open(modeCase.file)).rejects.toThrow(/0700/);

    const ownerCase = await temporaryJournal();
    const readEffectiveUserId = process.geteuid;
    if (!readEffectiveUserId) throw new Error("POSIX effective uid is unavailable");
    const effectiveUserId = readEffectiveUserId.call(process);
    const getEffectiveUserId = vi
      .spyOn(process, "geteuid")
      .mockReturnValue(effectiveUserId + 1);
    try {
      await expect(PilotJournal.open(ownerCase.file)).rejects.toThrow(
        /owned by the effective user/,
      );
    } finally {
      getEffectiveUserId.mockRestore();
    }

    const directTmp = path.join(
      "/tmp",
      `brain-pilot-direct-${process.pid}-${Date.now()}.jsonl`,
    );
    await expect(PilotJournal.open(directTmp)).rejects.toThrow(
      /private|owned by the effective user|0700/,
    );
    await expect(fs.lstat(directTmp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(directTmp + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects journal paths inside repository or notes roots", async () => {
    await expect(
      PilotJournal.open(path.join(process.cwd(), "unsafe-pilot.jsonl")),
    ).rejects.toThrow(/outside the repository/);
    const { directory } = await temporaryJournal();
    const notes = path.join(directory, "notes");
    await expect(
      PilotJournal.open(path.join(notes, "pilot.jsonl"), {
        forbiddenRoots: [notes],
      }),
    ).rejects.toThrow(/outside the repository/);

    const linked = path.join(directory, "repo-link");
    await fs.symlink(process.cwd(), linked, "dir");
    await expect(
      PilotJournal.open(path.join(linked, "should-not-exist", "pilot.jsonl")),
    ).rejects.toThrow(/outside the repository/);
    await expect(
      fs.lstat(path.join(process.cwd(), "should-not-exist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the source repository even when process.cwd points elsewhere", async () => {
    const repositoryRoot = process.cwd();
    const file = path.join(
      repositoryRoot,
      ".synthetic-private-journal",
      "pilot.jsonl",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
    try {
      await expect(PilotJournal.open(file)).rejects.toThrow(
        /outside the repository/,
      );
    } finally {
      cwd.mockRestore();
    }
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(file + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a run's durable mutation ceiling without reserving it twice", async () => {
    const { file } = await temporaryJournal();
    const first = await PilotJournal.open(file);
    await first.activateRemoteRunCapacity("run-1", "f".repeat(64));
    await first.append({ type: "checkpoint", value: "synthetic" });
    await first.close();

    const resumed = await PilotJournal.open(file);
    await resumed.activateRemoteRunCapacity("run-1", "f".repeat(64));
    expect(
      resumed.records.filter(
        (record) => record.event.type === "capacity_reserved",
      ),
    ).toHaveLength(1);
    expect(() => resumed.assertRemoteMutationCapacity("normal")).not.toThrow();
    await resumed.close();
  });

  it("preserves cleanup headroom when normal mutation capacity is exhausted", async () => {
    const { file } = await temporaryJournal();
    const events = [
      {
        type: "capacity_reserved",
        runId: "run-1",
        fingerprint: "f".repeat(64),
        ceilingBytes: 2 * 1024 * 1024,
      },
      ...Array.from({ length: 400 }, (_, ordinal) => ({
        type: "padding",
        ordinal,
        value: "x".repeat(4096),
      })),
    ];
    const text = encodeSyntheticJournal(events);
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_550_000);
    expect(Buffer.byteLength(text)).toBeLessThan(2 * 1024 * 1024);
    await fs.writeFile(file, text, { mode: 0o600 });

    const journal = await PilotJournal.open(file);
    await journal.activateRemoteRunCapacity("run-1", "f".repeat(64));
    expect(() => journal.assertRemoteMutationCapacity("normal")).toThrow(
      /no safe capacity/,
    );
    expect(() => journal.assertRemoteMutationCapacity("cleanup")).not.toThrow();
    await journal.close();
  });

  it("refuses a new run ceiling at the exact hard-limit edge without appending", async () => {
    const { file } = await temporaryJournal();
    const text = encodeSyntheticJournal(
      Array.from({ length: 3_000 }, (_, ordinal) => ({
        type: "padding",
        ordinal,
        value: "x".repeat(4096),
      })),
    );
    const bytes = Buffer.byteLength(text);
    expect(bytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(bytes).toBeLessThan(16 * 1024 * 1024);
    await fs.writeFile(file, text, { mode: 0o600 });

    const journal = await PilotJournal.open(file);
    const before = journal.records.length;
    await expect(
      journal.activateRemoteRunCapacity("new-run", "a".repeat(64)),
    ).rejects.toMatchObject({ code: "journal_capacity" });
    expect(journal.records).toHaveLength(before);
    expect(
      journal.records.some(
        (record) => record.event.type === "capacity_reserved",
      ),
    ).toBe(false);
    await journal.close();
  });
});

function encodeSyntheticJournal(
  events: readonly Record<string, unknown>[],
): string {
  let prevHash = "0".repeat(64);
  return events
    .map((event, index) => {
      const core = { seq: index + 1, prevHash, event };
      const hash = createHash("sha256").update(stableJson(core)).digest("hex");
      prevHash = hash;
      return JSON.stringify({ ...core, hash });
    })
    .join("\n") + "\n";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => JSON.stringify(key) + ":" + stableJson(child))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
