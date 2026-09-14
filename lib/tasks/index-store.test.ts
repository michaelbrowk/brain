import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LOGBOOK_WINDOW_DAYS,
  TASKS_DIR,
  deleteTaskFile,
  loadTaskIndex,
  logbookWindowStart,
  readTaskBody,
  serializeTask,
  taskFilePath,
  writeTaskFile,
} from "./index-store";
import { taskLogEntrySchema, taskRecordFields, type TaskRecord } from "./model";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-"));
}

/** The whole fixture vocabulary. Two ids, two days, one page, one instant. */
const ALPHA = "task-alpha";
const BETA = "task-beta";
const PAGE = "page-one";
const DAY = "2026-09-13";
const INSTANT = "2026-09-13T09:00:00.000Z";
const ANCHOR = {
  text: "Water the plants",
  hash: "0123456789abcdef",
  ordinal: 0,
  line: 0,
};

function fileFor(record: Partial<TaskRecord> & { id: string }): string {
  const lines = [
    "---",
    `id: ${record.id}`,
    `title: ${record.title ?? "Water the plants"}`,
    `created: ${record.created ?? INSTANT}`,
    `updated: ${record.updated ?? INSTANT}`,
  ];
  if (record.when) lines.push(`when: ${record.when}`);
  // A page never travels alone: `taskRecordRules` refuses a linked record with
  // no anchor, because the anchor IS the link. The fixture writes the one the
  // caller gave or a stand-in, so a `page:` here is a shape the index reads.
  if (record.page) {
    const anchor = record.anchor ?? ANCHOR;
    lines.push(
      `page: ${record.page}`,
      "anchor:",
      `  text: ${anchor.text}`,
      `  hash: ${anchor.hash}`,
      `  ordinal: ${anchor.ordinal}`,
      `  line: ${anchor.line}`,
    );
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function seed(
  root: string,
  name: string,
  contents: string,
): Promise<string> {
  const dir = path.join(root, TASKS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, contents, "utf8");
  return file;
}

const warnings: string[] = [];
const trapWarn = () =>
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

afterEach(() => {
  warnings.length = 0;
  vi.restoreAllMocks();
});

describe("the task index", () => {
  it("loads every valid file in one pass and keys them by id", async () => {
    const root = await tmpRoot();
    await seed(root, `${ALPHA}.md`, fileFor({ id: ALPHA }));
    await seed(root, `${BETA}.md`, fileFor({ id: BETA, title: "Call mum" }));

    const index = await loadTaskIndex(root);

    expect(index.size).toBe(2);
    expect(index.get(ALPHA)?.title).toBe("Water the plants");
    expect(index.get(BETA)?.title).toBe("Call mum");
    expect(index.all().map((task) => task.id).sort()).toEqual([ALPHA, BETA]);
  });

  it("skips a file whose YAML is broken, keeps the rest, and reports the filename", async () => {
    const root = await tmpRoot();
    trapWarn();
    await seed(root, `${ALPHA}.md`, "---\nid: [unclosed\ntitle: broken\n---\n");
    await seed(root, `${BETA}.md`, fileFor({ id: BETA }));

    const index = await loadTaskIndex(root);

    expect(index.get(ALPHA)).toBeUndefined();
    expect(index.get(BETA)).toBeDefined();
    expect(warnings.join("\n")).toContain(`${ALPHA}.md`);
  });

  it("skips a file that fails the schema, and never rewrites or deletes it", async () => {
    const root = await tmpRoot();
    trapWarn();
    // `done` beside `page` is refused by the schema: the note owns a linked
    // task's completion.
    const raw = `---\nid: ${ALPHA}\ntitle: Water the plants\ncreated: ${INSTANT}\nupdated: ${INSTANT}\npage: ${PAGE}\ndone: true\n---\nmy own notes\n`;
    const file = await seed(root, `${ALPHA}.md`, raw);

    const index = await loadTaskIndex(root);

    expect(index.get(ALPHA)).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(warnings.join("\n")).toContain(`${ALPHA}.md`);
  });

  it("ignores a file whose frontmatter id does not match its filename", async () => {
    const root = await tmpRoot();
    trapWarn();
    await seed(root, `${ALPHA}.md`, fileFor({ id: BETA }));

    const index = await loadTaskIndex(root);

    expect(index.size).toBe(0);
    expect(warnings.join("\n")).toContain(`${ALPHA}.md`);
  });

  it("returns an empty index when _tasks does not exist", async () => {
    const root = await tmpRoot();

    const index = await loadTaskIndex(root);

    expect(index.size).toBe(0);
    expect(index.all()).toEqual([]);
  });

  it("indexes by page id so every task of one page is one lookup", async () => {
    const root = await tmpRoot();
    await seed(root, `${ALPHA}.md`, fileFor({ id: ALPHA, page: PAGE }));
    await seed(root, `${BETA}.md`, fileFor({ id: BETA, page: PAGE }));

    const index = await loadTaskIndex(root);

    expect(index.byPage(PAGE).map((task) => task.id).sort()).toEqual([
      ALPHA,
      BETA,
    ]);
    expect(index.byPage("page-two")).toEqual([]);
  });

  it("preserves the file body after the frontmatter byte for byte on a rewrite", async () => {
    const root = await tmpRoot();
    await seed(
      root,
      `${ALPHA}.md`,
      `---\nid: ${ALPHA}\ntitle: Water the plants\ncreated: ${INSTANT}\nupdated: ${INSTANT}\n---\nmy own notes\n`,
    );
    const index = await loadTaskIndex(root);
    const task = index.get(ALPHA);
    if (!task) throw new Error("fixture did not load");

    await writeTaskFile(root, { ...task, when: DAY });

    const raw = await fs.readFile(taskFilePath(root, ALPHA), "utf8");
    expect(raw).toContain("my own notes\n");
    // Quoted, so YAML hands the day back as a string rather than a Date.
    expect(raw).toContain(`when: '${DAY}'`);
    const reloaded = await loadTaskIndex(root);
    expect(reloaded.get(ALPHA)?.when).toBe(DAY);
  });

  it("drops a task from both maps when its file is deleted", async () => {
    const root = await tmpRoot();
    await seed(root, `${ALPHA}.md`, fileFor({ id: ALPHA, page: PAGE }));
    const index = await loadTaskIndex(root);

    await deleteTaskFile(root, ALPHA);
    index.remove(ALPHA);

    expect(index.get(ALPHA)).toBeUndefined();
    expect(index.byPage(PAGE)).toEqual([]);
    await expect(fs.access(taskFilePath(root, ALPHA))).rejects.toThrow();
  });

  it("re-keys the by-page map when put moves a task to another page", async () => {
    const root = await tmpRoot();
    await seed(root, `${ALPHA}.md`, fileFor({ id: ALPHA, page: PAGE }));
    const index = await loadTaskIndex(root);
    const task = index.get(ALPHA);
    if (!task) throw new Error("fixture did not load");

    index.put({ ...task, page: "page-two" });

    expect(index.byPage(PAGE)).toEqual([]);
    expect(index.byPage("page-two").map((t) => t.id)).toEqual([ALPHA]);
  });

  it("refuses an id that is not a task id before it reaches a path", async () => {
    const root = await tmpRoot();

    expect(() => taskFilePath(root, "../escape")).toThrow();
    expect(() => taskFilePath(root, "with/slash")).toThrow();
    expect(() => taskFilePath(root, "")).toThrow();
    expect(taskFilePath(root, ALPHA)).toBe(
      path.join(root, TASKS_DIR, `${ALPHA}.md`),
    );
  });

  it("refuses to write over a file it cannot parse", async () => {
    const root = await tmpRoot();
    await seed(
      root,
      `${ALPHA}.md`,
      `---\nid: ${ALPHA}\ntitle: Water the plants\ncreated: ${INSTANT}\nupdated: ${INSTANT}\n---\nmy own notes\n`,
    );
    const index = await loadTaskIndex(root);
    const task = index.get(ALPHA);
    if (!task) throw new Error("fixture did not load");

    // The person hand-edits the file into broken YAML after the index was
    // built. The stale entry is still in memory, so a patch reaches the write
    // path and finds a file it cannot read.
    const broken = "---\nid: [unclosed\n---\nmy own notes\n";
    await seed(root, `${ALPHA}.md`, broken);

    await expect(writeTaskFile(root, { ...task, when: DAY })).rejects.toThrow();
    expect(await fs.readFile(taskFilePath(root, ALPHA), "utf8")).toBe(broken);
  });

  it("counts the logbook window back in whole calendar days", async () => {
    // A literal, not `logbookWindowStart(today, LOGBOOK_WINDOW_DAYS)`: the
    // default compared against itself passes whatever the window becomes.
    expect(LOGBOOK_WINDOW_DAYS).toBe(30);
    expect(logbookWindowStart("2026-09-13")).toBe("2026-08-14");
    // Across a month end and a leap day, so the arithmetic is civil and not
    // a subtraction of milliseconds.
    expect(logbookWindowStart("2024-03-01")).toBe("2024-01-31");
    expect(logbookWindowStart("2026-01-05")).toBe("2025-12-06");
  });

  it("takes that window from lists.ts, so the store and the column cannot hold two", async () => {
    // The column derives the Logbook from the same number the store serves it
    // by. Two constants drift, and the day they do the list shows a completion
    // the store has already dropped.
    //
    // Asserted through what `lists.ts` DERIVES, against a literal day.
    // `index-store.ts` re-exports the binding it imports from `./lists`, so
    // comparing the two exports is one value compared with itself and cannot
    // fail whatever either file becomes. The first day of the window can.
    const lists = await import("./lists");
    const oldest = lists.logbookRows(
      [
        {
          id: "task-edge",
          title: "The oldest row the window holds",
          created: "2026-08-14T09:00:00.000Z",
          updated: "2026-08-14T09:00:00.000Z",
          done: true,
          doneAt: "2026-08-14T09:00:00.000Z",
        },
        {
          id: "task-past",
          title: "One day older than that",
          created: "2026-08-13T09:00:00.000Z",
          updated: "2026-08-13T09:00:00.000Z",
          done: true,
          doneAt: "2026-08-13T09:00:00.000Z",
        },
      ],
      "2026-09-13",
      0,
    );
    expect(oldest.map((row) => row.task.id)).toEqual(["task-edge"]);
    expect(logbookWindowStart("2026-09-13")).toBe("2026-08-14");
  });

  /** The body shapes a Markdown-literate person writes. A leading fence is the
   *  one that used to be folded into the record's own frontmatter. */
  const BODIES = [
    "---\nkey: value\n---\n\npara\n",
    "no trailing newline",
    "a\n---\nb\n",
    "  indented, and kept\n",
    "one\n\ntwo\n",
  ];

  it("writes every body shape back byte for byte, fence first included", async () => {
    const root = await tmpRoot();
    const record: TaskRecord = {
      id: ALPHA,
      title: "Water the plants",
      done: false,
      created: INSTANT,
      updated: INSTANT,
    };
    for (const body of BODIES) {
      await writeTaskFile(root, record, body);
      expect(await readTaskBody(root, ALPHA)).toBe(body);
      // The body is never parsed on the way in, so a key inside it cannot
      // land in the record, and the record still loads.
      const index = await loadTaskIndex(root);
      expect(index.get(ALPHA)).toEqual(record);
    }
  });

  it("refuses to write over a file it cannot parse even when a body is given", async () => {
    const root = await tmpRoot();
    const broken = "---\nid: [unclosed\n---\nmy own notes\n";
    await seed(root, `${ALPHA}.md`, broken);
    const record: TaskRecord = {
      id: ALPHA,
      title: "Water the plants",
      done: false,
      created: INSTANT,
      updated: INSTANT,
    };

    await expect(writeTaskFile(root, record, "a new body\n")).rejects.toThrow();
    expect(await fs.readFile(taskFilePath(root, ALPHA), "utf8")).toBe(broken);
  });
});

/** Every field the schema has, spread over the fewest records that can hold
 *  them: `repeat` refuses a `page`, `log` needs a `repeat`, and `done` needs
 *  the record to own its completion. Between them these two cover the shape.
 */
const EVERY_FIELD: TaskRecord[] = [
  {
    id: ALPHA,
    title: "Water the plants",
    when: DAY,
    time: "13:00",
    evening: true,
    deadline: "2026-09-20",
    category: "Home",
    page: PAGE,
    anchor: { text: "Water the plants", hash: "0123456789abcdef", ordinal: 0, line: 12 },
    detachedAt: "2026-09-14T08:15:00.000Z",
    done: true,
    doneAt: INSTANT,
    created: INSTANT,
    updated: INSTANT,
  },
  {
    id: BETA,
    title: "Take the bins out",
    when: DAY,
    deadline: "2026-09-20",
    category: "Home",
    repeat: { freq: "weekly", byWeekday: ["mon"] },
    log: [{ scheduled: DAY, time: "13:00", completedAt: INSTANT }],
    remindedAt: "2026-09-13T12:00:00.000Z",
    done: false,
    created: INSTANT,
    updated: INSTANT,
  },
];

describe("the serializer and the schema, key for key", () => {
  /** `serializeTask` writes an explicit key list, which is what keeps a task
   *  file's git diff readable. The cost of an explicit list is that a field
   *  added to the schema and forgotten here is dropped on the record's first
   *  write, with nothing said. `detachedAt` was added and forgotten exactly
   *  once, so this compares the two lists rather than trusting the next
   *  author to remember. */
  it("writes every field the schema has, and no field it does not", () => {
    const written = new Set<string>();
    for (const record of EVERY_FIELD) {
      for (const line of serializeTask(record, "").split("\n")) {
        const key = /^([A-Za-z][A-Za-z0-9_]*):/.exec(line)?.[1];
        if (key) written.add(key);
      }
    }
    expect([...written].sort()).toEqual(Object.keys(taskRecordFields.shape).sort());
  });

  it("reads every one of them back unchanged", async () => {
    const root = await tmpRoot();
    for (const record of EVERY_FIELD) {
      await writeTaskFile(root, record);
    }
    const index = await loadTaskIndex(root);
    for (const record of EVERY_FIELD) {
      expect(index.get(record.id)).toEqual(record);
    }
  });

  it("keeps a detached record's done, which a linked record's is not", async () => {
    const root = await tmpRoot();
    const [detached] = EVERY_FIELD;
    // The linked twin: the same record with the mark taken off. Its `done` is
    // the note's to answer, so the file must not carry one.
    const linked: TaskRecord = { ...detached, id: BETA };
    delete linked.detachedAt;
    delete linked.done;

    await writeTaskFile(root, detached);
    await writeTaskFile(root, linked);
    expect(serializeTask(detached, "")).toContain("done: true");
    expect(serializeTask(linked, "")).not.toContain("done:");

    const index = await loadTaskIndex(root);
    expect(index.get(ALPHA)?.done).toBe(true);
    expect(index.get(ALPHA)?.detachedAt).toBe("2026-09-14T08:15:00.000Z");
    expect(index.get(ALPHA)?.page).toBe(PAGE);
    expect(index.get(BETA)?.done).toBeUndefined();
  });

  it("reads a detached record as owning its own done, and a linked one as not", async () => {
    const root = await tmpRoot();
    const [detached] = EVERY_FIELD;
    await writeTaskFile(root, detached);
    const index = await loadTaskIndex(root);
    // Nothing called `setLinkedDone`, so a record still read as linked would
    // answer false here and a finished task would reappear in Today.
    expect(index.view(ALPHA)?.done).toBe(true);
  });

  /** The key list above sees the record's own keys only, because a nested one
   *  is indented and the regex is anchored. `log` goes to the YAML writer
   *  whole, so a field added to `taskLogEntrySchema` reaches the file with no
   *  list to forget it, and the risk moves to the fixtures: an entry that
   *  never carries the field would let a serializer that drops it pass. This
   *  reads the block that was written. */
  it("writes every field a log entry has, and no field it does not", () => {
    const logged: TaskRecord = {
      id: BETA,
      title: "Take the bins out",
      when: DAY,
      log: [{ scheduled: DAY, time: "13:00", completedAt: INSTANT }],
      created: INSTANT,
      updated: INSTANT,
    };
    const written = new Set<string>();
    let inLog = false;
    for (const line of serializeTask(logged, "").split("\n")) {
      if (/^log:/.test(line)) {
        inLog = true;
        continue;
      }
      if (/^[A-Za-z]/.test(line)) {
        inLog = false;
        continue;
      }
      if (!inLog) continue;
      const key = /^\s+-?\s*([A-Za-z][A-Za-z0-9_]*):/.exec(line)?.[1];
      if (key) written.add(key);
    }
    expect([...written].sort()).toEqual(Object.keys(taskLogEntrySchema.shape).sort());
  });

  it("keeps a time as a quoted string through a write and a read", async () => {
    const root = await tmpRoot();
    const [detached] = EVERY_FIELD;
    await writeTaskFile(root, detached);
    expect(serializeTask(detached, "")).toContain("time: '13:00'");
    const index = await loadTaskIndex(root);
    expect(index.get(ALPHA)?.time).toBe("13:00");
  });
});
