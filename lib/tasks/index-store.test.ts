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
  taskFilePath,
  writeTaskFile,
} from "./index-store";
import type { TaskRecord } from "./model";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-"));
}

/** The whole fixture vocabulary. Two ids, two days, one page, one instant. */
const ALPHA = "task-alpha";
const BETA = "task-beta";
const PAGE = "page-one";
const DAY = "2026-09-13";
const INSTANT = "2026-09-13T09:00:00.000Z";

function fileFor(record: Partial<TaskRecord> & { id: string }): string {
  const lines = [
    "---",
    `id: ${record.id}`,
    `title: ${record.title ?? "Water the plants"}`,
    `created: ${record.created ?? INSTANT}`,
    `updated: ${record.updated ?? INSTANT}`,
  ];
  if (record.when) lines.push(`when: ${record.when}`);
  if (record.page) lines.push(`page: ${record.page}`);
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

  it("counts the logbook window back in whole calendar days", async () => {
    expect(LOGBOOK_WINDOW_DAYS).toBe(30);
    expect(logbookWindowStart("2026-09-13")).toBe("2026-08-14");
    // Across a month end and a leap day, so the arithmetic is civil and not
    // a subtraction of milliseconds.
    expect(logbookWindowStart("2024-03-01")).toBe("2024-01-31");
    expect(logbookWindowStart("2026-01-05")).toBe("2025-12-06");
  });
});
