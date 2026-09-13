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
 *  RED ON PURPOSE, and skipped so the rest of `lib/store` stays green for the
 *  agents working beside this branch. Task 3b phase 2 adds
 *  `reconcilePageTasksUnlocked` and the merge in `writePage`, then unskips
 *  this block. Phase 1 owns only `lib/tasks`.
 */

const TODAY = "2026-09-14";

/** One task line and one paragraph. Small enough that a merge failure names
 *  which rule refused rather than which byte moved. */
const BASE_BODY = "- [ ] Water the plants\n\nA note about the garden.";
const TICKED_BODY = "- [x] Water the plants\n\nA note about the garden.";

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

describe.skip("two writers and one checkbox", () => {
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
    // The merged body takes the CURRENT rev as its base, so A's next write
    // with this rev is not itself a conflict.
    expect(merged.rev).not.toBe(rev);
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
    await expect(
      s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
    ).rejects.toBeInstanceOf(RevConflictError);
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
    await expect(
      s.writePage(pageId, mine, rev, "me", undefined, BASE_BODY),
    ).rejects.toBeInstanceOf(RevConflictError);
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
    await expect(
      s.writeSharedPage({
        rootId,
        targetId: pageId,
        shareVersion,
        markdown: theirs,
        expectedRev: rev,
        expectedMarkdown: BASE_BODY,
        visitorName: "Ada",
      }),
    ).rejects.toBeInstanceOf(RevConflictError);
    expect((await s.readPage(pageId)).markdown).toBe(TICKED_BODY);
  });
});
