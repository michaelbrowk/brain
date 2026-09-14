import { describe, expect, it, vi } from "vitest";

import * as reconcileModule from "./reconcile";
import { reconcilePageTasks, type ReconcileTask } from "./reconcile";
import { parseTaskRecord, type TaskAnchor, type TaskRecord } from "./model";
import { parseTaskLines, type TaskLine } from "./task-lines";

const PAGE = "page-garden";
const OTHER_PAGE = "page-kitchen";
/** The instant the caller hands in. Nothing in this module reads a clock, so
 *  every detach below is stamped with exactly this value. */
const AT = "2026-09-14T08:15:00.000Z";

const BASE = {
  created: "2026-09-13T09:00:00.000Z",
  updated: "2026-09-13T09:00:00.000Z",
};

const NOTE = "# Garden\n\n- [ ] Water the plants\n- [ ] Feed the cat\n";

/** An anchor as it was minted: off a line of the page as it then stood. */
function anchorOf(line: TaskLine): TaskAnchor {
  return {
    text: line.normalized,
    hash: line.hash,
    ordinal: line.ordinal,
    line: line.index,
  };
}

function lineOf(markdown: string, normalized: string, ordinal = 0): TaskLine {
  const found = parseTaskLines(markdown).filter(
    (line) => line.normalized === normalized,
  )[ordinal];
  if (!found) throw new Error(`no line ${JSON.stringify(normalized)} in the fixture`);
  return found;
}

function linked(
  id: string,
  anchor: TaskAnchor,
  over: Partial<TaskRecord> = {},
  done = false,
): ReconcileTask {
  return {
    task: { ...BASE, id, title: anchor.text, page: PAGE, anchor, ...over },
    done,
  };
}

describe("reconciling a page's tasks against its lines", () => {
  const plants = lineOf(NOTE, "Water the plants");
  const cat = lineOf(NOTE, "Feed the cat");

  it("leaves a record alone when its line did not move and was not touched", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    expect(result.rebound).toHaveLength(1);
    const [bound] = result.rebound;
    expect(bound.id).toBe("task-alpha");
    expect(bound.index).toBe(0);
    expect(bound.anchor).toEqual(anchorOf(plants));
    expect(bound.anchorChanged).toBe(false);
    expect(bound.titleChanged).toBe(false);
    expect(bound.doneChanged).toBe(false);
    expect(bound.doneAt).toBeUndefined();
    // Nothing stored changed, so the leaf must not rewrite `_tasks/<id>.md`.
    expect(bound.anchorOrTitleChanged).toBe(false);
    expect(bound.recordChanged).toBe(false);
    expect(result.unclaimedLines).toEqual([1]);
  });

  it("refreshes both ordinal and line when the copy above the line goes", () => {
    // The record was the second of two identical lines and the first is gone,
    // so the ordinal moves as well as the line. A fixture that only moved the
    // line would stay green with the ordinal refresh dropped.
    const twice =
      "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants\n- [ ] Feed the cat\n";
    const second = parseTaskLines(twice)[1];
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [linked("task-alpha", anchorOf(second))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    const [bound] = result.rebound;
    expect(bound.index).toBe(0);
    expect(bound.anchor.ordinal).toBe(0);
    expect(bound.anchor.line).toBe(2);
    expect(bound.anchorChanged).toBe(true);
    expect(bound.anchorOrTitleChanged).toBe(true);
    expect(bound.recordChanged).toBe(true);
    // The text did not change, so neither did the title cache.
    expect(bound.title).toBe("Water the plants");
    expect(bound.titleChanged).toBe(false);
  });

  it("rebinds an edited line above the threshold and refreshes the title cache", () => {
    const edited = "# Garden\n\n- [ ] Water the plants today\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(edited),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    const [bound] = result.rebound;
    expect(bound.anchor.text).toBe("Water the plants today");
    expect(bound.anchor.hash).toBe(lineOf(edited, "Water the plants today").hash);
    expect(bound.title).toBe("Water the plants today");
    expect(bound.titleChanged).toBe(true);
    expect(bound.recordChanged).toBe(true);
  });

  it("detaches below the threshold, stamping the caller's instant", () => {
    const replaced = "# Garden\n\n- [ ] Call the dentist\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(replaced),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual([]);
    expect(result.detached).toHaveLength(1);
    const [gone] = result.detached;
    expect(gone.id).toBe("task-alpha");
    expect(gone.detachedAt).toBe(AT);
    expect(gone.reason).toBe("line-gone");
    expect(gone.done).toBe(false);
    expect(gone.doneAt).toBeUndefined();
    // The decision carries neither `page` nor `anchor`: a detach keeps both
    // unchanged, so the leaf writes the record's own through untouched. The
    // store test is where that pass-through is asserted.
    expect(result.unclaimedLines).toEqual([0, 1]);
  });

  it("hands a detaching record the done it last read off the checkbox", () => {
    const emptied = "# Garden\n\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(emptied),
      tasks: [linked("task-alpha", anchorOf(plants), {}, true)],
      at: AT,
    });

    const [gone] = result.detached;
    expect(gone.done).toBe(true);
    // Or the task comes back from disk with `done` undefined, which reads as
    // reopened, and a finished task reappears in Today.
    expect(gone.doneAt).toBe(AT);
  });

  it("keeps a doneAt the record already carried rather than restamping it", () => {
    const emptied = "# Garden\n\n- [ ] Feed the cat\n";
    const earlier = "2026-09-13T21:04:55.108Z";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(emptied),
      tasks: [linked("task-alpha", anchorOf(plants), { doneAt: earlier }, true)],
      at: AT,
    });

    expect(result.detached[0].doneAt).toBe(earlier);
    expect(result.detached[0].detachedAt).toBe(AT);
  });

  it("produces a detach the record schema accepts, all three fields together", () => {
    const emptied = "# Garden\n\n- [ ] Feed the cat\n";
    const entry = linked("task-alpha", anchorOf(plants), {}, true);
    const [gone] = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(emptied),
      tasks: [entry],
      at: AT,
    }).detached;

    const parsed = parseTaskRecord({
      ...entry.task,
      detachedAt: gone.detachedAt,
      done: gone.done,
      ...(gone.doneAt === undefined ? {} : { doneAt: gone.doneAt }),
      updated: AT,
    });
    expect(parsed.ok).toBe(true);
  });

  it("gives a tick the write's instant, and calls that a stored change", () => {
    const ticked = "# Garden\n\n- [x] Water the plants\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(ticked),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    const [bound] = result.rebound;
    expect(bound.done).toBe(true);
    expect(bound.doneChanged).toBe(true);
    expect(bound.doneAt).toBe(AT);
    // `done` is not stored for a linked task, but its instant is: the note
    // holds no timestamp, and a completion without one sits at the foot of the
    // Logbook under no header. The record file is written.
    expect(bound.anchorOrTitleChanged).toBe(false);
    expect(bound.recordChanged).toBe(true);
  });

  it("clears the instant on an untick, and calls that a stored change too", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [
        linked("task-alpha", anchorOf(plants), { doneAt: "2026-09-13T21:04:55.108Z" }, true),
      ],
      at: AT,
    });

    const [bound] = result.rebound;
    expect(bound.done).toBe(false);
    expect(bound.doneChanged).toBe(true);
    expect(bound.doneAt).toBeUndefined();
    expect(bound.recordChanged).toBe(true);
  });

  it("leaves a completion that was already recorded where it was", () => {
    // Still ticked, and the instant is the one the earlier write stamped. A
    // reconcile that restamped it would move a finished task to today's
    // Logbook every time somebody saved the note.
    const ticked = "# Garden\n\n- [x] Water the plants\n- [ ] Feed the cat\n";
    const earlier = "2026-09-13T21:04:55.108Z";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(ticked),
      tasks: [linked("task-alpha", anchorOf(plants), { doneAt: earlier }, true)],
      at: AT,
    });

    const [bound] = result.rebound;
    expect(bound.doneAt).toBe(earlier);
    expect(bound.doneChanged).toBe(false);
    expect(bound.recordChanged).toBe(false);
  });

  it("applies a tick and a text edit on one line together", () => {
    const both = "# Garden\n\n- [x] Water the plants today\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(both),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    const [bound] = result.rebound;
    expect(bound.title).toBe("Water the plants today");
    expect(bound.titleChanged).toBe(true);
    expect(bound.done).toBe(true);
    expect(bound.doneAt).toBe(AT);
    expect(bound.recordChanged).toBe(true);
  });

  it("follows a line that was indented under another, hash and all", () => {
    // `parseTaskLines` trims the indent, so nesting a line changes neither its
    // text nor its hash and the anchor survives at step 2.
    const nested = "# Garden\n\n- [ ] Feed the cat\n  - [ ] Water the plants\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(nested),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    expect(result.rebound[0].index).toBe(1);
    expect(result.rebound[0].anchor.hash).toBe(plants.hash);
    expect(result.rebound[0].titleChanged).toBe(false);
  });

  it("detaches when the checkbox syntax is taken off the line", () => {
    // `- [ ] x` becomes `- x`, so the line leaves `parseTaskLines` and there
    // is nothing left to resolve against. The spec has no row for this; the
    // nearest is "the line is deleted from the note", and this is that.
    const plain = "# Garden\n\n- Water the plants\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(plain),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.rebound).toEqual([]);
    expect(result.detached[0].reason).toBe("line-gone");
  });

  it("gives a duplicated line's task to the first line in document order", () => {
    const twice = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(twice),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.rebound[0].index).toBe(0);
    expect(result.rebound[0].anchor.line).toBe(2);
    // The later duplicate is an ordinary checkbox. No task is created for it.
    expect(result.unclaimedLines).toEqual([1]);
  });

  /** Review finding 16. Two records anchored to one line is what a copied task
   *  record or a re-imported page produces. One line takes at most one record:
   *  the exact match goes to the first record in walk order, and the second is
   *  left to the similarity pass over what nobody claimed. */
  it("never lets two records land on one line", () => {
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants weekly\n";
    const shared = anchorOf(plants);
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(note),
      tasks: [linked("task-alpha", shared), linked("task-beta", { ...shared })],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual([
      "task-alpha",
      "task-beta",
    ]);
    // The exact match, then the neighbour that scores above the threshold.
    expect(result.rebound.map((bound) => bound.index)).toEqual([0, 1]);
    expect(result.detached).toEqual([]);
    expect(result.unclaimedLines).toEqual([]);
  });

  it("detaches the second of two records on one line when nothing else is close", () => {
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Call the dentist\n";
    const shared = anchorOf(plants);
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(note),
      tasks: [linked("task-alpha", shared), linked("task-beta", { ...shared })],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual(["task-alpha"]);
    expect(result.detached.map((gone) => [gone.id, gone.reason])).toEqual([
      ["task-beta", "line-gone"],
    ]);
    // The dentist line is somebody's ordinary checkbox, not a task's.
    expect(result.unclaimedLines).toEqual([1]);
  });

  /** The review's C1, both halves. A single-pass walk let the record whose
   *  line was DELETED reach its similarity step first and take the line of a
   *  record that had not been touched, rewriting its own title to match. The
   *  untouched record then detached, and the next tick on that line landed on
   *  the wrong task. Which record it happened to depended on which line sat
   *  higher. An exact match resolves before anything guesses. */
  it("leaves an untouched line with its own record when a similar line above it goes", () => {
    const before =
      "# Garden\n\n- [ ] Water the plants daily\n- [ ] Water the plants\n";
    const lines = parseTaskLines(before);
    const after = "# Garden\n\n- [ ] Water the plants\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(after),
      tasks: [
        linked("task-alpha", anchorOf(lines[0])),
        linked("task-beta", anchorOf(lines[1])),
      ],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual(["task-beta"]);
    expect(result.rebound[0].index).toBe(0);
    // The survivor's record keeps its own title: nobody edited that line.
    expect(result.rebound[0].titleChanged).toBe(false);
    expect(result.detached.map((gone) => [gone.id, gone.reason])).toEqual([
      ["task-alpha", "line-gone"],
    ]);
  });

  it("puts a tick on that line on the record that owns it", () => {
    const before =
      "# Garden\n\n- [ ] Water the plants daily\n- [ ] Water the plants\n";
    const lines = parseTaskLines(before);
    const after = "# Garden\n\n- [x] Water the plants\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(after),
      tasks: [
        linked("task-alpha", anchorOf(lines[0])),
        linked("task-beta", anchorOf(lines[1])),
      ],
      at: AT,
    });

    expect(result.rebound.map((bound) => [bound.id, bound.done])).toEqual([
      ["task-beta", true],
    ]);
    expect(result.detached.map((gone) => [gone.id, gone.done])).toEqual([
      ["task-alpha", false],
    ]);
  });

  it("rebinds a line that was cut and pasted further down the same page", () => {
    const moved =
      "# Garden\n\n- [ ] Feed the cat\n\nA paragraph.\n\n- [ ] Water the plants\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(moved),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    expect(result.rebound[0].anchor.line).toBe(6);
    expect(result.rebound[0].titleChanged).toBe(false);
    expect(result.rebound[0].anchorChanged).toBe(true);
  });

  it("gives the survivor to the first record when the first of two identical lines goes", () => {
    const twice = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants\n";
    const lines = parseTaskLines(twice);
    const after = "# Garden\n\n- [ ] Water the plants\n";
    const entries = [
      linked("task-alpha", anchorOf(lines[0]), { created: "2026-09-10T09:00:00.000Z" }),
      linked("task-beta", anchorOf(lines[1]), { created: "2026-09-01T09:00:00.000Z" }),
    ];
    const forwards = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(after),
      tasks: entries,
      at: AT,
    });
    const backwards = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(after),
      tasks: [...entries].reverse(),
      at: AT,
    });

    expect(forwards.rebound.map((bound) => bound.id)).toEqual(["task-alpha"]);
    expect(forwards.detached.map((gone) => [gone.id, gone.reason])).toEqual([
      ["task-beta", "line-gone"],
    ]);
    // Document order decides before `created` does, so the younger record that
    // sat higher keeps the line whichever way the records arrive.
    expect(backwards).toEqual(forwards);
  });

  it("gives one line to the older of two records anchored to it, not the earlier id", () => {
    // The only fixture that reaches the `created` tie-break: same line, same
    // ordinal, so the sort falls through to it. The ids are ordered against
    // the creation dates, so an id-only tie-break would answer differently.
    const shared = anchorOf(plants);
    const older = linked("task-zulu", { ...shared }, {
      created: "2026-09-01T09:00:00.000Z",
    });
    const younger = linked("task-alpha", { ...shared }, {
      created: "2026-09-10T09:00:00.000Z",
    });
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Call the dentist\n";

    for (const tasks of [[older, younger], [younger, older]]) {
      const result = reconcilePageTasks({
        page: PAGE,
        lines: parseTaskLines(note),
        tasks,
        at: AT,
      });
      expect(result.rebound.map((bound) => bound.id)).toEqual(["task-zulu"]);
      expect(result.detached.map((gone) => gone.id)).toEqual(["task-alpha"]);
    }
  });

  it("rebinds a record whose identical twin is still on the page, when its own line was edited", () => {
    // Two records on two identical lines, the second edited. The second
    // record's own line is right there, unclaimed and well above the
    // threshold, and a guess-blocking rule used to detach it anyway.
    const twice = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants\n";
    const lines = parseTaskLines(twice);
    const edited =
      "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants twice a week\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(edited),
      tasks: [
        linked("task-alpha", anchorOf(lines[0])),
        linked("task-beta", anchorOf(lines[1])),
      ],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    expect(result.rebound.map((bound) => [bound.id, bound.index])).toEqual([
      ["task-alpha", 0],
      ["task-beta", 1],
    ]);
    expect(result.rebound[1].title).toBe("Water the plants twice a week");
  });

  it("still gives two records their own line when the page has two of them", () => {
    const twice = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants\n";
    const lines = parseTaskLines(twice);
    const result = reconcilePageTasks({
      page: PAGE,
      lines,
      tasks: [
        linked("task-alpha", anchorOf(lines[0])),
        linked("task-beta", anchorOf(lines[1])),
      ],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    expect(result.rebound.map((bound) => [bound.id, bound.index])).toEqual([
      ["task-alpha", 0],
      ["task-beta", 1],
    ]);
    expect(result.unclaimedLines).toEqual([]);
  });

  it("reads the same whichever order the records arrive in", () => {
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Call the dentist\n";
    const shared = anchorOf(plants);
    const forwards = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(note),
      tasks: [linked("task-alpha", shared), linked("task-beta", { ...shared })],
      at: AT,
    });
    const backwards = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(note),
      tasks: [linked("task-beta", { ...shared }), linked("task-alpha", shared)],
      at: AT,
    });

    expect(backwards).toEqual(forwards);
  });

  it("leaves an already detached record out of the pass entirely", () => {
    // It keeps `page` and `anchor`, so the page's own enumeration hands it
    // over. Resolving it again would let it claim a line that a still-linked
    // record needs, and flip a `done` it now owns.
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [
        linked(
          "task-beta",
          anchorOf(plants),
          { detachedAt: "2026-09-13T12:00:00.000Z", done: true },
          true,
        ),
        linked("task-alpha", anchorOf(plants)),
      ],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual(["task-alpha"]);
    expect(result.rebound[0].index).toBe(0);
    expect(result.detached).toEqual([]);
  });

  it("detaches a record that names the page but carries no anchor", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [{ task: { ...BASE, id: "task-alpha", title: "Orphan", page: PAGE }, done: false }],
      at: AT,
    });

    expect(result.detached).toHaveLength(1);
    expect(result.detached[0].reason).toBe("no-anchor");
    expect(result.rebound).toEqual([]);
    expect(result.unclaimedLines).toEqual([0, 1]);
  });

  it("ignores a record anchored to another page, rather than binding it here", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [
        linked("task-alpha", anchorOf(plants), { page: OTHER_PAGE }),
        linked("task-beta", anchorOf(cat)),
      ],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual(["task-beta"]);
    expect(result.detached).toEqual([]);
    expect(result.unclaimedLines).toEqual([0]);
  });

  it("keeps the record's own title when the line is the empty one the template writes", () => {
    const template = "# Garden\n\n- [ ] <br />\n";
    const empty = parseTaskLines(template)[0];
    const result = reconcilePageTasks({
      page: PAGE,
      lines: [empty],
      tasks: [linked("task-alpha", { ...anchorOf(empty), text: "" }, { title: "Untitled" })],
      at: AT,
    });

    // A record's title has a minimum length, so an empty line cannot become
    // one. The cache holds its last real value instead.
    expect(result.rebound[0].title).toBe("Untitled");
    expect(result.rebound[0].titleChanged).toBe(false);
  });

  it("keeps a rebind inside the length the record schema accepts", () => {
    // `boundedText` and `taskAnchorSchema.text` both stop at 2000 characters.
    // A line that grows past it used to rebind cleanly and mint a title the
    // schema refuses, which `writeTaskFile` would write and the next index
    // load would skip, taking the task out of every list.
    const long = "a".repeat(1917);
    const grown = `# Garden\n\n- [ ] ${long}${"b".repeat(200)}\n`;
    const wasThere = parseTaskLines(`# Garden\n\n- [ ] ${long}\n`)[0];
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(grown),
      tasks: [linked("task-alpha", anchorOf(wasThere))],
      at: AT,
    });

    const [bound] = result.rebound;
    expect(bound.title.length).toBe(2000);
    expect(bound.anchor.text.length).toBe(2000);
    expect(
      parseTaskRecord({
        ...BASE,
        id: "task-alpha",
        title: bound.title,
        page: PAGE,
        anchor: bound.anchor,
      }).ok,
    ).toBe(true);
  });

  it("reports a page with no task lines as a page of detached records", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: [],
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.page).toBe(PAGE);
    expect(result.detached.map((gone) => gone.id)).toEqual(["task-alpha"]);
    expect(result.unclaimedLines).toEqual([]);
  });

  it("mutates nothing it was handed", () => {
    const lines = parseTaskLines(NOTE);
    const entry = linked("task-alpha", anchorOf(plants));
    const before = structuredClone({ lines, entry });
    reconcilePageTasks({ page: PAGE, lines, tasks: [entry], at: AT });
    expect({ lines, entry }).toEqual(before);
  });

  it("reads no clock, in every export of reconcile.ts", () => {
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants weekly\n";
    const shared = anchorOf(plants);
    const exercised: Record<string, () => unknown> = {
      reconcilePageTasks: () => [
        // Every branch of the walk, because a clock read on a line no case
        // enters hides from the trap. A clean rebind and a tick; a step 2
        // move; a step 3 rebind; the second of two records on one line; a
        // detach carrying a completion; the no-anchor detach; and a page with
        // nothing on it.
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines("# Garden\n\n- [x] Water the plants\n"),
          tasks: [linked("task-alpha", anchorOf(plants))],
          at: AT,
        }),
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines("# Garden\n\nA line.\n\n- [ ] Water the plants\n"),
          tasks: [linked("task-alpha", anchorOf(plants))],
          at: AT,
        }),
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines("# Garden\n\n- [ ] Water the plants today\n"),
          tasks: [linked("task-alpha", anchorOf(plants))],
          at: AT,
        }),
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines(note),
          tasks: [linked("task-alpha", shared), linked("task-beta", { ...shared })],
          at: AT,
        }),
        reconcilePageTasks({
          page: PAGE,
          lines: [],
          tasks: [linked("task-alpha", anchorOf(plants), {}, true)],
          at: AT,
        }),
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines(NOTE),
          tasks: [
            { task: { ...BASE, id: "task-beta", title: "Orphan", page: PAGE }, done: false },
          ],
          at: AT,
        }),
        reconcilePageTasks({ page: PAGE, lines: [], tasks: [], at: AT }),
      ],
    };

    // A new export has to be added above, or this fails before the trap runs.
    const callable = Object.entries(reconcileModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(Object.keys(exercised).sort()).toEqual(callable.sort());

    const boom = () => {
      throw new Error("lib/tasks must not read the clock");
    };
    const trap = function TrappedDate() {
      boom();
    } as unknown as DateConstructor;
    Object.assign(trap, { now: boom, parse: boom, UTC: boom });

    let ran = 0;
    let thrown: unknown = null;
    let trapArmed = false;
    vi.stubGlobal("Date", trap);
    try {
      try {
        new Date();
      } catch {
        trapArmed = true;
      }
      for (const run of Object.values(exercised)) {
        run();
        ran += 1;
      }
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(trapArmed).toBe(true);
    expect(thrown).toBeNull();
    expect(ran).toBe(Object.keys(exercised).length);
  });
});
