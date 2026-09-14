// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTasksStore } from "@/components/tasks-client";
import { hashTaskText, normalizeTaskText } from "@/lib/tasks/task-lines";

import {
  PROMOTE_MENU_CLASS,
  TASK_MARK_CLASS,
  TASKS_CHANGED_EVENT,
  taskCheckbox,
} from "./task-checkbox";

/** THE GESTURE, AGAINST THE REAL EDITOR AND A STUBBED ROUTE.
 *
 *  The same mount as `task-checkbox.test.ts`: the real preset stack, because
 *  a decoration is only worth testing against the schema it attaches to. What
 *  is stubbed is the network and the clock, and nothing else. `fetch` answers
 *  the four calls the gesture makes and records every request, so the POST
 *  body is asserted rather than assumed.
 */

const PAGE = "page-groceries";
/** 09:00 local on a Sunday, so `today` and `tomorrow` are two known days. */
const NOW = new Date(2026, 8, 13, 9, 0, 0);
const TODAY = "2026-09-13";
const TOMORROW = "2026-09-14";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let tasks: Record<string, unknown>[] = [];
let category: string | null = null;
/** What POST /api/tasks answers with, so a refusal can be exercised too. */
let createAnswer: { status: number; body: Record<string, unknown> } = {
  status: 201,
  body: {},
};
/** Held POSTs, for the case where a second click arrives before the first
 *  answers. `null` means answer at once. */
let createGate: Promise<void> | null = null;
/** What PATCH /api/tasks/<id> answers with, so a refused RESCHEDULE can be
 *  exercised too: a second word pressed mid-flight reaches the route as one,
 *  and its refusal belongs to the press that made it. */
let patchAnswer: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: {},
};
/** Held PATCHes, the twin of `createGate`. A line that is already a task
 *  reschedules rather than creates, which is the commoner gesture in a note
 *  whose lines have words, and without this no case could hold one open to
 *  see what the panel does while it waits. */
let patchGate: Promise<void> | null = null;

const editors = new WeakMap<EditorView, Editor>();
const open: Editor[] = [];

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ url, method, body });

    // `?page=<id>` and nothing else: a list read hides a done, a detached or
    // an old record, and the note needs all three.
    //
    // The other shape reaching this path is not the plugin's. Its day watcher
    // shares `components/tasks-client`'s one clock, and that module asks for
    // the reader's own lists whenever the day it holds moves. Answered empty:
    // nothing here reads it.
    if (url.startsWith("/api/tasks?")) {
      if (!url.includes("page=")) return json(200, { tasks: [] });
      expect(url).toBe(`/api/tasks?page=${PAGE}`);
      return json(200, { tasks: tasks.filter((task) => task.page === PAGE) });
    }
    if (url === "/api/tasks" && method === "POST") {
      if (createGate) await createGate;
      if (createAnswer.status !== 201) return json(createAnswer.status, createAnswer.body);
      const task = {
        id: `task-${tasks.length + 1}`,
        title: body?.title,
        page: body?.page,
        anchor: body?.anchor,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        ...(body?.when !== undefined ? { when: body.when } : {}),
        ...(body?.category !== undefined ? { category: body.category } : {}),
      };
      tasks = [...tasks, task];
      return json(201, { task });
    }
    if (url.startsWith("/api/tasks/") && method === "PATCH") {
      if (patchGate) await patchGate;
      if (patchAnswer.status !== 200) return json(patchAnswer.status, patchAnswer.body);
      const id = url.slice("/api/tasks/".length);
      tasks = tasks.map((task) =>
        task.id === id
          ? { ...task, ...(body?.when === null ? { when: undefined } : { when: body?.when }) }
          : task,
      );
      return json(200, { task: tasks.find((task) => task.id === id) });
    }
    if (url === `/api/page/${PAGE}`) {
      return json(200, { meta: { id: PAGE, ...(category ? { category } : {}) } });
    }
    return json(404, { error: "not found" });
  });
}

async function mountEditor(markdown: string): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(taskCheckbox)
    .create();
  open.push(editor);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  editors.set(view, editor);
  // The links fetch is issued by the plugin view on mount. Let it land before
  // a case asserts on a ghost that a link would have replaced.
  await settle();
  return view;
}

/** Drain the microtask queue the way an awaited fetch chain drains it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function serialize(view: EditorView): string {
  return editors.get(view)!.action(getMarkdown());
}

function marks(view: EditorView): HTMLButtonElement[] {
  return [...view.dom.querySelectorAll<HTMLButtonElement>(`button.${TASK_MARK_CLASS}`)];
}

function shownMarks(view: EditorView): HTMLButtonElement[] {
  return marks(view).filter((mark) => mark.hasAttribute("data-shown"));
}

function items(view: EditorView): HTMLLIElement[] {
  return [...view.dom.querySelectorAll<HTMLLIElement>("li.brain-task-item")];
}

function menu(): HTMLElement | null {
  // A menu playing its exit is not an open menu: the element lingers for the
  // 120ms retrace and answers `data-state="closed"` the whole time.
  return document.querySelector<HTMLElement>(
    `.${PROMOTE_MENU_CLASS}:not([data-state="closed"])`,
  );
}

/** The picker inside the popover, which is where the panel says it is
 *  waiting on a write. */
function picker(): HTMLElement | null {
  return menu()?.querySelector<HTMLElement>(".brain-when-picker") ?? null;
}

/** The popover's OWN row, which is Inbox and nothing else. Today, This
 *  Evening, Someday and Reminder below it belong to the picker's list. */
function menuLabels(): string[] {
  return [...(menu()?.querySelectorAll(":scope > .brain-menu-item") ?? [])].map((row) =>
    (row.textContent ?? "").trim(),
  );
}

/** Every row a reader can press in this popover, the panel's and the picker's
 *  alike, in drawn order. */
function allLabels(): string[] {
  return [...(menu()?.querySelectorAll(".brain-menu-item") ?? [])].map((row) =>
    (row.textContent ?? "").trim(),
  );
}

function hover(view: EditorView, index: number) {
  items(view)[index].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

/** Put the caret inside the nth paragraph of the document. */
function caretInLine(view: EditorView, index: number) {
  const starts: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") starts.push(pos + 1);
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, starts[index])));
}

/** A quick row: one tap, one write, and the popover is gone. */
async function pick(label: string) {
  const row = [...(menu()?.querySelectorAll<HTMLElement>(".brain-menu-item") ?? [])].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
}

/** The detailed path: a day out of the grid, and Done sends it. */
async function pickDay(day: string) {
  menu()
    ?.querySelector<HTMLElement>(`[data-day="${day}"]`)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  menu()
    ?.querySelector<HTMLElement>("[data-when-done]")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
}

function postBody(): Record<string, unknown> {
  const post = calls.find((call) => call.url === "/api/tasks" && call.method === "POST");
  return (post?.body ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Module state outlives a file's cases, and the day it holds decides
  // whether the next mount's watcher sees a change. Reset, so no case
  // depends on the order it runs in.
  resetTasksStore();
  window.history.replaceState({}, "", `/p/${PAGE}`);
  calls = [];
  tasks = [];
  category = null;
  createAnswer = { status: 201, body: {} };
  createGate = null;
  patchAnswer = { status: 200, body: {} };
  patchGate = null;
  stubFetch();
});

afterEach(async () => {
  while (open.length) await open.pop()!.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the + Task gesture", () => {
  it("shows the + Task ghost on hover over a checkbox line", async () => {
    // The caret opens in the first block, so the task line starts unhovered
    // and un-carried: the paragraph above is what keeps this case about the
    // pointer and nothing else.
    const view = await mountEditor("intro\n\n- [ ] water the plants\n");
    expect(shownMarks(view)).toHaveLength(0);

    hover(view, 0);

    expect(shownMarks(view).map((mark) => mark.textContent)).toEqual(["+ Task"]);
  });

  it("hides it again when the pointer leaves the editor", async () => {
    const view = await mountEditor("intro\n\n- [ ] water the plants\n");
    hover(view, 0);
    expect(shownMarks(view)).toHaveLength(1);

    view.dom.dispatchEvent(new MouseEvent("mouseleave"));

    expect(shownMarks(view)).toHaveLength(0);
  });

  it("shows it on a caret inside the line, so it is reachable without a pointer", async () => {
    const view = await mountEditor("- [ ] water the plants\n");

    caretInLine(view, 0);

    expect(shownMarks(view).map((mark) => mark.textContent)).toEqual(["+ Task"]);
  });

  it("shows it on no other line, including a plain bullet and a paragraph", async () => {
    const view = await mountEditor("- [ ] water the plants\n\n- call the bank\n\nnotes\n");

    expect(marks(view)).toHaveLength(1);
    // The one mark belongs to the one task line, and the other two lines have
    // nothing to hover.
    expect(view.dom.querySelectorAll("li")).toHaveLength(2);
    expect(items(view)).toHaveLength(1);
  });

  it("shows no ghost on a line with no words, because a task needs a title", async () => {
    const view = await mountEditor("- [ ] <br />\n");

    hover(view, 0);

    // The line IS a task item, which is what makes the absent mark a decision
    // rather than a line the plugin never saw.
    expect(items(view)).toHaveLength(1);
    expect(marks(view)).toHaveLength(0);
  });

  it("shows no ghost away from a note, so a share visitor is offered nothing", async () => {
    // The app's own share path. `/s/<token>` would pass for any string that is
    // not `/p/<id>`, and this is the URL a visitor lands on.
    window.history.replaceState({}, "", `/share/${PAGE}`);
    const view = await mountEditor("- [ ] water the plants\n");

    hover(view, 0);

    expect(marks(view)).toHaveLength(0);
    expect(menu()).toBeNull();
    // No ghost, no menu, and nothing asked of a route a visitor has no session
    // for. The gate is the URL, so this is the assertion that holds it.
    expect(calls.filter((call) => call.url.startsWith("/api/tasks"))).toEqual([]);
  });

  it("opens the picker with one Inbox row above it, and says every word once", async () => {
    // THE POPOVER IS THE PICKER. Today, This Evening and Someday are its own
    // quick rows and Tomorrow is a cell in its grid, so a list of four here
    // drew Today twice and Someday twice, four rows apart. Inbox is the one
    // word left: a task with no day at all, which no grid can say.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu()).not.toBeNull();
    expect(menuLabels()).toEqual(["Inbox"]);
    expect(allLabels()).toEqual(["Inbox", "Today", "This Evening", "Someday", "Reminder"]);
    expect(menu()?.getAttribute("data-state")).toBe("open");
  });

  it("is a dialog and not a menu, because a menu cannot hold a grid", async () => {
    // `role="menu"` may own menu items and nothing else. What stands in here
    // is a month grid, two spinbuttons and four checkbox rows: a screen reader
    // told this was a menu would not expose the grid as a grid.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = menu()!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("When");
    expect(panel.querySelector("[role='menuitem']")).toBeNull();
    expect(panel.querySelector("[role='grid']")).not.toBeNull();
    // And the trigger says what it opens. The arrow-key row walking that made
    // this a menu went with the role.
    expect(marks(view)[0].getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("draws the picker in the popover and no native input (D4)", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu()?.querySelector(".brain-when-picker")).not.toBeNull();
    expect(document.querySelector("input[type='date']")).toBeNull();
  });

  it("gives the grid the room there is, on the side the popover landed", async () => {
    // The popover carries a month grid now and there are windows that hold
    // neither side of it whole. `place()` measures the room and the picker's
    // own scroller reads it, so Done never ends up off the bottom edge.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = menu()!;
    expect(panel.querySelector(".brain-when-scroll .brain-when-picker")).not.toBeNull();
    expect(
      panel.style.getPropertyValue("--radix-popover-content-available-height"),
    ).toMatch(/^\d+px$/);
    // Below the line, so the floating tab bar is still under the panel and the
    // rule may take it off.
    expect(panel.style.getPropertyValue("--tabbar-reserve")).toBe("");
  });

  it("owes the floating tab bar nothing when it lands above the line", async () => {
    // The bar is at the bottom of the window. A panel placed ABOVE the line is
    // measured from the top of the window down and never reaches it, and
    // subtracting it there took ~84px of grid away on a phone for nothing.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    const mark = marks(view)[0];
    // A tall panel over a line near the foot of a short window: no room below,
    // room above, which is the one case `shouldFlipAbove` answers yes to.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 430,
    });
    mark.getBoundingClientRect = () =>
      ({ top: 600, bottom: 620, left: 20, right: 80 }) as DOMRect;

    mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = menu()!;
    expect(panel.style.top).toBe(`${600 - 430 - 6}px`);
    expect(panel.style.getPropertyValue("--tabbar-reserve")).toBe("0px");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  });

  it("keeps the panel standing on a grid pick and sends it on Done", async () => {
    // THE DETAILED PATH, here as everywhere: a reminder needs its day first,
    // so a day out of the grid has to be something a reader can follow with a
    // clock. Nothing is minted until they say they are done.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menu()
      ?.querySelector<HTMLElement>('[data-day="2026-09-20"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(menu()).not.toBeNull();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    menu()
      ?.querySelector<HTMLElement>("[data-when-done]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(postBody()).toMatchObject({ when: "2026-09-20" });
    expect(postBody().time).toBeUndefined();
    expect(postBody().evening).toBeUndefined();
    expect(marks(view)[0].textContent).toBe("20 Sep");
  });

  it("files the line in the evening when This Evening is the row pressed", async () => {
    // The popover used to draw This Evening and then drop the evening on the
    // way to the route, so the reader named a section and got another one with
    // no report. The whole value travels now.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("This Evening");

    expect(postBody()).toMatchObject({ when: TODAY, evening: true });
  });

  it("carries a reminder set beside the day it was set on", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menu()
      ?.querySelector<HTMLElement>('[data-day="2026-09-20"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menu()
      ?.querySelector<HTMLElement>("[data-when-reminder]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menu()
      ?.querySelector<HTMLElement>("[data-when-done]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(postBody()).toMatchObject({ when: "2026-09-20", time: "09:00" });
  });

  it("leaves the picker's own arrows to the picker", async () => {
    // The grid is a roving cell walked with all four arrows. A menu that also
    // stepped between rows would move the focus out from under a reader
    // halfway across a month.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const cell = menu()!.querySelector<HTMLElement>(`[data-day="${TODAY}"]`)!;
    cell.focus();
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement?.closest(".brain-when-picker")).not.toBeNull();
  });

  it("writes nothing into the markdown when a list word is picked", async () => {
    const view = await mountEditor("- [ ] water the plants\n\nnotes\n");
    const before = serialize(view);
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");

    expect(serialize(view)).toBe(before);
  });

  it("sends the page and an anchor built the way the store reads the line", async () => {
    const view = await mountEditor("intro\n\n- [ ] water  the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");

    const text = normalizeTaskText("water  the plants");
    expect(postBody()).toMatchObject({
      title: text,
      page: PAGE,
      when: TODAY,
      anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 2 },
    });
  });

  it("replaces the ghost with the picked word in the same place", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pickDay(TOMORROW);

    expect(menu()).toBeNull();
    const mark = marks(view)[0];
    expect(mark.textContent).toBe("Tomorrow");
    expect(mark.dataset.state).toBe("linked");
    // Same place: at the end of the line's own paragraph, where the ghost sat.
    expect(mark.parentElement?.tagName).toBe("P");
    expect(mark.parentElement?.textContent).toBe("water the plantsTomorrow");
    expect(postBody().when).toBe(TOMORROW);
  });

  it("shows Inbox and sends no day when Inbox is picked", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Inbox");

    expect(marks(view)[0].textContent).toBe("Inbox");
    expect(postBody().when).toBeUndefined();
  });

  it("reopens the same menu when the word is clicked, and reschedules the task", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menuLabels()).toEqual(["Inbox"]);

    await pick("Someday");

    expect(marks(view)[0].textContent).toBe("Someday");
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/tasks/task-1");
    expect(patch?.body).toEqual({ when: "someday" });
    // One record, rescheduled. A second POST would be a second task on one line.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("shows Done in place of the word when the checkbox is ticked", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");
    expect(marks(view)[0].textContent).toBe("Today");

    view.dom.querySelector<HTMLButtonElement>("button[role='checkbox']")!.click();

    expect(serialize(view)).toBe("* [x] water the plants\n");
    expect(marks(view)[0].textContent).toBe("Done");
  });

  it("defaults the new task's category from the page's category", async () => {
    category = "Garden";
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");

    expect(postBody().category).toBe("Garden");
  });

  it("sends no category when the page has none", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");

    expect(postBody().category).toBeUndefined();
  });

  it("keeps the menu open and says so when the route refuses, rather than toasting", async () => {
    // THE REFUSAL IS SHOWN WHERE THE CHOICE WAS MADE, and that is the
    // decision, not an oversight. A toast is the house surface for a route
    // `reason`, and it is the wrong one here: the popover is still open over
    // the line, so a notice in the corner of the window asks the reader to
    // look away from the control they are holding and then back at it to pick
    // again. The menu stays, the reason sits in it, and the next pick is one
    // press away. The words are still the route's own.
    createAnswer = { status: 400, body: { error: "bad_title", reason: "title too long" } };
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");

    expect(menu()).not.toBeNull();
    expect(menu()?.textContent).toContain("title too long");
    expect(marks(view)[0].textContent).toBe("+ Task");
  });

  it("draws the word for a task the page already had, with no ghost beside it", async () => {
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-known",
        title: text,
        page: PAGE,
        when: TODAY,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    const view = await mountEditor("- [ ] water the plants\n- [ ] call the bank\n");

    expect(marks(view).map((mark) => mark.textContent)).toEqual(["Today", "+ Task"]);
    expect(marks(view).map((mark) => mark.dataset.state)).toEqual(["linked", "ghost"]);
  });

  /* ── What the review measured, and what now holds ───────────────────────
   *
   *  prosemirror-view short-circuits widget equality on `spec.key`, so a mark
   *  whose key has not changed keeps the DOM and the handlers it was drawn
   *  with. A position captured at draw time is then a position the document
   *  has moved, and the measured cost was a click on the second line posting
   *  the first line's anchor. These two cases are the regression.
   */

  it("promotes the line that was clicked, after the document moved above it", async () => {
    const view = await mountEditor("intro\n\n- [ ] alpha\n\n- [ ] beta\n");
    hover(view, 1);
    expect(marks(view)[1].textContent).toBe("+ Task");

    // Nine characters into the paragraph above, which is exactly the gap
    // between the two task lines in this fixture: a stale position lands on
    // alpha rather than refusing, which is the quiet half of the bug.
    view.dispatch(view.state.tr.insertText("xxxxxxxxx", 1));
    marks(view)[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    expect(postBody()).toMatchObject({
      title: "beta",
      anchor: { text: "beta", hash: hashTaskText("beta"), ordinal: 0 },
    });
    expect(marks(view).map((mark) => mark.textContent)).toEqual(["+ Task", "Today"]);
  });

  it("names the second of two identical lines, which is the whole point of the ordinal", async () => {
    const view = await mountEditor("- [ ] buy milk\n- [ ] buy milk\n");
    hover(view, 1);

    marks(view)[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    expect(postBody().anchor).toMatchObject({ text: "buy milk", ordinal: 1 });
    expect(marks(view).map((mark) => mark.textContent)).toEqual(["+ Task", "Today"]);
  });

  it("takes no press while its one write is out, and remembers none", async () => {
    // ONE WRITE AT A TIME, AND NO QUEUE. While the route is answering, the
    // panel is pending: its own row and every row the picker draws take no
    // press, and a press made there is neither sent nor kept. The queue this
    // panel used to hold kept a word the reader could no longer see, and
    // answered each caller about somebody else's write.
    let release = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const row = [
      ...menu()!.querySelectorAll<HTMLButtonElement>(":scope > .brain-menu-item"),
    ].find((candidate) => (candidate.textContent ?? "").trim() === "Inbox")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(menu()?.getAttribute("aria-busy")).toBe("true");
    expect(picker()?.getAttribute("aria-busy")).toBe("true");
    expect(row.getAttribute("aria-disabled")).toBe("true");

    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    release();
    await settle();
    await settle();

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    expect(marks(view)[0].textContent).toBe("Inbox");
    expect(menu()).toBeNull();
  });

  it("says so when a write from the panel before it is still out", async () => {
    // ONE WRITE AT A TIME IS A RULE ABOUT THE LINE, not about one panel. A
    // reader can press the mark again with a write still out, and that opens a
    // second panel over the same line. Its press is refused rather than sent,
    // because two records contending for one checkbox is the state that has no
    // honest reading, and it is refused OUT LOUD: a control that takes a press
    // and does nothing is the one shape a control must not have.
    let release = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");
    // The mark reopens the panel: it is the trigger, so the press outside does
    // not close it first.
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Someday");

    expect(menu()).not.toBeNull();
    expect(menu()?.textContent).toContain("still saving");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);

    release();
    await settle();
  });

  it("keeps a refused pick one press away, and the second press writes", async () => {
    // THE REFUSAL LEAVES THE PANEL STANDING so the next pick is one press
    // away, which is the sentence the case above ends on. It was not true: the
    // picker had already taken the refused value for the record's own, so the
    // same row sent nothing the second time and the panel dismissed with no
    // task filed and no second reason.
    createAnswer = { status: 409, body: { error: "conflict", reason: "already a task" } };
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");
    expect(menu()).not.toBeNull();
    expect(menu()?.textContent).toContain("already a task");

    createAnswer = { status: 201, body: {} };
    await pick("Today");

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(menu()).toBeNull();
    expect(marks(view)[0].textContent).toBe("Today");
  });

  it("keeps a refused reschedule one press away, and says why while it waits", async () => {
    // THE COMMONER GESTURE IN A NOTE IS A RESCHEDULE, not a create: the line
    // is already a task, so the panel sends a PATCH, and a route that refuses
    // one owes the reader the same panel, the same reason and the same second
    // press a refused create does.
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-known",
        title: text,
        page: PAGE,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    let release = () => {};
    patchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    patchAnswer = { status: 409, body: { error: "conflict", reason: "already moved" } };
    const view = await mountEditor("- [ ] water the plants\n");
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");
    // The panel is waiting, so the row beside the one pressed answers nothing.
    await pick("Someday");
    release();
    await settle();

    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(menu()).not.toBeNull();
    expect(menu()?.textContent).toContain("already moved");
    expect(marks(view)[0].textContent).toBe("Inbox");

    patchAnswer = { status: 200, body: {} };
    await pick("Someday");

    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
    expect(menu()).toBeNull();
    expect(marks(view)[0].textContent).toBe("Someday");
  });

  it("closes on Escape with the write still out, and the write still lands", async () => {
    // ESCAPE IS A CLOSE AND NOT A CANCEL once the create has gone. There is
    // nothing left to throw away: the value is with the route, and the line
    // gets the word it was given whether or not this panel is still on screen.
    let release = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");
    expect(menu()).not.toBeNull();

    picker()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(menu()).toBeNull();

    release();
    await settle();

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(marks(view)[0].textContent).toBe("Today");
  });

  it("drops a refusal that lands after the panel has gone", async () => {
    // THE REASON GOES ON THE PANEL THE READER IS HOLDING, and after Escape
    // there is none to hold: written into a detached node it tells nobody, and
    // this popover has no toast of its own, by the decision two cases above.
    // What is left is the line, still a ghost, which is the honest report that
    // nothing was filed.
    createAnswer = { status: 409, body: { error: "conflict", reason: "already a task" } };
    let release = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Today");
    const label = menu()!.querySelector<HTMLElement>(".brain-menu-label")!;
    picker()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    release();
    await settle();

    expect(label.textContent).toBe("");
    expect(label.hidden).toBe(true);
    expect(menu()).toBeNull();
    expect(marks(view)[0].textContent).toBe("+ Task");
  });

  it("sends nothing from Inbox when the line is already in the Inbox", async () => {
    // ONE NO-OP RULE, BOTH ROWS. The picker's Clear will not repeat a value
    // the record already carries, and the row one word from it did: a line
    // filed in the Inbox took a PATCH that said where it already was.
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-known",
        title: text,
        page: PAGE,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    const view = await mountEditor("- [ ] water the plants\n");
    expect(marks(view)[0].textContent).toBe("Inbox");
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await pick("Inbox");

    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(menu()).toBeNull();
    expect(marks(view)[0].textContent).toBe("Inbox");
  });

  it("opens on the evening and the clock the line already carries", async () => {
    // The day is half the record. An evening task with a reminder opened with
    // the evening row unchecked and the spinners away, so the panel said the
    // line had neither.
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-known",
        title: text,
        page: PAGE,
        when: TODAY,
        evening: true,
        time: "18:30",
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    const view = await mountEditor("- [ ] water the plants\n");
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = menu()!;
    expect(panel.querySelector("[data-when-evening]")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(panel.querySelector("[data-when-reminder]")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(panel.querySelector("[data-when-hour]")?.textContent).toBe("18");
    expect(panel.querySelector("[data-when-minute]")?.textContent).toBe("30");
  });

  it("opens on the day the line already carries", async () => {
    // THE PANEL STANDS ON THE RECORD. It used to open every line on nothing
    // set, so a task filed in Today had no row checked and no cell selected,
    // and the one control whose word is about the value the line already has
    // was dead before it was pressed.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = menu()!;
    expect(panel.querySelector("[data-when-today]")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(panel.querySelector(`[data-day="${TODAY}"]`)?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("clears the day of a line that has one, because that is what Clear says", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menu()
      ?.querySelector<HTMLElement>("[data-when-clear]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/tasks/task-1");
    expect(patch?.body).toEqual({ when: null });
    expect(marks(view)[0].textContent).toBe("Inbox");
    expect(menu()).toBeNull();
  });

  it("files a line with no day from Clear, which is the Inbox row's own word", async () => {
    // ONE WORD APART, AND THEY USED TO DO OPPOSITE THINGS. The panel's Inbox
    // row created the task with no day and the picker's Clear, two rows below
    // it, closed the panel having written nothing: the picker had been told
    // the record said "nothing set" about a line that had no record at all.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    menu()
      ?.querySelector<HTMLElement>("[data-when-clear]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(postBody().when).toBeUndefined();
    expect(marks(view)[0].textContent).toBe("Inbox");
    expect(menu()).toBeNull();
  });

  it("moves an already-promoted line to the Inbox from the row that says so", async () => {
    // One word apart from Clear, and they used to have opposite outcomes: the
    // panel's own row wrote and the picker's did nothing at all.
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Today");

    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pick("Inbox");

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/tasks/task-1");
    expect(patch?.body).toEqual({ when: null });
    expect(marks(view)[0].textContent).toBe("Inbox");
  });

  it("closes the menu when the page scrolls under it", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu()).not.toBeNull();

    // The menu is fixed to the viewport; its line is not. A menu left behind
    // while the line travels is how somebody reschedules the wrong task.
    window.dispatchEvent(new Event("scroll"));
    await settle();

    expect(menu()).toBeNull();
  });

  it("asks for this page's records again when a task changes somewhere else", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    const asked = () => calls.filter((call) => call.url.includes("/api/tasks?page=")).length;
    expect(asked()).toBe(1);
    expect(marks(view)[0].textContent).toBe("+ Task");

    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-elsewhere",
        title: text,
        page: PAGE,
        when: TODAY,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT));
    await settle();

    expect(asked()).toBe(2);
    expect(marks(view)[0].textContent).toBe("Today");
  });

  it("renames the word when the day moves under an open note", async () => {
    // A tab left open overnight. Nothing in the document moved and no record
    // changed: what changed is which day `Today` means, and the line is owed
    // yesterday now. The plugin hears it from the one clock the subsystem
    // reads, the same timer, visibilitychange and focus the Tasks surface and
    // the sidebar count are armed from.
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-overnight",
        title: text,
        page: PAGE,
        when: TODAY,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    const view = await mountEditor("- [ ] water the plants\n");
    expect(marks(view)[0].textContent).toBe("Today");

    vi.setSystemTime(new Date(2026, 8, 14, 9, 0, 0));
    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(marks(view)[0].textContent).toBe("13 Sep");
  });

  it("stops watching the day once the editor is gone", async () => {
    const text = normalizeTaskText("water the plants");
    tasks = [
      {
        id: "task-overnight",
        title: text,
        page: PAGE,
        when: TODAY,
        done: false,
        created: NOW.toISOString(),
        updated: NOW.toISOString(),
        anchor: { text, hash: hashTaskText(text), ordinal: 0, line: 0 },
      },
    ];
    const view = await mountEditor("- [ ] water the plants\n");
    await open.pop()!.destroy();

    vi.setSystemTime(new Date(2026, 8, 14, 9, 0, 0));
    window.dispatchEvent(new Event("focus"));
    await settle();

    // No throw, and the torn-down view was never dispatched into.
    expect(view.isDestroyed).toBe(true);
  });

  it("stops listening for task changes once the editor is gone", async () => {
    await mountEditor("- [ ] water the plants\n");
    await open.pop()!.destroy();
    const asked = calls.filter((call) => call.url.includes("/api/tasks?page=")).length;

    window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT));
    await settle();

    expect(calls.filter((call) => call.url.includes("/api/tasks?page="))).toHaveLength(asked);
  });

  it("closes the menu on Escape without sending anything", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    hover(view, 0);
    marks(view)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect(menu()).toBeNull();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});
