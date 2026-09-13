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
    // Nothing stored changed, so the leaf must not rewrite `_tasks/<id>.md`.
    expect(bound.recordChanged).toBe(false);
    expect(result.unclaimedLines).toEqual([1]);
  });

  it("refreshes ordinal and line when the line moves down the page", () => {
    const moved = "# Garden\n\nA paragraph.\n\n- [ ] Water the plants\n- [ ] Feed the cat\n";
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(moved),
      tasks: [linked("task-alpha", anchorOf(plants))],
      at: AT,
    });

    expect(result.detached).toEqual([]);
    const [bound] = result.rebound;
    expect(bound.anchor).toEqual(anchorOf(lineOf(moved, "Water the plants")));
    expect(bound.anchor.line).toBe(4);
    expect(bound.anchorChanged).toBe(true);
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

  it("detaches below the threshold, keeping page and anchor and stamping the caller's instant", () => {
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
    // The decision says nothing about `page` and `anchor`, because a detach
    // keeps both and the leaf writes them through untouched.
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

  it("flips done off the checkbox without calling it a stored change", () => {
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
    // `done` is not stored for a linked task, so a tick alone must not rewrite
    // the record file and must not earn a Git commit of its own.
    expect(bound.recordChanged).toBe(false);
  });

  it("unticks the same way round", () => {
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(NOTE),
      tasks: [linked("task-alpha", anchorOf(plants), {}, true)],
      at: AT,
    });

    expect(result.rebound[0].done).toBe(false);
    expect(result.rebound[0].doneChanged).toBe(true);
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

  /** Review finding 16. Two records anchored to one line is what a copied
   *  task record or a re-imported page produces. The resolver's step 1 skips
   *  a claimed line, and without this rule the second record falls through to
   *  step 3 and rebinds to whatever neighbour scores above 0.6, rewriting its
   *  own text and hash so the wrong guess is exact by the next reconcile. */
  it("lets one record follow the line and detaches the other, with no drift to a neighbour", () => {
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants weekly\n";
    const shared = anchorOf(plants);
    const result = reconcilePageTasks({
      page: PAGE,
      lines: parseTaskLines(note),
      tasks: [
        linked("task-alpha", shared),
        linked("task-beta", { ...shared }),
      ],
      at: AT,
    });

    expect(result.rebound.map((bound) => bound.id)).toEqual(["task-alpha"]);
    expect(result.rebound[0].index).toBe(0);
    expect(result.detached.map((gone) => gone.id)).toEqual(["task-beta"]);
    expect(result.detached[0].reason).toBe("line-taken");
    // The neighbour scores well above the rebind threshold, and is still an
    // ordinary checkbox afterwards.
    expect(result.unclaimedLines).toEqual([1]);
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
    const note = "# Garden\n\n- [ ] Water the plants\n- [ ] Water the plants weekly\n";
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
        // A clean rebind, a move, a fuzzy rebind, a detach, the claimed-line
        // rule and an empty page: every branch that could reach for a clock.
        reconcilePageTasks({
          page: PAGE,
          lines: parseTaskLines(NOTE),
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
