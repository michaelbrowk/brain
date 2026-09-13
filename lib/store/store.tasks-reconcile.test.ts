import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "./store";
import { RevConflictError } from "./types";
import { parseTaskLines } from "../tasks/task-lines";
import type { TaskView } from "../tasks/model";

/** The spec's named test: two writers and one checkbox.
 *
 *  Somebody ticks a task on their phone while the same note sits open in a
 *  browser. The browser's next autosave carries the body it loaded, which
 *  still has the box unticked, and today that is a `RevConflictError`, a 409
 *  from `lib/api/page-write.ts`, and a "Page changed elsewhere" latch in the
 *  editor. Without the merge, every completion from Tasks against an open
 *  note produces that banner.
 *
 *  Exactly one shape merges: the server changed nothing but checkbox tokens,
 *  on lines this writer did not touch. Everything else stays a 409, with the
 *  same shape it has today, because a second conflict rule is how the
 *  editor's latch starts lying.
 *
 *  Written red in phase 1, against a `writePage` that had no merge, and
 *  unskipped in phase 2 when it grew one.
 */

const TODAY = "2026-09-14";

/** One task line and one paragraph. Small enough that a merge failure names
 *  which rule refused rather than which byte moved. */
const BASE_BODY = "- [ ] Water the plants\n\nA note about the garden.";
const TICKED_BODY = "- [x] Water the plants\n\nA note about the garden.";

/** One task record as the file holds it. */
async function readTaskFile(root: string, id: string): Promise<string> {
  return fs.readFile(path.join(root, "_tasks", `${id}.md`), "utf8");
}

async function tmpStore(options: { publicOrigin?: string | null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-reconcile-"));
  const s = new Store(root, options);
  await s.init();
  return { s, root };
}

/** A page holding one unticked task line, and a task linked to that line. */
async function gardenPage(s: Store) {
  const page = await s.createPage(null, "Garden");
  const written = await s.writePage(page.id, BASE_BODY, undefined, "me");
  const [line] = parseTaskLines(written.markdown);
  const task = await s.createTask({
    title: line.normalized,
    page: page.id,
    anchor: {
      text: line.normalized,
      hash: line.hash,
      ordinal: line.ordinal,
      line: line.index,
    },
  });
  return { pageId: page.id, taskId: task.id, rev: written.rev };
}

/** The conflict, whole. "Do not fork the 409" is this task's hardest rule and
 *  the class alone cannot see it: `lib/api/page-write.ts` reads `currentRev`
 *  off the error and the editor's latch reads it off the response. */
async function expectSameConflict(
  write: Promise<unknown>,
  expected: { currentRev: string; expectedRev: string },
): Promise<void> {
  await expect(write).rejects.toMatchObject({
    name: "RevConflictError",
    message: "rev conflict",
    currentRev: expected.currentRev,
    expectedRev: expected.expectedRev,
  });
  await expect(write).rejects.toBeInstanceOf(RevConflictError);
}

function viewOf(s: Store, id: string): TaskView {
  const found = s.listTasks(TODAY, { offsetMinutes: 0 }).find((task) => task.id === id);
  if (!found) throw new Error(`no task ${id} in any list`);
  return found;
}

/** A share whose visitor may edit, with the garden page inside it. */
async function sharedGarden() {
  const { s } = await tmpStore({ publicOrigin: "https://brain.test" });
  const root = await s.createPage(null, "Shared root");
  const page = await s.createPage(root.id, "Garden");
  const written = await s.writePage(page.id, BASE_BODY, undefined, "me");
  const [line] = parseTaskLines(written.markdown);
  const task = await s.createTask({
    title: line.normalized,
    when: "2026-09-14",
    deadline: "2026-09-20",
    category: "Home",
    page: page.id,
    anchor: {
      text: line.normalized,
      hash: line.hash,
      ordinal: line.ordinal,
      line: line.index,
    },
  });
  const before = await s.readShareScope(root.id);
  await s.configureShare(root.id, {
    enabled: true,
    expectedScopeToken: before.scopeToken,
    canEdit: true,
  });
  const shareVersion = (await s.readShareScope(root.id)).shareVersion;
  return { s, rootId: root.id, pageId: page.id, taskId: task.id, rev: written.rev, shareVersion };
}

describe("two writers and one checkbox", () => {
  it("accepts A's unrelated paragraph with B's tick preserved", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId, rev } = await gardenPage(s);

    // B ticks the box. The Tasks surface and a second tab land on the same
    // write, so the tick reaches the note either way and the rev moves.
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    // A still holds R1 and saves the paragraph it was editing.
    const mine = `${BASE_BODY}\n\nA paragraph A typed.`;
    const merged = await s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY);

    expect(merged.markdown).toContain("- [x] Water the plants");
    expect(merged.markdown).toContain("A paragraph A typed.");
    expect((await s.readPage(pageId)).markdown).toBe(merged.markdown);
    expect(viewOf(s, taskId).done).toBe(true);
    // The merged body takes the CURRENT rev as its base, which is what makes
    // A's next write with the rev it was handed an ordinary write and not a
    // second conflict. Any write moves the rev, so the assertion that says
    // this is the follow-up, not an inequality.
    const after = await s.writePage(
      pageId,
      `${merged.markdown}\n\nAnd one more line.`,
      merged.rev,
      "me",
      undefined,
      merged.markdown,
    );
    expect(after.markdown).toContain("And one more line.");
  });

  it("refuses A with a 409 when A rewrote the ticked line", async () => {
    const { s } = await tmpStore();
    const { pageId, rev } = await gardenPage(s);
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    // The tick and the edit are on one line, and no rule can say which of the
    // two a person meant. A 409 and two visible versions is the honest answer.
    const mine = "- [ ] Water the plants twice\n\nA note about the garden.";
    await expectSameConflict(
      s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
      { currentRev: (await s.readPage(pageId)).rev, expectedRev: rev },
    );
    expect((await s.readPage(pageId)).markdown).toBe(TICKED_BODY);
  });

  it("refuses A with a 409 when B inserted a line", async () => {
    const { s } = await tmpStore();
    const { pageId, rev } = await gardenPage(s);
    // A different line count is an insertion, and a line index cannot be
    // carried across one.
    const theirs = "- [x] Water the plants\n- [ ] Feed the cat\n\nA note about the garden.";
    await s.writePage(pageId, theirs, rev, "me");

    const mine = `${BASE_BODY}\n\nA paragraph A typed.`;
    await expectSameConflict(
      s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
      { currentRev: (await s.readPage(pageId)).rev, expectedRev: rev },
    );
    expect((await s.readPage(pageId)).markdown).toBe(theirs);
  });

  it("treats a visitor's tick as truth, and merges the owner's paragraph over it", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();
    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: TICKED_BODY,
      expectedRev: rev,
      visitorName: "Ada",
    });

    const mine = `${BASE_BODY}\n\nA paragraph A typed.`;
    const merged = await s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY);

    expect(merged.markdown).toContain("- [x] Water the plants");
    expect(merged.markdown).toContain("A paragraph A typed.");
    expect(viewOf(s, taskId).done).toBe(true);
    expect(merged.meta.updatedBy).toBe("me");
  });

  it("merges a visitor's own stale write over the owner's tick, and keeps the attribution", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    const theirs = `${BASE_BODY}\n\nA paragraph the visitor typed.`;
    const merged = await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: theirs,
      expectedRev: rev,
      expectedMarkdown: BASE_BODY,
      visitorName: "Ada",
    });

    expect(merged.markdown).toContain("- [x] Water the plants");
    expect(merged.markdown).toContain("A paragraph the visitor typed.");
    expect(merged.meta.updatedBy).toBe("visitor");
    expect(merged.meta.updatedByName).toBe("Ada");
    expect(viewOf(s, taskId).done).toBe(true);
  });

  it("keeps the shared path's 409 where the owner path has one", async () => {
    const { s, rootId, pageId, rev, shareVersion } = await sharedGarden();
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    const theirs = "- [ ] Water the plants twice\n\nA note about the garden.";
    await expectSameConflict(
      s.writeSharedPage({
        rootId,
        targetId: pageId,
        shareVersion,
        markdown: theirs,
        expectedRev: rev,
        expectedMarkdown: BASE_BODY,
        visitorName: "Ada",
      }),
      { currentRev: (await s.readPage(pageId)).rev, expectedRev: rev },
    );
    expect((await s.readPage(pageId)).markdown).toBe(TICKED_BODY);
  });
});

/** The spec's sync table, row by row, against the store. Each case is one row.
 *
 *  The pure decisions are `lib/tasks/reconcile.test.ts`. These are about what
 *  the store does with them: which file is written, which is not, and what a
 *  reader sees afterwards.
 */
describe("reconcile", () => {
  const NOTE = "- [ ] Water the plants\n- [ ] Feed the cat";

  /** A page with two task lines, and one task on the first of them. */
  async function garden(s: Store, body = NOTE) {
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(page.id, body, undefined, "me");
    const [line] = parseTaskLines(written.markdown);
    const task = await s.createTask({
      title: line.normalized,
      when: "2026-09-14",
      deadline: "2026-09-20",
      category: "Home",
      page: page.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    });
    return { pageId: page.id, taskId: task.id, rev: written.rev };
  }

  it("detaches the task when the line goes, keeping its schedule and its last title", async () => {
    const { s, root } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    await s.writePage(pageId, "- [ ] Feed the cat", undefined, "me");

    const view = s.getTask(taskId);
    expect(view?.detachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    // The task is never deleted with the line, and it keeps everything that
    // was never the note's to own.
    expect(view?.title).toBe("Water the plants");
    expect(view?.when).toBe("2026-09-14");
    expect(view?.deadline).toBe("2026-09-20");
    expect(view?.category).toBe("Home");
    // And it keeps the page, so the row can say which note the line left.
    expect(view?.page).toBe(pageId);
    expect(view?.anchor?.text).toBe("Water the plants");
    const raw = await readTaskFile(root, taskId);
    expect(raw).toContain("detachedAt:");
    expect(raw).toContain("done: false");
  });

  it("writes done into the file on detach, and never before", async () => {
    const { s, root } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    await s.writePage(pageId, "- [x] Water the plants\n- [ ] Feed the cat", undefined, "me");
    const ticked = await readTaskFile(root, taskId);
    // The checkbox is the truth while the line is there, so the record holds
    // the instant and not the answer.
    expect(ticked).not.toContain("done:");
    expect(ticked).toContain("doneAt:");
    expect(s.getTask(taskId)?.done).toBe(true);

    await s.writePage(pageId, "- [ ] Feed the cat", undefined, "me");
    const detached = await readTaskFile(root, taskId);
    expect(detached).toContain("done: true");
    expect(detached).toContain("doneAt:");
    expect(s.getTask(taskId)?.done).toBe(true);
  });

  it("refreshes ordinal and line when the line crosses an identical one", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await garden(
      s,
      "- [ ] Water the plants\n- [ ] Feed the cat",
    );

    // A copy of the line above it, so the record's ordinal has to move with it.
    await s.writePage(
      pageId,
      "- [ ] Water the plants\n- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    expect(s.getTask(taskId)?.anchor?.ordinal).toBe(0);

    await s.writePage(
      pageId,
      "- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    const view = s.getTask(taskId);
    expect(view?.detachedAt).toBeUndefined();
    expect(view?.anchor?.ordinal).toBe(0);
    expect(view?.anchor?.line).toBe(0);
  });

  it("gives one duplicated line's task to the first line in document order", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    await s.writePage(
      pageId,
      "- [ ] Water the plants\n- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );

    expect(s.getTask(taskId)?.anchor?.line).toBe(0);
    // The later duplicate is an ordinary checkbox. Nothing was created for it.
    expect(s.allTasks()).toHaveLength(1);
  });

  it("rebinds after an edit above the threshold and detaches below it", async () => {
    const { s } = await tmpStore();
    const above = await tmpStore();
    const first = await garden(s);
    await s.writePage(
      first.pageId,
      "- [ ] Water the plants today\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    expect(s.getTask(first.taskId)?.detachedAt).toBeUndefined();
    // The title cache follows the line, because the line owns it.
    expect(s.getTask(first.taskId)?.title).toBe("Water the plants today");

    const second = await garden(above.s);
    await above.s.writePage(
      second.pageId,
      "- [ ] Call the dentist\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    expect(above.s.getTask(second.taskId)?.detachedAt).toBeDefined();
    expect(above.s.getTask(second.taskId)?.title).toBe("Water the plants");
  });

  it("appends through the same reconcile", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    await s.appendPage(pageId, "- [ ] And a third", "me");

    // The append pushed nothing above the line, so the anchor stands and the
    // new checkbox is nobody's task.
    expect(s.getTask(taskId)?.detachedAt).toBeUndefined();
    expect(s.allTasks()).toHaveLength(1);
  });

  it("hides a trashed page's tasks from listTasks and shows them again on restore", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await garden(s);
    const visible = () =>
      s.listTasks("2026-09-14", { offsetMinutes: 0 }).map((task) => task.id);

    expect(visible()).toContain(taskId);

    await s.deletePage(pageId);
    // Hidden, not deleted. Showing a task whose note cannot be opened is
    // worse than a task missing from Today for as long as the page is in the
    // trash.
    expect(visible()).not.toContain(taskId);
    expect(s.getTask(taskId)).not.toBeNull();

    await s.restorePage(pageId);
    expect(visible()).toContain(taskId);
    // No recomputation: the record came back exactly as it went in.
    expect(s.getTask(taskId)?.detachedAt).toBeUndefined();
    expect(s.getTask(taskId)?.when).toBe("2026-09-14");
  });

  it("deletes open linked tasks on purge and keeps done ones in the Logbook as detached", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(
      page.id,
      "- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    const lines = parseTaskLines(written.markdown);
    const open = await s.createTask({
      title: lines[0].normalized,
      page: page.id,
      anchor: {
        text: lines[0].normalized,
        hash: lines[0].hash,
        ordinal: lines[0].ordinal,
        line: lines[0].index,
      },
    });
    const finished = await s.createTask({
      title: lines[1].normalized,
      page: page.id,
      anchor: {
        text: lines[1].normalized,
        hash: lines[1].hash,
        ordinal: lines[1].ordinal,
        line: lines[1].index,
      },
    });
    await s.writePage(
      page.id,
      "- [ ] Water the plants\n- [x] Feed the cat",
      undefined,
      "me",
    );
    expect(s.getTask(finished.id)?.done).toBe(true);

    await s.deletePage(page.id);
    await s.purgePage(page.id);

    // An open one would otherwise fill the Inbox with the tail of a page
    // somebody deliberately threw away.
    expect(s.getTask(open.id)).toBeNull();
    // A finished one is a record of what was done, and purging the page does
    // not unfinish it.
    const kept = s.getTask(finished.id);
    expect(kept?.done).toBe(true);
    expect(kept?.detachedAt).toBeDefined();
    expect(
      s.listTasks("2026-09-14", { list: "logbook", offsetMinutes: 0 }).map((t) => t.id),
    ).toContain(finished.id);
  });

  it("reconciles a hand-edited notes directory through rebuild, the note winning text and done", async () => {
    const { s, root } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    // The notebook is edited outside Brain: a git pull, a restored backup, or
    // somebody with an editor open.
    const indexPath = path.join(s.resolve(pageId), "index.md");
    const raw = await fs.readFile(indexPath, "utf8");
    await fs.writeFile(
      indexPath,
      raw.replace(
        "- [ ] Water the plants",
        "- [x] Water the plants every morning",
      ),
      "utf8",
    );

    const restarted = new Store(root);
    await restarted.init();

    const view = restarted.getTask(taskId);
    // The note wins the text and the completion.
    expect(view?.title).toBe("Water the plants every morning");
    expect(view?.done).toBe(true);
    // The record wins everything the note cannot hold.
    expect(view?.when).toBe("2026-09-14");
    expect(view?.deadline).toBe("2026-09-20");
    expect(view?.category).toBe("Home");
  });

  it("carries no task state through duplicatePage", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await garden(s);

    const copy = await s.duplicatePage(pageId);

    // The anchor lives in the record, never in the markdown, so a copied page
    // is a page of ordinary checkboxes by construction.
    expect(s.allTasks()).toHaveLength(1);
    expect(s.getTask(taskId)?.page).toBe(pageId);
    expect(s.tasksForPage(copy.id)).toEqual([]);
  });
});

/** What a visitor's write may do to a task, and the much longer list of what
 *  it may not. A share link is the widest surface Brain has, so the negatives
 *  are the assertions that matter here. */
describe("a share visitor and the reconcile", () => {
  const shared = (s: Store, id: string) => s.getTask(id);

  it("lets a visitor's tick flip done and attribute it, and nothing else", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: TICKED_BODY,
      expectedRev: rev,
      visitorName: "Ada",
    });

    expect(shared(s, taskId)?.done).toBe(true);
    const meta = (await s.readPage(pageId)).meta;
    expect(meta.updatedBy).toBe("visitor");
    expect(meta.updatedByName).toBe("Ada");
  });

  it("changes no when, deadline or category on any visitor write", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: TICKED_BODY,
      expectedRev: rev,
      visitorName: "Ada",
    });

    const view = shared(s, taskId);
    expect(view?.when).toBe("2026-09-14");
    expect(view?.deadline).toBe("2026-09-20");
    expect(view?.category).toBe("Home");
    expect(view?.repeat).toBeUndefined();
  });

  it("detaches a task whose line the visitor deleted, and creates no task", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: "A note about the garden.",
      expectedRev: rev,
      visitorName: "Ada",
    });

    expect(shared(s, taskId)?.detachedAt).toBeDefined();
    expect(shared(s, taskId)?.page).toBe(pageId);
    expect(s.allTasks()).toHaveLength(1);
  });

  it("creates no task from a checkbox line a visitor typed", async () => {
    const { s, rootId, pageId, rev, shareVersion } = await sharedGarden();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: `${BASE_BODY}\n\n- [ ] And one the visitor added`,
      expectedRev: rev,
      visitorName: "Ada",
    });

    // A task exists after the gesture and never because a checkbox was typed,
    // and a visitor has no gesture.
    expect(s.allTasks()).toHaveLength(1);
  });

  it("deletes no task, whatever the visitor writes", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: "",
      expectedRev: rev,
      visitorName: "Ada",
    });

    expect(s.getTask(taskId)).not.toBeNull();
    expect(s.getTask(taskId)?.detachedAt).toBeDefined();
  });
});

/** Resolution 6: a linked task is completed and reopened through its note. */
describe("completing a linked task from Tasks", () => {
  async function linkedGarden() {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(page.id, BASE_BODY, undefined, "me");
    const [line] = parseTaskLines(written.markdown);
    const task = await s.createTask({
      title: line.normalized,
      page: page.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    });
    return { s, root, pageId: page.id, taskId: task.id };
  }

  it("ticks the note's checkbox rather than the record's done", async () => {
    const { s, root, pageId, taskId } = await linkedGarden();

    const done = await s.updateTask(taskId, { done: true });

    expect(done.done).toBe(true);
    expect((await s.readPage(pageId)).markdown).toContain("- [x] Water the plants");
    const raw = await readTaskFile(root, taskId);
    // The note answers "is it done". The record holds only the instant, which
    // the note cannot carry and the Logbook orders on.
    expect(raw).not.toContain("done:");
    expect(raw).toContain("doneAt:");
    expect(done.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("unticks it back, and clears the instant", async () => {
    const { s, root, pageId, taskId } = await linkedGarden();
    await s.updateTask(taskId, { done: true });

    const reopened = await s.updateTask(taskId, { done: false });

    expect(reopened.done).toBe(false);
    expect(reopened.doneAt).toBeUndefined();
    expect((await s.readPage(pageId)).markdown).toContain("- [ ] Water the plants");
    expect(await readTaskFile(root, taskId)).not.toContain("doneAt:");
  });

  it("refuses to carry a schedule in the same call", async () => {
    const { s, taskId } = await linkedGarden();

    // Two files for two unrelated reasons under one result is how a caller
    // learns neither happened when one of them fails.
    await expect(
      s.updateTask(taskId, { done: true, when: "2026-09-20" }),
    ).rejects.toThrow(/when/);
  });

  it("detaches and then owns the completion when the line went first", async () => {
    const { s, root, pageId, taskId } = await linkedGarden();
    // The Logbook was drawn, then the line was deleted in another tab.
    await s.writePage(pageId, "A note about the garden.", undefined, "me");

    const done = await s.updateTask(taskId, { done: true });

    expect(done.done).toBe(true);
    expect(done.detachedAt).toBeDefined();
    expect(await readTaskFile(root, taskId)).toContain("done: true");
  });

  it("leaves an unlinked task on its own path", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({ title: "Water the plants" });

    const done = await s.updateTask(created.id, { done: true });

    expect(done.done).toBe(true);
    expect(await readTaskFile(root, created.id)).toContain("done: true");
  });
});

describe("what a reconcile does not write", () => {
  it("leaves the record file alone when a page edit moved nothing about the task", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(page.id, BASE_BODY, undefined, "me");
    const [line] = parseTaskLines(written.markdown);
    const task = await s.createTask({
      title: line.normalized,
      page: page.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    });
    const before = await readTaskFile(root, task.id);

    // A paragraph below the line. The anchor, the title and the checkbox are
    // all where they were.
    await s.writePage(page.id, `${BASE_BODY}\nAnd another sentence.`, undefined, "me");

    // Byte for byte, `updated` included: opening and saving a note must not
    // rewrite every task under it, or every save is a task commit too.
    expect(await readTaskFile(root, task.id)).toBe(before);
  });

  it("creates nothing from a checkbox the owner typed", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    await s.writePage(page.id, BASE_BODY, undefined, "me");

    await s.writePage(page.id, `${BASE_BODY}\n- [ ] And a new one`, undefined, "me");

    // No task exists until the gesture.
    expect(s.allTasks()).toEqual([]);
  });
});
