import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "./store";
import { brainEvents } from "./events";
import { serializeLivePage } from "./frontmatter";
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

/** The same page with the task line BELOW the prose, which is the half of the
 *  geometry the shared head cannot carry: a tick under the client's edit has
 *  to come back through the shared tail. */
const BELOW_BODY = "A note about the garden.\n\n- [ ] Water the plants";
const BELOW_TICKED = "A note about the garden.\n\n- [x] Water the plants";

/** One task record as the file holds it. */
async function readTaskFile(root: string, id: string): Promise<string> {
  return fs.readFile(path.join(root, "_tasks", `${id}.md`), "utf8");
}

async function tmpStore(
  options: { publicOrigin?: string | null; tasksEnabled?: () => boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-reconcile-"));
  const s = new Store(root, options);
  await s.init();
  return { s, root };
}

/** A page holding one unticked task line, and a task linked to that line. */
async function gardenPage(s: Store, body: string = BASE_BODY) {
  const page = await s.createPage(null, "Garden");
  const written = await s.writePage(page.id, body, undefined, "me");
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
  write: () => Promise<unknown>,
  expected: { currentRev: string; expectedRev: string },
): Promise<void> {
  // A thunk, not a promise: a promise built beside an `await` in the same
  // argument list rejects before anything has attached a handler, which Node
  // reports as an unhandled rejection and vitest fails the file over.
  await expect(write()).rejects.toBeInstanceOf(RevConflictError);
  await expect(write()).rejects.toMatchObject({
    name: "RevConflictError",
    message: "rev conflict",
    currentRev: expected.currentRev,
    expectedRev: expected.expectedRev,
  });
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

    // The whole body, not two fragments of it: a merge that kept both and
    // dropped a blank line, reordered them or trimmed the end would satisfy
    // any pair of `toContain`s.
    expect(merged.markdown).toBe(`${TICKED_BODY}\n\nA paragraph A typed.`);
    expect((await s.readPage(pageId)).markdown).toBe(merged.markdown);
    expect(viewOf(s, taskId).done).toBe(true);
    // The merged body takes the CURRENT rev as its base, which is what makes
    // A's next write with the rev it was handed an ordinary write and not a
    // second conflict. No `expectedMarkdown` on the follow-up, or
    // `bodyStillMatches` answers first and the rev is never read: with one,
    // the case passes for any rev at all.
    const after = await s.writePage(
      pageId,
      `${merged.markdown}\n\nAnd one more line.`,
      merged.rev,
      "me",
    );
    expect(after.markdown).toContain("And one more line.");
    // And the same write with a rev that is not the merged one is refused, so
    // the line above cannot pass by the rev being ignored.
    await expect(
      s.writePage(pageId, "Something else entirely.", rev, "me"),
    ).rejects.toBeInstanceOf(RevConflictError);
  });

  it("accepts A's edit with B's tick on the line below it, serializer newline and all", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId, rev } = await gardenPage(s, BELOW_BODY);
    await s.writePage(pageId, BELOW_TICKED, rev, "me");

    // What a real client sends. Milkdown's serializer ends every body with a
    // newline, and the baseline the client was handed is stored trimmed
    // (`lib/autosave.ts` canonicalises it). So `mine` carries one line the
    // base does not, and comparing the two from the end finds nothing shared:
    // the tick lands below the edit, where only the shared tail can carry it.
    const mine = "A note about the garden, watered twice weekly.\n\n- [ ] Water the plants\n";
    const merged = await s.writePage(pageId, mine, rev, "me", undefined, BELOW_BODY);

    expect(merged.markdown).toBe(
      "A note about the garden, watered twice weekly.\n\n- [x] Water the plants",
    );
    expect((await s.readPage(pageId)).markdown).toBe(merged.markdown);
    expect(viewOf(s, taskId).done).toBe(true);
  });

  it("refuses A with a 409 when A rewrote the ticked line", async () => {
    const { s } = await tmpStore();
    const { pageId, rev } = await gardenPage(s);
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    // The tick and the edit are on one line, and no rule can say which of the
    // two a person meant. A 409 and two visible versions is the honest answer.
    const mine = "- [ ] Water the plants twice\n\nA note about the garden.";
    const currentRev = (await s.readPage(pageId)).rev;
    await expectSameConflict(
      () => s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
      { currentRev, expectedRev: rev },
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
    const currentRev = (await s.readPage(pageId)).rev;
    await expectSameConflict(
      () => s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
      { currentRev, expectedRev: rev },
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

    expect(merged.markdown).toBe(`${TICKED_BODY}\n\nA paragraph A typed.`);
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

    expect(merged.markdown).toBe(
      `${TICKED_BODY}\n\nA paragraph the visitor typed.`,
    );
    expect(merged.meta.updatedBy).toBe("visitor");
    expect(merged.meta.updatedByName).toBe("Ada");
    expect(viewOf(s, taskId).done).toBe(true);
  });

  it("keeps the shared path's 409 where the owner path has one", async () => {
    const { s, rootId, pageId, rev, shareVersion } = await sharedGarden();
    await s.writePage(pageId, TICKED_BODY, rev, "me");

    const theirs = "- [ ] Water the plants twice\n\nA note about the garden.";
    const currentRev = (await s.readPage(pageId)).rev;
    await expectSameConflict(
      () =>
        s.writeSharedPage({
          rootId,
          targetId: pageId,
          shareVersion,
          markdown: theirs,
          expectedRev: rev,
          expectedMarkdown: BASE_BODY,
          visitorName: "Ada",
        }),
      { currentRev, expectedRev: rev },
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

  it("detaches a line cut from one note and pasted into another, and binds nothing there", async () => {
    // SPEC ROW 137, DEFERRED. The row says `page` is rewritten and the target's
    // reconcile binds the record. Nothing on this branch rewrites `page`:
    // `reconcilePageTasks` only ever considers records that already name the
    // page it is reconciling. So a cut and paste across notes is a detach, the
    // task keeps its schedule and its last known title, and the person
    // re-promotes the line in its new home. This pins that answer so the
    // deferral is a decision somebody made rather than a gap nobody noticed;
    // the day the rebind is built, this test is the one that changes.
    const { s } = await tmpStore();
    const admin = await s.createPage(null, "Admin");
    const trip = await s.createPage(null, "Trip");
    const written = await s.writePage(admin.id, "- [ ] Renew the visa", undefined, "me");
    await s.writePage(trip.id, "Somewhere warm.", undefined, "me");
    const [line] = parseTaskLines(written.markdown);
    const task = await s.createTask({
      title: line.normalized,
      when: "2026-09-20",
      page: admin.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    });

    // The cut, then the paste, in the order the two saves land.
    await s.writePage(admin.id, "Nothing left here.", undefined, "me");
    await s.writePage(trip.id, "Somewhere warm.\n\n- [ ] Renew the visa", undefined, "me");

    const after = s.getTask(task.id);
    expect(after?.detachedAt).toBeDefined();
    // `page` is kept as a NAME, which is what makes the row read "line removed
    // from Admin" rather than pointing at a note that no longer holds it.
    expect(after?.page).toBe(admin.id);
    expect(after?.when).toBe("2026-09-20");
    expect(after?.title).toBe("Renew the visa");
    // And the target binds nothing: a checkbox becomes a task through the
    // gesture only, so the pasted line is an ordinary checkbox again.
    expect(s.tasksForPage(trip.id)).toHaveLength(0);
    expect(s.allTasks()).toHaveLength(1);
  });

  it("refreshes ordinal and line when the copy above the line goes", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(
      page.id,
      "- [ ] Water the plants\n- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    // Anchored to the SECOND of the two identical lines, so deleting the
    // first moves both its ordinal and its line. A fixture anchored to the
    // first would be answered by the resolver's step 1 and would read back
    // the values the record already had, whatever step 2 did.
    const second = parseTaskLines(written.markdown)[1];
    const task = await s.createTask({
      title: second.normalized,
      page: page.id,
      anchor: {
        text: second.normalized,
        hash: second.hash,
        ordinal: second.ordinal,
        line: second.index,
      },
    });
    expect(task.anchor?.ordinal).toBe(1);
    expect(task.anchor?.line).toBe(1);

    await s.writePage(
      page.id,
      "- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );

    const view = s.getTask(task.id);
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

    // The note is edited outside the store, so nothing has reconciled this
    // page since the line went. The append is the next write to reach it, and
    // it is the one that has to notice: with no reconcile on this path the
    // record stays linked to a line that is not there.
    const indexPath = path.join(s.resolve(pageId), "index.md");
    const raw = await fs.readFile(indexPath, "utf8");
    await fs.writeFile(
      indexPath,
      raw.replace("- [ ] Water the plants\n", ""),
      "utf8",
    );

    await s.appendPage(pageId, "- [ ] And a third", "me");

    expect(s.getTask(taskId)?.detachedAt).toBeDefined();
    expect(s.getTask(taskId)?.title).toBe("Water the plants");
    // And the checkbox the append itself wrote is nobody's task.
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

  it("carries the visitor's name onto the view, so the Logbook can say who ticked it", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();
    // Open, and nobody's name on it yet.
    expect(s.getTask(taskId)?.updatedByName).toBeUndefined();

    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: TICKED_BODY,
      expectedRev: rev,
      visitorName: "Ada",
    });

    // Spec row 145: the note owns a linked task's completion, so it owns who
    // answered it. Every read a row can come through carries the name.
    expect(s.getTask(taskId)?.updatedByName).toBe("Ada");
    expect(
      s
        .listLogbook(TODAY, { offsetMinutes: 0 })
        .map((entry) => entry.task.updatedByName),
    ).toEqual(["Ada"]);
    expect(
      s.pageTasks(pageId).map((task) => task.updatedByName),
    ).toEqual(["Ada"]);

    // The owner's own write takes the sentence away again: the page is no
    // longer a visitor's last word.
    await s.writePage(pageId, TICKED_BODY.replace("plants", "plants well"), undefined, "me");
    expect(s.getTask(taskId)?.updatedByName).toBeUndefined();
  });

  // A WRITE'S OWN ANSWER IS A READ TOO.
  //
  // The surface moves its rows from what a write answered rather than waiting
  // for the next list, which is what makes a reschedule land at once. So the
  // answer has to carry what a list read of the same record carries, or the row
  // loses "done by ‹name› via link" until something else invalidates the set —
  // and the Logbook, where a visitor's tick is the whole point of the sentence,
  // is exactly where the reader is looking.
  it("carries the visitor's name on the answer a patch gives back", async () => {
    const { s, rootId, pageId, taskId, rev, shareVersion } = await sharedGarden();
    await s.writeSharedPage({
      rootId,
      targetId: pageId,
      shareVersion,
      markdown: TICKED_BODY,
      expectedRev: rev,
      visitorName: "Ada",
    });
    expect(s.getTask(taskId)?.updatedByName).toBe("Ada");

    // A reschedule of the done, still-linked task. The note keeps the tick, so
    // the record stays done and the page's last writer is still the visitor.
    const answered = await s.updateTask(taskId, { when: "2026-09-15" });
    expect(answered.done).toBe(true);
    expect(answered.when).toBe("2026-09-15");
    expect(answered.updatedByName).toBe("Ada");
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

  it("leaves the structure barrier standing, so a stale tab is still refused", async () => {
    // The barrier is the page-ref nesting move's fence: that move changes the
    // rev without changing a byte of markdown, so a tab holding the old rev
    // would otherwise pass `bodyStillMatches` or the merge against a baseline
    // that is no longer the page's. It stands until a write that has SEEN the
    // moved body establishes a new one, and a tick from Tasks is not that
    // write: it passes no rev, and the tab whose completion it is has not
    // seen the move either. Clearing it here handed the next stale save a
    // silent merge.
    const { s, pageId, taskId } = await linkedGarden();
    const before = await s.readPage(pageId);
    // The move, in the one shape that matters here: same body, new rev, fence
    // up.
    await fs.writeFile(
      path.join(s.resolve(pageId), "index.md"),
      serializeLivePage(
        { ...before.meta, structureWriteBarrier: true },
        before.markdown,
      ),
    );

    await s.updateTask(taskId, { done: true });

    const after = await s.readPage(pageId);
    expect(after.markdown).toContain("- [x] Water the plants");
    expect(after.meta.structureWriteBarrier).toBe(true);
    // The stale tab, saving the body it loaded before the move.
    await expect(
      s.writePage(
        pageId,
        `${BASE_BODY}\n\nA paragraph A typed.`,
        before.rev,
        "me",
        undefined,
        BASE_BODY,
      ),
    ).rejects.toBeInstanceOf(RevConflictError);
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

/** Spec row 148, and what a note edit is allowed to cost. */
describe("a page the index no longer holds", () => {
  /** A record on disk pointing at a page id nothing in the notebook has. The
   *  folder was removed by hand, or its frontmatter stopped parsing. */
  async function orphanedTask(): Promise<{ s: Store; root: string }> {
    const { s, root } = await tmpStore();
    await fs.mkdir(path.join(root, "_tasks"), { recursive: true });
    await fs.writeFile(
      path.join(root, "_tasks", "task-orphan.md"),
      [
        "---",
        "id: task-orphan",
        "title: Water the plants",
        "when: '2026-09-14'",
        "page: page-that-is-not-here",
        "anchor:",
        "  text: Water the plants",
        "  hash: 0123456789abcdef",
        "  ordinal: 0",
        "  line: 0",
        "created: '2026-09-13T09:00:00.000Z'",
        "updated: '2026-09-13T09:00:00.000Z'",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    await s.rebuild();
    return { s, root };
  }

  it("hides its tasks exactly like a trashed page's", async () => {
    const { s } = await orphanedTask();

    expect(s.getTask("task-orphan")).not.toBeNull();
    // A row whose only action is a write to a note that is not there is worse
    // than a row that is not drawn.
    expect(s.listTasks("2026-09-14", { offsetMinutes: 0 })).toEqual([]);
    expect(s.taskPageTrashed("task-orphan")).toBe(true);
  });

  it("refuses a completion against it, rather than throwing out of the lock", async () => {
    const { s } = await orphanedTask();

    // The refusal a caller can read and a route can map, not the
    // `NotFoundError` that `this.get(pageId)` would throw from inside the
    // mutation lock.
    await expect(s.updateTask("task-orphan", { done: true })).rejects.toThrow(
      /page not found/,
    );
    expect(s.getTask("task-orphan")?.done).toBe(false);
  });

  it("keeps the record whole, because rebuild detaches nothing it did not walk", async () => {
    const { s } = await orphanedTask();

    const task = s.getTask("task-orphan");
    expect(task?.page).toBe("page-that-is-not-here");
    expect(task?.detachedAt).toBeUndefined();
    expect(task?.when).toBe("2026-09-14");
  });
});

describe("a task file that cannot be written", () => {
  it("does not take the note's save down with it", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Garden");
    const written = await s.writePage(
      page.id,
      "- [ ] Water the plants\n- [ ] Feed the cat",
      undefined,
      "me",
    );
    const lines = parseTaskLines(written.markdown);
    const broken = await s.createTask({
      title: lines[0].normalized,
      page: page.id,
      anchor: {
        text: lines[0].normalized,
        hash: lines[0].hash,
        ordinal: lines[0].ordinal,
        line: lines[0].index,
      },
    });
    const healthy = await s.createTask({
      title: lines[1].normalized,
      page: page.id,
      anchor: {
        text: lines[1].normalized,
        hash: lines[1].hash,
        ordinal: lines[1].ordinal,
        line: lines[1].index,
      },
    });

    // Somebody hand-edits one record into broken YAML. `writeTaskFile`
    // rethrows rather than overwrite it, which is the rule that protects the
    // hand edit, and which used to make every save of this page a 500.
    await fs.writeFile(
      path.join(root, "_tasks", `${broken.id}.md`),
      "---\nid: [unclosed\n---\nmy own notes\n",
      "utf8",
    );

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let said = "";
    let saved;
    try {
      saved = await s.writePage(
        page.id,
        "- [x] Water the plants\n- [x] Feed the cat",
        undefined,
        "me",
      );
      said = error.mock.calls.flat().join(" ");
    } finally {
      error.mockRestore();
    }

    // The note is the truth and it landed.
    expect(saved?.markdown).toBe("- [x] Water the plants\n- [x] Feed the cat");
    expect((await s.readPage(page.id)).markdown).toBe(
      "- [x] Water the plants\n- [x] Feed the cat",
    );
    expect(said).toContain(broken.id);
    // The broken file is still the person's, untouched.
    expect(await readTaskFile(root, broken.id)).toBe(
      "---\nid: [unclosed\n---\nmy own notes\n",
    );
    // And the other record on the same page reconciled as if nothing was wrong.
    expect(s.getTask(healthy.id)?.done).toBe(true);
    expect(await readTaskFile(root, healthy.id)).toContain("doneAt:");
  });
});

describe("the order a purge takes", () => {
  it("moves no task when the folder cannot be removed", async () => {
    const { s } = await tmpStore();
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
    await s.deletePage(page.id);

    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("EBUSY"));
    try {
      await expect(s.purgePage(page.id)).rejects.toThrow(/EBUSY/);
    } finally {
      rm.mockRestore();
    }

    // Deleting a task is the irreversible half, so it goes last. The note and
    // its line are still there, and so is the task.
    expect(s.getTask(task.id)).not.toBeNull();
    expect(s.getTask(task.id)?.detachedAt).toBeUndefined();
    expect((await s.readPage(page.id)).markdown).toBe(BASE_BODY);
  });
});

describe("the order a page write takes", () => {
  it("moves no task when the page itself cannot be written", async () => {
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

    // The page's own write fails. Reconciling first would have ticked the
    // record off a body that never reached the disk, so the note and the task
    // would disagree until something wrote the page again.
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("ENOSPC"));
    try {
      await expect(
        s.writePage(page.id, TICKED_BODY, undefined, "me"),
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      rename.mockRestore();
    }

    expect((await s.readPage(page.id)).markdown).toBe(BASE_BODY);
    expect(s.getTask(task.id)?.done).toBe(false);
    expect(await readTaskFile(root, task.id)).toBe(before);
  });
});

describe("the Tasks module off", () => {
  /** The switch is a function and not a value because the Store is a
   *  process-wide singleton with no invalidation: it has to be able to change
   *  under a live Store, which is exactly the case below. */
  async function switchableStore() {
    let tasksOn = true;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-module-off-"));
    const s = new Store(root, { tasksEnabled: () => tasksOn });
    await s.init();
    return { s, root, off: () => (tasksOn = false), on: () => (tasksOn = true) };
  }

  function recordEvents(): { types: string[]; stop: () => void } {
    const types: string[] = [];
    const listen = (event: { type: string }) => types.push(event.type);
    brainEvents.on("change", listen);
    return { types, stop: () => brainEvents.off("change", listen) };
  }

  // THE SPEC'S PROMISE, IN ONE CASE. A tick on a line that is a task changes
  // only the note: the record under `_tasks/` is not written and no task
  // event is emitted. The line was promoted BEFORE the switch went off,
  // because a line that was never a task proves nothing about the reconcile.
  it("leaves a promoted line's record byte-identical when it is ticked", async () => {
    const { s, root, off } = await switchableStore();
    const { pageId, taskId } = await gardenPage(s);
    const before = await readTaskFile(root, taskId);

    off();
    const events = recordEvents();
    try {
      await s.writePage(pageId, TICKED_BODY, undefined, "me");
    } finally {
      events.stop();
    }

    // The note carries the tick.
    expect((await s.readPage(pageId)).markdown).toContain("- [x] Water the plants");
    // The record does not, byte for byte, `updated` included.
    expect(await readTaskFile(root, taskId)).toBe(before);
    // And nothing told a surface that a task moved.
    expect(events.types).not.toContain("task");
    expect(events.types).toContain("write");
  });

  it("does not detach a task whose line the writer deleted", async () => {
    const { s, root, off } = await switchableStore();
    const { pageId, taskId } = await gardenPage(s);
    const before = await readTaskFile(root, taskId);
    off();
    await s.writePage(pageId, "A note about the garden.", undefined, "me");
    expect(await readTaskFile(root, taskId)).toBe(before);
  });

  // WHEN TASKS COMES BACK ON, the note's state is the truth for the tick.
  // Nothing replays: the next save of this note reconciles it, which is the
  // existing checkbox-aware merge rule doing what it already does.
  it("takes the note's state on the next save after the module comes back", async () => {
    const { s, off, on } = await switchableStore();
    const { pageId, taskId } = await gardenPage(s);
    off();
    await s.writePage(pageId, TICKED_BODY, undefined, "me");
    expect(viewOf(s, taskId).done).toBe(false);

    on();
    await s.writePage(pageId, `${TICKED_BODY}\nAnd another sentence.`, undefined, "me");
    expect(viewOf(s, taskId).done).toBe(true);
  });

  it("reconciles as it always did when nothing sets the option", async () => {
    const { s } = await tmpStore();
    const { pageId, taskId } = await gardenPage(s);
    await s.writePage(pageId, TICKED_BODY, undefined, "me");
    expect(viewOf(s, taskId).done).toBe(true);
  });
});
