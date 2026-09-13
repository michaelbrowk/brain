import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { atomicWrite } from "../store/atomic";
import { assertInRoot } from "../store/paths";
import { TASK_ID_RE, parseTaskRecord, type TaskRecord, type TaskView } from "./model";

/** The task records on disk, and the one map of them in memory.
 *
 *  One file per task, `_tasks/<id>.md`, frontmatter through the same
 *  gray-matter the pages use. Read paths never touch the disk: the index is
 *  built once at startup, rebuilt by `Store.rebuild()`, and kept current by
 *  the store's task leaves.
 *
 *  A file this module cannot read is still the person's file. It is skipped
 *  with one warning naming the file and the reason, and is never rewritten
 *  and never deleted.
 */

/** Reserved in `lib/store/paths.ts`, so `rebuild()` never walks it as pages. */
export const TASKS_DIR = "_tasks";

/** The Logbook holds 30 days. Older completions stay on disk and stay out of
 *  every list. */
export const LOGBOOK_WINDOW_DAYS = 30;

/** The path of one task record. The id is validated against `TASK_ID_RE`
 *  before it reaches `path.join`, and the result passes `assertInRoot`, so no
 *  caller string can name a file outside the notes root. */
export function taskFilePath(root: string, id: string): string {
  if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
  return assertInRoot(root, path.join(root, TASKS_DIR, `${id}.md`));
}

export class InvalidTaskIdError extends Error {
  readonly name = "InvalidTaskIdError";
  constructor(id: string) {
    super(`invalid task id: ${JSON.stringify(id)}`);
  }
}

/** The in-memory index: by id, and by the page a linked task points at. */
export class TaskIndex {
  private readonly byId = new Map<string, TaskRecord>();
  private readonly pages = new Map<string, Set<string>>();
  /** A linked task's `done` is never in its file, because the checkbox in the
   *  note is the truth. It is held here and recomputed by the reconcile. */
  private readonly linkedDone = new Map<string, boolean>();

  get size(): number {
    return this.byId.size;
  }

  get(id: string): TaskRecord | undefined {
    return this.byId.get(id);
  }

  all(): TaskRecord[] {
    return [...this.byId.values()];
  }

  byPage(pageId: string): TaskRecord[] {
    const ids = this.pages.get(pageId);
    if (!ids) return [];
    return [...ids].flatMap((id) => {
      const task = this.byId.get(id);
      return task ? [task] : [];
    });
  }

  put(task: TaskRecord): void {
    const previous = this.byId.get(task.id);
    if (previous?.page && previous.page !== task.page) {
      this.pages.get(previous.page)?.delete(task.id);
    }
    this.byId.set(task.id, task);
    if (task.page) {
      const ids = this.pages.get(task.page) ?? new Set<string>();
      ids.add(task.id);
      this.pages.set(task.page, ids);
    }
    if (!task.page) this.linkedDone.delete(task.id);
  }

  remove(id: string): void {
    const previous = this.byId.get(id);
    if (previous?.page) this.pages.get(previous.page)?.delete(id);
    this.byId.delete(id);
    this.linkedDone.delete(id);
  }

  /** The completion the reconcile read off the note's checkbox. Nothing calls
   *  this in stage 1; the reconcile in stage 3 does. */
  setLinkedDone(id: string, done: boolean): void {
    this.linkedDone.set(id, done);
  }

  /** A record plus the completion a reader needs. For a linked task that is
   *  the remembered state of the note's checkbox, for an unlinked one it is
   *  the record's own field. */
  view(id: string): TaskView | undefined {
    const task = this.byId.get(id);
    return task ? this.viewOf(task) : undefined;
  }

  views(): TaskView[] {
    return this.all().map((task) => this.viewOf(task));
  }

  private viewOf(task: TaskRecord): TaskView {
    const done = task.page
      ? (this.linkedDone.get(task.id) ?? false)
      : (task.done ?? false);
    return { ...task, done };
  }
}

/** One `readdir` plus parallel `readFile`. A missing `_tasks` is an empty
 *  index, which is what every notes root looks like before the first task. */
export async function loadTaskIndex(root: string): Promise<TaskIndex> {
  const index = new TaskIndex();
  const dir = assertInRoot(root, path.join(root, TASKS_DIR));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return index;
    throw error;
  }

  const loaded = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => readTaskFile(dir, name)),
  );
  for (const task of loaded) if (task) index.put(task);
  return index;
}

async function readTaskFile(
  dir: string,
  name: string,
): Promise<TaskRecord | null> {
  const file = path.join(dir, name);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    // A directory or a dangling link under `_tasks` is somebody else's; a
    // read failure here must not take the whole notebook down.
    skip(name, (error as NodeJS.ErrnoException).code ?? "cannot be read");
    return null;
  }

  let data: unknown;
  try {
    data = readFrontmatter(raw).data;
  } catch (error) {
    skip(name, error instanceof Error ? error.message : "invalid YAML");
    return null;
  }

  const parsed = parseTaskRecord(data);
  if (!parsed.ok) {
    skip(name, parsed.reason);
    return null;
  }
  // The filename is the id, so one file is one task and a copied file cannot
  // quietly take over the original's identity.
  if (parsed.task.id !== name.slice(0, -3)) {
    skip(name, `frontmatter id ${parsed.task.id} does not match the filename`);
    return null;
  }
  return parsed.task;
}

function skip(name: string, reason: string): void {
  console.warn(`[brain/tasks] skipping ${TASKS_DIR}/${name}: ${reason}`);
}

/** The body after a record's frontmatter, or the empty string when the file
 *  has none and when there is no file yet. There is no task body in v1: it has
 *  no writer in the app, so the only one a file can hold is a person's own,
 *  and this is how the portable export carries it out. */
export async function readTaskBody(root: string, id: string): Promise<string> {
  const file = taskFilePath(root, id);
  try {
    const content = readFrontmatter(await fs.readFile(file, "utf8")).content;
    // A record written with no body still ends in the newline the frontmatter
    // delimiter needs, and whitespace on its own is not somebody's writing.
    return content.trim() === "" ? "" : content;
  } catch (error) {
    // Only a file that is not there. Broken YAML in a file that IS there is a
    // hand edit, and answering the empty string would report it as an empty
    // body and let the export write that emptiness down.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

/** Write one record. With no `body`, the file's own body after the frontmatter
 *  is kept byte for byte, so a person editing `_tasks/<id>.md` by hand does
 *  not lose it. With a `body`, that body is written instead, which is what a
 *  portable import does when it lands a record and its body together. */
export async function writeTaskFile(
  root: string,
  task: TaskRecord,
  body?: string,
): Promise<void> {
  const file = taskFilePath(root, task.id);
  let kept = "";
  try {
    kept = readFrontmatter(await fs.readFile(file, "utf8")).content;
  } catch (error) {
    // Only a file that is not there yet. A file that IS there and cannot be
    // read or parsed is somebody's hand edit: the index is built once, so a
    // record can be edited into broken YAML long after it was loaded, and
    // writing a record over it would lose both the body and the edit with
    // nothing said. Refuse instead, and refuse it whether or not a body was
    // handed in: the file on disk is the thing being protected, not the
    // argument.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(file, serializeTask(task, body ?? kept));
}

/** Whether a file sits under this id, whatever the in-memory index thinks.
 *
 *  The index skips a file it cannot read, cannot parse, or whose frontmatter
 *  id does not match its filename, so "the index does not have it" is not the
 *  same question as "the id is free". A writer that must not overwrite has to
 *  ask the disk. */
export async function taskFileExists(
  root: string,
  id: string,
): Promise<boolean> {
  try {
    await fs.stat(taskFilePath(root, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function deleteTaskFile(root: string, id: string): Promise<void> {
  await fs.rm(taskFilePath(root, id), { force: true });
}

/** The one key order every task file is written in, so a git diff shows the
 *  field that changed and nothing else. */
export function serializeTask(task: TaskRecord, body: string): string {
  const ordered: Record<string, unknown> = { id: task.id, title: task.title };
  if (task.when !== undefined) ordered.when = task.when;
  if (task.deadline !== undefined) ordered.deadline = task.deadline;
  if (task.category !== undefined) ordered.category = task.category;
  if (task.page !== undefined) ordered.page = task.page;
  if (task.anchor !== undefined) ordered.anchor = task.anchor;
  if (task.repeat !== undefined) ordered.repeat = task.repeat;
  // Never written for a linked task: the note's checkbox is the truth, and a
  // second copy of it would be a second answer to drift.
  if (task.done !== undefined && task.page === undefined) ordered.done = task.done;
  if (task.doneAt !== undefined) ordered.doneAt = task.doneAt;
  if (task.log !== undefined) ordered.log = task.log;
  ordered.created = task.created;
  ordered.updated = task.updated;
  // The frontmatter block on its own, then the body appended raw.
  //
  // `matter.stringify(body, data)` parses `body` first, so a body that opens
  // with its own `---` fence had that fence read as frontmatter: its keys were
  // merged into the record and the block was gone from the file. It also adds
  // a trailing newline to a body that has none. Neither is acceptable for
  // bytes a person wrote, so the body never goes through the parser. Stringify
  // ends an empty body with a blank line after the closing fence, and the body
  // has to start on the line straight after it.
  const header = matter.stringify("", ordered).replace(/\n+$/, "\n");
  return header + body;
}

/** The first day the Logbook still shows, counted back in whole calendar days
 *  from the caller's own today.
 *
 *  It lives here rather than in `lists.ts` because that module is the pure
 *  derivation shared with the browser and owns no window. `Date.UTC` is civil
 *  arithmetic at a fixed offset, so no local timezone takes part.
 */
export function logbookWindowStart(
  today: string,
  days = LOGBOOK_WINDOW_DAYS,
): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

/** gray-matter caches every distinct input string forever when called without
 *  options, one entry per saved revision for the life of the process. The
 *  options object is what turns that off, same as `lib/store/frontmatter.ts`. */
function readFrontmatter(raw: string): { data: unknown; content: string } {
  const { data, content } = matter(raw, { language: "yaml" });
  return { data, content };
}
