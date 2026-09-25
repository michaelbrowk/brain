import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_ACTIVITY_FILE,
  MCP_ACTIVITY_MAX_FILE_BYTES,
  MCP_ACTIVITY_MAX_LINE_BYTES,
  MCP_ACTIVITY_MAX_LINES,
  appendMcpActivity,
  clearMcpActivity,
  mcpActivityCacheState,
  mcpStateDirectory,
  readMcpActivity,
} from "./activity-log";
import {
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications/store";

const ACCOUNT = "account-a00000000000000000000000000000000";

let root: string;
/** The centre's own directory. A mutation writes two files now, and a test
 *  that redirected only the first would leave its rows in the bell a
 *  developer's own `pnpm dev` reads. */
let centre: string;

beforeEach(async () => {
  // A fixed path collides across concurrent vitest processes (another
  // worker's leftovers show up as this test's data) and, now that a
  // directory's line count and byte total are cached in module state keyed
  // by this path, a reused literal would also carry a stale count from the
  // previous test in this same file into the next one.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-activity-test-"));
  centre = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-centre-test-"));
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
  vi.stubEnv("BRAIN_NOTIFICATIONS_STATE_DIR", centre);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(centre, { recursive: true, force: true });
});

describe("the MCP activity log", () => {
  it("re-exports the state directory so a caller has one import", () => {
    expect(mcpStateDirectory()).toBe(root);
  });

  it("appends one line per call and reads the newest first", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      operationId: "send-alpha",
      outcome: "ok",
    });
    await appendMcpActivity({
      at: "2026-09-14T09:00:01.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: "thread-alpha",
      outcome: "ok",
    });
    const entries = await readMcpActivity(50);
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("update_mail_thread");
    expect(entries[0].threadId).toBe("thread-alpha");
    expect(entries[1].operationId).toBe("send-alpha");
  });

  it("round-trips which mutation ran, bounded at 64 characters", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: "thread-alpha",
      change: "starred",
      outcome: "ok",
    });
    await appendMcpActivity({
      at: "2026-09-14T09:00:01.000Z",
      client: "Claude",
      tool: "update_task",
      task: "task-alpha",
      change: "c".repeat(80),
      outcome: "ok",
    });
    const entries = await readMcpActivity(50);
    expect(entries[1].change).toBe("starred");
    expect(entries[0].change).toHaveLength(64);
  });

  it("answers nothing before anything has been written", async () => {
    expect(await readMcpActivity(50)).toEqual([]);
  });

  /** A crash mid-append leaves a line with no closing newline, and the next
   *  process counts the file back. The count added a newline to every line it
   *  saw and dropped the bytes of the lines it could not parse, so the cached
   *  total and the file on disk disagreed and the byte cap tripped at the
   *  wrong moment. The count is the file's own size. */
  it("counts a torn tail as the bytes the file actually holds", async () => {
    const file = path.join(root, MCP_ACTIVITY_FILE);
    const whole = (at: string) =>
      JSON.stringify({ at, client: "Claude", tool: "search", outcome: "ok" });
    await fs.writeFile(
      file,
      `${whole("2026-09-14T09:00:00.000Z")}\n` +
        `${whole("2026-09-14T09:00:01.000Z")}\n` +
        `{"at":"2026-09-14T09:00:02.0`,
      "utf8",
    );

    // The first append is the one that counts the file back.
    await appendMcpActivity({
      at: "2026-09-14T09:00:03.000Z",
      client: "Claude",
      tool: "search",
      outcome: "ok",
    });
    expect(mcpActivityCacheState(root)?.bytes).toBe((await fs.stat(file)).size);

    // The second runs on the cached count alone, which has to stay true.
    await appendMcpActivity({
      at: "2026-09-14T09:00:04.000Z",
      client: "Claude",
      tool: "search",
      outcome: "ok",
    });
    expect(mcpActivityCacheState(root)?.bytes).toBe((await fs.stat(file)).size);
  });

  it(
    "drops the oldest line at the cap and never grows past it",
    async () => {
      for (let i = 0; i < MCP_ACTIVITY_MAX_LINES + 10; i += 1) {
        await appendMcpActivity({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task: `task-${i}`,
          outcome: "ok",
        });
      }
      const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
      expect(raw.trimEnd().split("\n")).toHaveLength(MCP_ACTIVITY_MAX_LINES);
      const entries = await readMcpActivity(MCP_ACTIVITY_MAX_LINES);
      expect(entries.at(-1)?.task).toBe("task-10");
    },
    // 2010 real appends: cheap alone (the O(1) cache keeps each one a single
    // O_APPEND write), but this file now runs several such tests, and a
    // sibling test file's own heavy loop can starve this one's event loop
    // under a full parallel run. The default 5000ms has flaked here before.
    15_000,
  );

  it("reads no more than the limit asked for", async () => {
    for (const task of ["task-alpha", "task-beta", "task-gamma"]) {
      await appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "get_task",
        task,
        outcome: "ok",
      });
    }
    const entries = await readMcpActivity(2);
    expect(entries.map((entry) => entry.task)).toEqual(["task-gamma", "task-beta"]);
  });

  it("strips an address out of a refusal reason", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      outcome: "refused mary@example.test is not an address",
    });
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).not.toContain("@");
    expect(entry.outcome).toBe("refused maryexample.test is not an address");
  });

  it("bounds an outcome that carried a whole message into it", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      outcome: "refused ".concat("a".repeat(400)),
    });
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toHaveLength(120);
  });

  it("keeps no field a subject, an address or a title could enter through", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      outcome: "ok",
      // @ts-expect-error the entry shape is the redaction: there is no such field
      subject: "the quarterly numbers",
    });
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    expect(raw).not.toContain("quarterly");
  });

  it("writes the file under 0600 in a 0700 directory", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, MCP_ACTIVITY_FILE))).mode & 0o777).toBe(0o600);
  });

  it("chmods the file on the ordinary append path", async () => {
    const chmod = vi.spyOn(fs, "chmod");
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    expect(chmod).toHaveBeenCalledWith(path.join(root, MCP_ACTIVITY_FILE), 0o600);
  });

  it("chmods the file again after a trim", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const seeded =
      Array.from({ length: MCP_ACTIVITY_MAX_LINES }, (_, i) =>
        JSON.stringify({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task: `task-${i}`,
          outcome: "ok",
        }),
      ).join("\n") + "\n";
    await fs.writeFile(path.join(root, MCP_ACTIVITY_FILE), seeded, { mode: 0o600 });

    const chmod = vi.spyOn(fs, "chmod");
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-over",
      outcome: "ok",
    });

    expect(chmod).toHaveBeenCalledWith(path.join(root, MCP_ACTIVITY_FILE), 0o600);
  });

  it("survives a corrupt line rather than losing the file", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, MCP_ACTIVITY_FILE), "{not json\n", { mode: 0o600 });
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    expect(await readMcpActivity(50)).toHaveLength(1);
  });

  it("does not let a corrupt line take one of the cap's slots", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const seeded =
      Array.from({ length: MCP_ACTIVITY_MAX_LINES - 1 }, (_, i) =>
        JSON.stringify({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task: `task-${i}`,
          outcome: "ok",
        }),
      ).join("\n") + "\n";
    await fs.writeFile(path.join(root, MCP_ACTIVITY_FILE), seeded, { mode: 0o600 });
    await fs.appendFile(path.join(root, MCP_ACTIVITY_FILE), "{not json\n", "utf8");

    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "boundary-task",
      outcome: "ok",
    });

    const entries = await readMcpActivity(MCP_ACTIVITY_MAX_LINES);
    expect(entries).toHaveLength(MCP_ACTIVITY_MAX_LINES);
    expect(entries[0].task).toBe("boundary-task");
    expect(entries.map((entry) => entry.task)).toContain("task-0");
  });

  it("clears to nothing and stays readable", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    await clearMcpActivity();
    expect(await readMcpActivity(50)).toEqual([]);
  });

  it("keeps concurrent appends from losing a line", async () => {
    await Promise.all(
      ["task-alpha", "task-beta", "task-gamma", "task-delta"].map((task) =>
        appendMcpActivity({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task,
          outcome: "ok",
        }),
      ),
    );
    expect(await readMcpActivity(50)).toHaveLength(4);
  });

  it("truncates an oversized field with a marker instead of spending the log's budget on it", async () => {
    // A caller that skipped its own id validation, or one that never had
    // any, is the case this line exists for: the field is cut and marked,
    // never carried through whole and never dropped.
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: "a".repeat(200_000),
      threadId: "thread-alpha",
      outcome: "ok",
    });
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    const [line] = raw.trimEnd().split("\n");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1000);
    const [entry] = await readMcpActivity(1);
    expect(entry.accountId?.length).toBeLessThan(300);
    expect(entry.accountId?.endsWith("...(cut)")).toBe(true);
  });

  it("writes a legal call's line comfortably under the per-line byte cap", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: "thread-alpha",
      change: "starred",
      outcome: "ok",
    });
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    const [line] = raw.trimEnd().split("\n");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(MCP_ACTIVITY_MAX_LINE_BYTES);
  });

  it("reads the whole file only when a stat says it changed", async () => {
    // The cost this cache exists to remove, pinned by counting reads rather
    // than by timing one: the old code read and re-parsed the whole file on
    // every append, which a clock on a fast local disk does not separate
    // from a single O_APPEND write. A read is either made or it is not.
    const readFile = vi.spyOn(fs, "readFile");
    const write = (task: string) =>
      appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "get_task",
        task,
        outcome: "ok",
      });
    try {
      await write("task-0");
      // One read on the first touch, to count what was already there.
      expect(readFile).toHaveBeenCalledTimes(1);

      readFile.mockClear();
      for (let i = 1; i < 50; i += 1) await write(`task-${i}`);
      expect(readFile).not.toHaveBeenCalled();

      // A line this process did not write moves the file's size, and the
      // next append's stat is what notices. It costs one read, once.
      await fs.appendFile(
        path.join(root, MCP_ACTIVITY_FILE),
        JSON.stringify({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task: "task-sibling",
          outcome: "ok",
        }) + "\n",
        "utf8",
      );
      readFile.mockClear();
      await write("task-after");
      expect(readFile).toHaveBeenCalledTimes(1);

      readFile.mockClear();
      await write("task-later");
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it(
    "trims at the cap after a second process appended to the same file",
    async () => {
      // Two OS processes on one state directory is the case the cached count
      // used to sail past: neither ever saw the other's lines, so neither
      // reached the cap and the file grew without a bound. The child below
      // writes the way an append does, through the same file, and this
      // process has a warm cache before it runs.
      const write = (task: string) =>
        appendMcpActivity({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task,
          outcome: "ok",
        });
      await write("task-first");

      const file = path.join(root, MCP_ACTIVITY_FILE);
      execFileSync(process.execPath, [
        "-e",
        [
          "const fs = require('node:fs');",
          "const [file, count] = process.argv.slice(1);",
          "let out = '';",
          "for (let i = 0; i < Number(count); i += 1) {",
          "  out += JSON.stringify({",
          "    at: '2026-09-14T09:00:00.000Z',",
          "    client: 'Claude',",
          "    tool: 'get_task',",
          "    task: 'task-sibling-' + i,",
          "    outcome: 'ok',",
          "  }) + '\\n';",
          "}",
          "fs.appendFileSync(file, out);",
        ].join("\n"),
        file,
        String(MCP_ACTIVITY_MAX_LINES + 4),
      ]);

      await write("task-last");

      const raw = await fs.readFile(file, "utf8");
      expect(raw.trimEnd().split("\n")).toHaveLength(MCP_ACTIVITY_MAX_LINES);
      expect(raw).not.toContain("task-first");
      const entries = await readMcpActivity(1);
      expect(entries[0].task).toBe("task-last");
    },
    15_000,
  );

  it(
    "trims by file size before the line count when every line stays near its own bound",
    async () => {
      const filler = (n: number) => "x".repeat(n);
      const nearMaxEntry = {
        at: "2026-09-14T09:00:00.000Z",
        client: filler(120),
        tool: filler(80),
        accountId: filler(200),
        threadId: filler(200),
        messageId: filler(200),
        attachmentId: filler(200),
        page: filler(200),
        task: filler(200),
        operationId: filler(200),
        change: filler(64),
        outcome: "ok",
      };
      // A handful of lines past where the byte cap trips, so the boundary is
      // crossed without paying for many more full-file rewrites than the
      // point being pinned needs.
      const linesToWrite = Math.ceil(MCP_ACTIVITY_MAX_FILE_BYTES / 1800) + 5;
      for (let i = 0; i < linesToWrite; i += 1) {
        await appendMcpActivity(nearMaxEntry);
      }
      const stat = await fs.stat(path.join(root, MCP_ACTIVITY_FILE));
      expect(stat.size).toBeLessThanOrEqual(MCP_ACTIVITY_MAX_FILE_BYTES);
      const entries = await readMcpActivity(MCP_ACTIVITY_MAX_LINES);
      expect(entries.length).toBeLessThan(linesToWrite);
    },
    15_000,
  );
});

/** THE SECOND RECORD ONE MUTATION LEAVES.
 *
 *  Settings, Connections reads the log; the bell reads the centre. Both come
 *  off this one call, so a tool that already logs cannot forget to tell the
 *  owner, and a tool that logs a read or a refusal cannot accidentally start.
 */
describe("the row a mutation leaves in the centre", () => {
  const rows = () => listNotifications(centre);

  it("writes one row beside the log line", async () => {
    await appendMcpActivity(
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "create_task",
        task: "task-alpha",
        outcome: "ok",
      },
      { label: "Water the plants" },
    );
    expect(await readMcpActivity(50)).toHaveLength(1);
    const centreRows = await rows();
    expect(centreRows).toHaveLength(1);
    expect(centreRows[0].kind).toBe("agent-action");
    expect(centreRows[0].title).toBe("Claude created a task");
    expect(centreRows[0].body).toBe("Water the plants");
    expect(centreRows[0].readAt).toBeUndefined();
  });

  it("keeps the label out of the log line", async () => {
    await appendMcpActivity(
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "create_task",
        task: "task-alpha",
        outcome: "ok",
      },
      { label: "Water the plants" },
    );
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    expect(raw).not.toContain("Water the plants");
  });

  it("writes no row for a refusal, a read or an import", async () => {
    for (const entry of [
      { tool: "create_task", task: "task-alpha", outcome: "not_found" },
      { tool: "get_task", task: "task-alpha", outcome: "ok" },
      { tool: "notion_finalize_page", page: "notes", outcome: "ok" },
      { tool: "connection_check", outcome: "ok" },
    ]) {
      await appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        ...entry,
      });
    }
    expect(await readMcpActivity(50)).toHaveLength(4);
    expect(await rows()).toHaveLength(0);
  });

  it("writes one row for the same line twice, so a replay never doubles", async () => {
    const entry = {
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "complete_task",
      task: "task-alpha",
      outcome: "ok",
    };
    await appendMcpActivity(entry);
    await appendMcpActivity(entry);
    expect(await readMcpActivity(50)).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
  });

  it("still writes the log line when the centre cannot be written", async () => {
    // A file where the centre's directory should be: `mkdir` fails, and with
    // it every write behind it. The tool must not hear about it.
    const blocked = path.join(centre, "blocked");
    await fs.writeFile(blocked, "not a directory");
    vi.stubEnv("BRAIN_NOTIFICATIONS_STATE_DIR", blocked);
    await expect(
      appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "create_task",
        task: "task-alpha",
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();
    expect(await readMcpActivity(50)).toHaveLength(1);
  });
});

/** A BURST IS ONE ROW (Michael's ruling).
 *
 *  An agent working through a mailbox left one row per thread, and two hundred
 *  of them are the whole share its kind has: the burst was pushing its own
 *  history out of the bell one thread at a time. The same client, tool and
 *  change inside five minutes is one row with a count.
 */
describe("what a burst of the same action leaves in the centre", () => {
  const archive = (at: string, thread: string, client = "Claude") =>
    appendMcpActivity({
      at,
      client,
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: thread,
      change: "archive",
      outcome: "ok",
    });

  it("counts three inside the window and starts again after it", async () => {
    await archive("2026-09-14T09:00:00.000Z", "thread-1");
    await archive("2026-09-14T09:01:00.000Z", "thread-2");
    await archive("2026-09-14T09:02:00.000Z", "thread-3");

    const folded = await listNotifications(centre);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      title: "Claude archived 3 threads",
      at: "2026-09-14T09:02:00.000Z",
      // The destination stops naming one thread the moment the row stops being
      // about one thread.
      href: "/mail",
    });

    // Six minutes after the third, which is past the window.
    await archive("2026-09-14T09:08:00.000Z", "thread-4");
    const rows = await listNotifications(centre);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title)).toEqual([
      "Claude archived a thread",
      "Claude archived 3 threads",
    ]);
    // Every line is still its own line. The fold is the bell's, not the log's.
    expect(await readMcpActivity(10)).toHaveLength(4);
  });

  /** THE WINDOW IS FIXED, NOT SLIDING (Michael's ruling): a row lives five
   *  minutes from its FIRST line, whatever has landed in it since. The two
   *  cases below are the ones that tell the two readings apart. */
  it("ends the row five minutes after its first line, not after its newest", async () => {
    await archive("2026-09-14T12:00:00.000Z", "thread-1");
    await archive("2026-09-14T12:03:00.000Z", "thread-2");
    // Four minutes after the newest line and seven after the first. A sliding
    // window folds this; a fixed one starts a row.
    await archive("2026-09-14T12:07:00.000Z", "thread-3");

    const rows = await listNotifications(centre);
    expect(rows.map((row) => row.title)).toEqual([
      "Claude archived a thread",
      "Claude archived 2 threads",
    ]);
  });

  it("folds everything that lands inside the five minutes", async () => {
    await archive("2026-09-14T12:00:00.000Z", "thread-1");
    await archive("2026-09-14T12:04:00.000Z", "thread-2");
    await archive("2026-09-14T12:04:30.000Z", "thread-3");

    const rows = await listNotifications(centre);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Claude archived 3 threads",
      at: "2026-09-14T12:04:30.000Z",
    });
  });

  it("keeps one grant's burst apart from another's", async () => {
    await archive("2026-09-14T09:00:00.000Z", "thread-1", "Claude");
    await archive("2026-09-14T09:00:30.000Z", "thread-2", "Another app");
    const rows = await listNotifications(centre);
    expect(rows.map((row) => row.title).sort()).toEqual([
      "Another app archived a thread",
      "Claude archived a thread",
    ]);
  });

  it("keeps one change apart from another of the same tool", async () => {
    await archive("2026-09-14T09:00:00.000Z", "thread-1");
    await appendMcpActivity({
      at: "2026-09-14T09:00:30.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: "thread-2",
      change: "spam",
      outcome: "ok",
    });
    expect(await listNotifications(centre)).toHaveLength(2);
  });

  it("does not count the same line twice when it is written twice", async () => {
    // A replay of the log is one row, and it is one row of one. The ids a fold
    // has already swallowed are remembered, because they are no longer in the
    // file for the centre's own duplicate check to find.
    await archive("2026-09-14T09:00:00.000Z", "thread-1");
    await archive("2026-09-14T09:01:00.000Z", "thread-2");
    await archive("2026-09-14T09:01:00.000Z", "thread-2");
    const rows = await listNotifications(centre);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Claude archived 2 threads");
  });

  it("starts a new row rather than rewriting one the reader has seen", async () => {
    await archive("2026-09-14T09:00:00.000Z", "thread-1");
    const [row] = await listNotifications(centre);
    await markNotificationsRead([row.id], "2026-09-14T09:00:30.000Z", centre);

    await archive("2026-09-14T09:01:00.000Z", "thread-2");
    const rows = await listNotifications(centre);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("Claude archived a thread");
    expect(rows[0].readAt).toBeUndefined();
  });

  it("folds a burst of task writes into one row without a body", async () => {
    await appendMcpActivity(
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "create_task",
        task: "task-alpha",
        outcome: "ok",
      },
      { label: "Water the plants" },
    );
    await appendMcpActivity(
      {
        at: "2026-09-14T09:00:10.000Z",
        client: "Claude",
        tool: "create_task",
        task: "task-beta",
        outcome: "ok",
      },
      { label: "Call the bank" },
    );
    const rows = await listNotifications(centre);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Claude created 2 tasks",
      href: "/tasks",
    });
    expect(rows[0].body).toBeUndefined();
  });
});
