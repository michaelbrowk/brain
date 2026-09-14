import { serializerCtx } from "@milkdown/kit/core";
import { listItemSchema } from "@milkdown/kit/preset/commonmark";
import { keymap } from "@milkdown/kit/prose/keymap";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { splitListItem } from "@milkdown/kit/prose/schema-list";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@milkdown/kit/prose/view";
import { $prose, $view } from "@milkdown/kit/utils";

import { localDay, onDayChange } from "@/components/tasks-client";
import {
  prefersReducedMotion,
  renderTaskCheckbox,
  setTaskCheckboxChecked,
  setTaskCheckboxLabel,
} from "@/components/tasks-checkbox";
import { dayLabel } from "@/components/tasks-lists";
import { SOLAR } from "@/components/ui/solar-icons.generated";
import { apiFetch } from "@/lib/client";
import { TASKS_CHANGED_EVENT } from "@/lib/editor-events";
import { classifyInternalPageLink } from "@/lib/internal-page-link";
import { DUR } from "@/lib/motion";
import { isLinkedTask, type TaskView } from "@/lib/tasks/model";
import { reconcilePageTasks } from "@/lib/tasks/reconcile";
import { normalizeTaskText, parseTaskLines } from "@/lib/tasks/task-lines";

import { shouldFlipAbove } from "./menu-position";

/** A real control on a task list item.
 *
 *  The gfm preset already carries the state: `list_item` gets a `checked`
 *  attribute, null on an ordinary bullet and a boolean on a task, and it
 *  parses and serializes `* [ ] text` without loss. What it never rendered was
 *  anything to press, so a checkbox in a note could be read and not ticked.
 *  This is the missing half: the same node, drawn with the one checkbox from
 *  `components/tasks-checkbox.tsx` and toggled through a transaction.
 *
 *  Ticking writes the attribute and stops. It does not touch markdown and it
 *  does not reach the store: inside one tab the change travels the ordinary
 *  document path and autosave carries it out, the same as typing a letter. */

/** The item's own line, not its branch. A `list_item` holds `paragraph block*`,
 *  so a parent task carries its nested items as content, and `textBetween` on
 *  the item reads the whole subtree: a parent would be announced as "parent
 *  child child". The first block is the line the control sits on. */
function itemText(node: ProseNode): string {
  const line = node.firstChild;
  if (!line) return "";
  return line.textBetween(0, line.content.size, " ", " ");
}

export const taskCheckboxView = $view(listItemSchema.node, () =>
  ((initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    // `checked` is null on a plain bullet. Returning no view hands the item
    // back to the preset's own `toDOM`, so an ordinary list item renders
    // exactly what it rendered before this plugin existed, with no copy of
    // the preset's markup here to drift. ProseMirror reads the absent spec
    // and takes the default path; the constructor's type says it always
    // returns a view, which is the one place this has to say otherwise.
    if (initial.attrs.checked == null) return undefined as unknown as NodeView;

    const dom = document.createElement("li");
    dom.className = "brain-task-item";
    dom.setAttribute("data-item-type", "task");

    const contentDOM = document.createElement("div");
    contentDOM.className = "brain-task-body";

    const toggle = () => {
      const pos = getPos();
      if (pos == null) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "list_item" || node.attrs.checked == null) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        }),
      );
    };

    const box = renderTaskCheckbox({
      checked: Boolean(initial.attrs.checked),
      onToggle: toggle,
      reduce: prefersReducedMotion(),
    });
    box.setAttribute("contenteditable", "false");

    // The data attributes are the preset's own, and they are load bearing
    // rather than decoration: a DOM change inside the item is recovered by
    // re-parsing it, and gfm's `parseDOM` reads `checked` back off the `li`.
    // An item that carried none of them would come back a plain bullet.
    const render = (node: ProseNode) => {
      dom.setAttribute("data-label", String(node.attrs.label));
      dom.setAttribute("data-list-type", String(node.attrs.listType));
      dom.setAttribute("data-spread", String(node.attrs.spread));
      dom.setAttribute("data-checked", String(Boolean(node.attrs.checked)));
      setTaskCheckboxChecked(box, Boolean(node.attrs.checked), prefersReducedMotion());
      setTaskCheckboxLabel(box, itemText(node));
    };

    render(initial);
    dom.append(box, contentDOM);

    return {
      dom,
      contentDOM,
      update: (node: ProseNode) => {
        // A bullet that becomes a task, or a task that becomes a bullet, is a
        // different control. Refusing the update has ProseMirror build the
        // right one from scratch.
        if (node.type.name !== "list_item" || node.attrs.checked == null) return false;
        render(node);
        return true;
      },
      ignoreMutation: (mutation: ViewMutationRecord) => {
        if (mutation.target === contentDOM || contentDOM.contains(mutation.target)) return false;
        return true;
      },
      stopEvent: (event: Event) =>
        event.target instanceof Node && (event.target === box || box.contains(event.target)),
    };
  }) satisfies NodeViewConstructor,
);

/** Enter on a done task must not birth a done task.
 *
 *  `splitListItemCommand` is `splitListItem(type)` with no `itemAttrs`
 *  (`preset-commonmark`), so `prosemirror-schema-list` passes a null entry to
 *  `Transform.split` and the new item reuses the split node's type AND attrs,
 *  `checked: true` among them. Every editor a reader has used resets it. The
 *  behaviour predates this plugin and was invisible while nothing rendered a
 *  checkbox, which is what puts it here.
 *
 *  The reset is applied to the item the caret lands in rather than through
 *  `itemAttrs`, because `itemAttrs` reaches only the branch where the caret
 *  sits at the end of the line; a split from the middle of one takes the other
 *  branch and would keep the tick. Both branches end with the caret in the new
 *  item, so both are covered here. */
function uncheckSplitItem(tr: Transaction): Transaction {
  const $pos = tr.selection.$from;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name !== "list_item") continue;
    if (node.attrs.checked === true) {
      tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, checked: false });
    }
    return tr;
  }
  return tr;
}

const splitTaskItem: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "list_item") continue;
    // Only a done item needs the reset. An unchecked one already splits into
    // an unchecked one, and a plain bullet must not become a task at all, so
    // both fall through to the preset's own Enter.
    if (node.attrs.checked !== true) return false;
    return splitListItem(node.type)(
      state,
      dispatch && ((tr) => dispatch(uncheckSplitItem(tr))),
    );
  }
  return false;
};

/** Milkdown merges every registered keymap into one ProseMirror keymap plugin
 *  and places it after the `$prose` plugins (`@milkdown/core`), so a binding
 *  registered here is offered the key first and falls through to the preset
 *  by returning false. */
export const taskSplitKeymap = $prose(() => keymap({ Enter: splitTaskItem }));

/* ── "+ Task": the gesture that turns a line into a task ──────────────────
 *
 *  A checkbox in a note is a checkbox. It becomes a TASK only here, through
 *  one explicit gesture: a ghost at the end of the line, a menu, a choice.
 *  The reconcile never creates a task and neither does typing `- [ ]`, so
 *  nothing a person writes quietly enters their task list.
 *
 *  THE WORD IS A DECORATION AND IS NEVER WRITTEN INTO THE MARKDOWN. That is
 *  decision 16 and the whole reason the anchor is opaque: no task metadata
 *  reaches a share visitor through the page body, and `duplicatePage` and the
 *  Notion importer carry no task state by construction. `task-promote.test.ts`
 *  serialises the document before and after a promotion and compares bytes.
 *
 *  It lives beside the NodeView above rather than in a plugin of its own,
 *  because the control and the mark are one object on one line, and two
 *  plugins racing for the same position is a bug waiting to happen.
 *
 *  The moment is quiet on purpose: this is a notebook, and the drama belongs
 *  to completion.
 */

/** The ghost and the word: one element in two states. */
export const TASK_MARK_CLASS = "brain-task-mark";
/** The popover, on the `brain-menu` material at 220 rather than the list
 *  menu's 264. It holds five short words and nothing else. */
export const PROMOTE_MENU_CLASS = "brain-task-menu";
/** A task record changed somewhere this editor cannot see. Dispatched on
 *  `window` by the shell's store-event forwarder in `components/shell.tsx`,
 *  which is the one place that already knows a `type: "task"` event arrived
 *  and that it was not this tab's own. The name lives in `lib/editor-events`,
 *  which both sides import: this module cannot be imported from the shell
 *  (it would pull Milkdown into that bundle), so a shared literal would have
 *  had to be written twice. Re-exported for the callers that already had it
 *  from here. */
export { TASKS_CHANGED_EVENT };
const MENU_WIDTH = 220;
/** The retrace, `DUR.fast`. The material's own keyframes play it; this is how
 *  long to wait before taking the element away. */
const MENU_EXIT_MS = DUR.fast * 1000;
const MENU_GAP = 6;
const EDGE_GUTTER = 8;

const promoteKey = new PluginKey<PromoteState>("brainTaskPromote");

/** What joins one task line's text to the next when the plugin asks whether
 *  the list it is looking at is the list it looked at last.
 *
 *  Written as an escape, not as the byte. A literal NUL sat here and made the
 *  whole file binary to `grep`, `ripgrep` and every wrapper that shells out to
 *  one, so the single file in `components/editor/` that reaches the share
 *  bundle was silently skipped by any audit of that directory.
 *
 *  A newline is the right separator and needs no second character:
 *  `normalizeTaskText` collapses every whitespace run to one space and trims,
 *  so no item's text can hold one and two different lists cannot join to the
 *  same string. */
const ITEM_SEPARATOR = "\n";

type PromoteMessage =
  | { kind: "tasks"; tasks: readonly TaskView[] }
  | { kind: "hover"; pos: number | null }
  | { kind: "open"; pos: number | null }
  /** Midnight passed. Nothing in the document moved and no record changed,
   *  but every word a linked line carries names the reader's own day. */
  | { kind: "day" };

/** One task list item of the document, in document order. */
interface TaskItem {
  /** Position before the `list_item`. The identity a hover is held by. */
  pos: number;
  /** The item's own line, so a caret can be tested against it without the
   *  nested items a parent task carries. */
  lineFrom: number;
  lineTo: number;
  /** What the reader typed, normalised. Empty means there is nothing to make
   *  a task of yet, which is the line the template writes. */
  text: string;
  checked: boolean;
}

interface PromoteState {
  /** The open note, or null away from `/p/<id>`. A share visitor has no
   *  tasks, so the gesture is absent there rather than refused. */
  page: string | null;
  tasks: readonly TaskView[];
  /** The item the pointer is over, and the item whose menu is open. */
  hover: number | null;
  open: number | null;
  /** Task id by item index. Recomputed only when the lines change, because
   *  it costs one serialisation of the document. */
  byItem: ReadonlyMap<number, string>;
  signature: string;
  decorations: DecorationSet;
}

/** What the promote path needs from the Milkdown ctx, handed down rather than
 *  reached for: a plugin is built before the editor has a serializer, and a
 *  module-level one would be shared by two mounted editors. */
interface PromoteContext {
  markdownOf: (doc: ProseNode) => string | null;
}

/** The day after the reader's own. `localDay` is `components/tasks-client`,
 *  where the surface and the sidebar count read the browser's clock, so this
 *  adds the one step and no second spelling of a calendar day. */
function tomorrowOf(now: Date = new Date()): string {
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).today;
}

/** The word the mark carries once the line is a task: the list it is in, or
 *  the day, in the words the menu offered. */
function listWord(when: string | undefined, today: string, tomorrow: string): string {
  if (when === undefined) return "Inbox";
  if (when === "someday") return "Someday";
  if (when === today) return "Today";
  if (when === tomorrow) return "Tomorrow";
  return dayLabel(when);
}

/** The note this editor is open on. The canonical `/p/<id>` URL is in place
 *  by the time an editor mounts, which the template-caret effect in
 *  `milkdown-editor.tsx` already leans on. Anywhere else, a share or a
 *  preview, there is no note of the reader's to link a task to. */
function openPageId(): string | null {
  if (typeof window === "undefined") return null;
  return (
    classifyInternalPageLink(window.location.pathname, window.location.origin)?.id ?? null
  );
}

function taskItemsOf(doc: ProseNode): TaskItem[] {
  const found: TaskItem[] = [];
  doc.descendants((node, pos) => {
    // A textblock's children are its words, and no list item lives inside
    // one. Returning false keeps `descendants` from walking the inline
    // content, which is most of a note by count, so this walk is block level.
    if (node.isTextblock) return false;
    if (node.type.name !== "list_item" || node.attrs.checked == null) return;
    const line = node.firstChild;
    if (!line || !line.isTextblock) return;
    found.push({
      pos,
      lineFrom: pos + 2,
      lineTo: pos + 2 + line.content.size,
      text: normalizeTaskText(itemText(node)),
      checked: node.attrs.checked === true,
    });
  });
  return found;
}

/** THE LINE AN ELEMENT BELONGS TO, ASKED OF THE DOCUMENT AS IT STANDS.
 *
 *  Never from a render closure. prosemirror-view short-circuits widget
 *  equality on `spec.key`, so a widget whose key has not changed keeps its
 *  existing DOM and its existing handlers across an edit anywhere else in the
 *  document: a position captured when the mark was drawn is a position the
 *  document has since moved. The mark is found by walking from its own DOM to
 *  the `list_item` it sits in, so the answer is whatever is true now. `index`
 *  travels with it, because `byItem` is keyed by the item's place in document
 *  order and not by its position. */
interface MarkTarget {
  pos: number;
  index: number;
  taskId: string | null;
}

function markTargetOf(view: EditorView, element: Element): MarkTarget | null {
  const li = element.closest("li.brain-task-item");
  if (!li) return null;
  const items = taskItemsOf(view.state.doc);
  const index = items.findIndex((item) => view.nodeDOM(item.pos) === li);
  if (index < 0) return null;
  return {
    pos: items[index].pos,
    index,
    taskId: promoteKey.getState(view.state)?.byItem.get(index) ?? null,
  };
}

/** Which line is which task, answered by `lib/tasks/reconcile.ts` and by
 *  nothing else. The editor and the store cannot disagree about it, because
 *  it is the same function over the same markdown.
 *
 *  A line count that disagrees with the item count means this editor cannot
 *  say which line is which item, so it draws no words at all rather than the
 *  wrong ones. */
function bindTasks(
  markdown: string,
  page: string,
  tasks: readonly TaskView[],
  itemCount: number,
): Map<number, string> {
  const byItem = new Map<number, string>();
  const lines = parseTaskLines(markdown);
  if (lines.length !== itemCount) return byItem;
  const mine = tasks.filter((task) => task.page === page && isLinkedTask(task));
  if (mine.length === 0) return byItem;
  const decisions = reconcilePageTasks({
    page,
    lines,
    tasks: mine.map((task) => ({ task, done: task.done })),
    // The detach stamp, which this caller throws away: it reads the rebinds
    // and nothing else. The reconcile takes the instant as an argument so it
    // stays clock-free, and this is where the editor supplies it.
    at: new Date().toISOString(),
  });
  for (const bound of decisions.rebound) byItem.set(bound.index, bound.id);
  return byItem;
}

export const taskPromote = $prose((ctx) => {
  const promote: PromoteContext = {
    // Lazily, and never fatally: the plugin is constructed before the editor
    // has a serializer, and a note whose markdown cannot be read draws no
    // words rather than throwing inside a transaction.
    markdownOf: (doc) => {
      try {
        return ctx.get(serializerCtx)(doc);
      } catch {
        return null;
      }
    },
  };

  const build = (
    doc: ProseNode,
    selection: { from: number; to: number },
    previous: PromoteState,
    rebind: boolean,
  ): PromoteState => {
    const items = taskItemsOf(doc);
    const signature = items.map((item) => item.text).join(ITEM_SEPARATOR);
    let byItem = previous.byItem;
    if (rebind || signature !== previous.signature) {
      byItem = new Map();
      if (previous.page !== null && previous.tasks.length > 0) {
        const markdown = promote.markdownOf(doc);
        if (markdown !== null) {
          byItem = bindTasks(markdown, previous.page, previous.tasks, items.length);
        }
      }
    }
    const next = { ...previous, byItem, signature };
    return { ...next, decorations: markDecorations(doc, items, selection, next, promote) };
  };

  return new Plugin<PromoteState>({
    key: promoteKey,
    state: {
      init: (_config, state) =>
        build(
          state.doc,
          state.selection,
          {
            page: openPageId(),
            tasks: [],
            hover: null,
            open: null,
            byItem: new Map(),
            signature: "",
            decorations: DecorationSet.empty,
          },
          true,
        ),
      apply: (tr, value, _old, state) => {
        const message = tr.getMeta(promoteKey) as PromoteMessage | undefined;
        let next = value;
        let rebind = false;
        if (tr.docChanged) {
          next = {
            ...next,
            hover: next.hover === null ? null : tr.mapping.map(next.hover),
            open: next.open === null ? null : tr.mapping.map(next.open),
          };
        }
        if (message?.kind === "tasks") {
          // New records mean the line-to-task answer has to be asked again
          // even though no line moved.
          next = { ...next, tasks: message.tasks };
          rebind = true;
        }
        if (message?.kind === "hover") next = { ...next, hover: message.pos };
        if (message?.kind === "open") next = { ...next, open: message.pos };
        // A new day redraws the words and nothing else: the lines are the
        // lines they were a second ago, so no rebind and no serialisation.
        const redraw = message?.kind === "day";
        if (!rebind && !redraw && next === value && !tr.docChanged && !tr.selectionSet) {
          return value;
        }
        return build(state.doc, state.selection, next, rebind);
      },
    },
    props: {
      decorations: (state) =>
        promoteKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleDOMEvents: {
        mouseover: (view, event) => {
          const target = event.target;
          const li =
            target instanceof Element ? target.closest("li.brain-task-item") : null;
          const state = promoteKey.getState(view.state);
          // The common event by far is the pointer moving INSIDE the line it
          // is already on, and answering that costs one `nodeDOM`. Everything
          // below it walks the document.
          if (state?.hover != null && li !== null && view.nodeDOM(state.hover) === li) {
            return false;
          }
          setHover(view, li === null ? null : (markTargetOf(view, li)?.pos ?? null));
          return false;
        },
        mouseleave: (view) => {
          setHover(view, null);
          return false;
        },
      },
    },
    view: (view) => {
      let disposed = false;
      const reload = () => {
        if (!disposed) void loadTasks(view, () => disposed);
      };
      // Midnight, off the one clock the subsystem reads
      // (`components/tasks-client`): the same timer, `visibilitychange` and
      // `focus` the Tasks surface and the sidebar count are armed from. Without
      // it a note left open overnight still says `Today` on a line that is now
      // owed yesterday, and `Done` on one completed the day before.
      let releaseDay: (() => void) | null = null;
      if (promoteKey.getState(view.state)?.page) {
        reload();
        releaseDay = onDayChange(() => {
          if (!disposed) redrawDay(view);
        });
        // A record can change anywhere: another tab, the Tasks surface, an MCP
        // call, a repeat rule advancing. Without this the note keeps whatever
        // it read at mount, so a line deleted and re-typed shows a word for a
        // task the server has since detached, and ticking that box answers
        // nothing. The shell forwards the store's `task` event (it already
        // ignores this tab's own echo, so a promotion from here does not
        // bounce back as a reload).
        window.addEventListener(TASKS_CHANGED_EVENT, reload);
      }
      return {
        destroy: () => {
          disposed = true;
          releaseDay?.();
          window.removeEventListener(TASKS_CHANGED_EVENT, reload);
          // Taken away rather than dismissed: a dismiss dispatches, and this
          // editor's ctx is already being torn down around it.
          detachMenu();
        },
      };
    },
  });
});

function setHover(view: EditorView, pos: number | null): void {
  if (view.isDestroyed) return;
  const state = promoteKey.getState(view.state);
  // Only when it moved. A pointer crossing a line would otherwise dispatch a
  // transaction per pixel.
  if (!state || state.page === null || state.hover === pos) return;
  view.dispatch(
    view.state.tr
      .setMeta(promoteKey, { kind: "hover", pos } satisfies PromoteMessage)
      .setMeta("addToHistory", false),
  );
}

function setOpen(view: EditorView, pos: number | null): void {
  if (view.isDestroyed) return;
  const state = promoteKey.getState(view.state);
  if (!state || state.open === pos) return;
  view.dispatch(
    view.state.tr
      .setMeta(promoteKey, { kind: "open", pos } satisfies PromoteMessage)
      .setMeta("addToHistory", false),
  );
}

/** Redraw the words for a new day. No record changed and no line moved, so
 *  this is not in the history and asks for no re-serialisation. */
function redrawDay(view: EditorView): void {
  if (view.isDestroyed) return;
  if (promoteKey.getState(view.state)?.page == null) return;
  view.dispatch(
    view.state.tr
      .setMeta(promoteKey, { kind: "day" } satisfies PromoteMessage)
      .setMeta("addToHistory", false),
  );
}

function publishTasks(view: EditorView, tasks: readonly TaskView[]): void {
  if (view.isDestroyed) return;
  view.dispatch(
    view.state.tr
      .setMeta(promoteKey, { kind: "tasks", tasks } satisfies PromoteMessage)
      .setMeta("addToHistory", false),
  );
}

/** THIS PAGE'S RECORDS, WHOLE.
 *
 *  `?page=<id>` is a lookup and not a list: it answers a record whatever state
 *  it is in, done or detached or completed longer ago than the Logbook window
 *  holds. A list read hides all three, and a line whose record the editor
 *  could not find offers "+ Task" again and is promoted a second time, which
 *  leaves two records contending for one checkbox. */
async function loadTasks(view: EditorView, disposed: () => boolean): Promise<void> {
  const page = promoteKey.getState(view.state)?.page;
  if (!page) return;
  try {
    const response = await apiFetch(`/api/tasks?page=${encodeURIComponent(page)}`);
    if (!response.ok || disposed()) return;
    const body = (await response.json()) as { tasks?: readonly TaskView[] };
    if (disposed()) return;
    publishTasks(view, body.tasks ?? []);
  } catch {
    // A note whose task list could not be read draws no words. Its lines are
    // still checkboxes and still tick, which is the part that matters.
  }
}

function markDecorations(
  doc: ProseNode,
  items: TaskItem[],
  selection: { from: number; to: number },
  state: PromoteState,
  promote: PromoteContext,
): DecorationSet {
  if (state.page === null) return DecorationSet.empty;
  const today = localDay().today;
  const tomorrow = tomorrowOf();
  const decorations: Decoration[] = [];

  for (const [index, item] of items.entries()) {
    const id = state.byItem.get(index);
    const task = id === undefined ? undefined : state.tasks.find((row) => row.id === id);
    if (id !== undefined && task !== undefined) {
      const when = task.when === undefined ? undefined : String(task.when);
      decorations.push(
        markWidget(item, promote, {
          word: item.checked ? "Done" : listWord(when, today, tomorrow),
          taskId: id,
          shown: true,
        }),
      );
      continue;
    }
    // Nothing to name a task after yet.
    if (item.text === "") continue;
    decorations.push(
      markWidget(item, promote, {
        word: "+ Task",
        taskId: null,
        shown:
          state.hover === item.pos ||
          state.open === item.pos ||
          (selection.from >= item.lineFrom && selection.to <= item.lineTo),
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

interface MarkOptions {
  word: string;
  taskId: string | null;
  shown: boolean;
}

function markWidget(
  item: TaskItem,
  promote: PromoteContext,
  options: MarkOptions,
): Decoration {
  return Decoration.widget(item.lineTo, (view) => renderMark(view, promote, options), {
    // After the words, never before them, and carrying none of their marks.
    side: 1,
    marks: [],
    // The position leads the key. Two ghosts on two lines are otherwise the
    // same widget to prosemirror-view, which keeps the first one's DOM for
    // the second and lets a click land on the wrong line.
    key: `${item.pos}:${options.taskId ?? "ghost"}:${options.word}:${
      options.shown ? "on" : "off"
    }`,
    ignoreSelection: true,
    stopEvent: () => true,
  });
}

function renderMark(
  view: EditorView,
  promote: PromoteContext,
  options: MarkOptions,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = TASK_MARK_CLASS;
  button.setAttribute("contenteditable", "false");
  button.dataset.state = options.taskId === null ? "ghost" : "linked";
  if (options.shown) button.dataset.shown = "";
  button.textContent = options.word;
  button.setAttribute(
    "aria-label",
    options.taskId === null ? "Make a task" : `Task, ${options.word}`,
  );
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  // The caret stays where the reader left it: a mark is a control beside the
  // line, not a place inside it.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Resolved here and not captured above, for the reason `markTargetOf`
    // spells out.
    const target = markTargetOf(view, button);
    if (target === null) return;
    showMenu(view, target.pos, button, promote);
  });
  return button;
}

/* ── The popover ──────────────────────────────────────────────────────────
 *
 *  Plain DOM on the `brain-menu` material, because the trigger is a
 *  ProseMirror widget and there is no React tree inside the document to hang
 *  a Radix trigger from. The motion is the material's own: `data-state`
 *  drives `materialize-in` at 220 and `materialize-out` at 120 from
 *  `app/globals.css`, and reduced motion swaps both for a crossfade there, so
 *  this file states no curve of its own. The transform origin comes from the
 *  trigger through the same custom property Radix sets.
 */

interface Day {
  today: string;
  tomorrow: string;
}

const MENU_ROWS: { label: string; icon: string; when: (day: Day) => string | null }[] = [
  { label: "Today", icon: "calendar-date-linear", when: (day) => day.today },
  { label: "Tomorrow", icon: "calendar-linear", when: (day) => day.tomorrow },
  { label: "Someday", icon: "box-minimalistic-linear", when: () => "someday" },
  { label: "Inbox", icon: "inbox-linear", when: () => null },
];

interface OpenMenu {
  element: HTMLElement;
  /** Closes it and tells the editor, so the ghost stops being held open. */
  dismiss: (immediate?: boolean) => void;
  /** Takes it away and tells nobody, for an editor that is going away. */
  detach: () => void;
}

let currentMenu: OpenMenu | null = null;
/** True while a create or a reschedule is in flight. One gesture is open at a
 *  time, so one flag is one line's guard. */
let writing = false;

function dismissMenu(immediate = false): void {
  currentMenu?.dismiss(immediate);
}

function detachMenu(): void {
  currentMenu?.detach();
}

function showMenu(
  view: EditorView,
  itemPos: number,
  trigger: HTMLElement,
  promote: PromoteContext,
): void {
  dismissMenu(true);
  trigger.setAttribute("aria-expanded", "true");
  const day: Day = { today: localDay().today, tomorrow: tomorrowOf() };
  const element = document.createElement("div");
  element.className = `brain-menu ${PROMOTE_MENU_CLASS}`;
  element.setAttribute("role", "menu");

  // A refusal is shown where the choice was made, and not in the shell's
  // toast. The toast is the house surface for a route `reason` everywhere the
  // control that asked for it is already gone. Here it is not: this popover
  // is open over the line, and a notice in the corner of the window would ask
  // the reader to look away from the control they are holding and then back
  // at it to pick again. So the menu stays open, the reason sits in it, and
  // the next pick is one press away. The words are still the route's own.
  const refusal = document.createElement("p");
  refusal.className = "brain-menu-label";
  refusal.hidden = true;
  element.append(refusal);

  let dismissed = false;
  const detach = () => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    // Capture, so a scroll inside the note's own container is heard too. A
    // menu fixed to the viewport while its line travels out from under it is
    // how somebody reschedules the wrong task.
    window.removeEventListener("scroll", onViewportMoved, true);
    window.removeEventListener("resize", onViewportMoved);
    trigger.setAttribute("aria-expanded", "false");
    if (currentMenu?.element === element) currentMenu = null;
    element.remove();
  };
  const dismiss = (immediate = false) => {
    if (dismissed) return;
    if (immediate) {
      detach();
      setOpen(view, null);
      return;
    }
    // The retrace plays on the element the material already owns, so it is
    // taken out of the tree only when the 120ms are over.
    const leaving = element;
    detach();
    setOpen(view, null);
    document.body.append(leaving);
    leaving.dataset.state = "closed";
    window.setTimeout(() => leaving.remove(), MENU_EXIT_MS);
  };

  const onPointerDown = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && (element.contains(target) || trigger.contains(target))) {
      return;
    }
    dismiss();
  };
  const onViewportMoved = () => dismiss();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      view.focus();
      return;
    }
    // `role="menu"` promises arrow keys, and the rows are buttons, so Tab and
    // Enter already work.
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    const rows = [...element.querySelectorAll<HTMLElement>(".brain-menu-item")];
    if (rows.length === 0) return;
    event.preventDefault();
    const here = rows.findIndex((row) => row.contains(document.activeElement));
    rows[(here + step + rows.length) % rows.length].focus();
  };

  const date = document.createElement("label");
  date.className = "brain-menu-item";
  const input = document.createElement("input");
  input.type = "date";
  input.className = "brain-task-date";
  input.setAttribute("aria-label", "Date");
  input.addEventListener("change", () => {
    if (input.value) choose(input.value);
  });
  date.append(glyph("calendar-linear"), document.createTextNode("Date…"), input);

  const rowsDisabled = (disabled: boolean) => {
    for (const row of element.querySelectorAll<HTMLElement>(".brain-menu-item")) {
      row.toggleAttribute("data-disabled", disabled);
      if (row instanceof HTMLButtonElement) row.disabled = disabled;
    }
    input.disabled = disabled;
  };

  const choose = (when: string | null) => {
    // One write at a time. Two clicks on one row, or Enter followed by a
    // click, would otherwise mint two records for one checkbox, and two
    // records contending for one line is the state that has no honest
    // reading: the next reconcile detaches whichever loses.
    if (writing) return;
    writing = true;
    rowsDisabled(true);
    void applyChoice(view, trigger, promote, when)
      .finally(() => {
        writing = false;
        rowsDisabled(false);
      })
      .then((reason) => {
        if (reason === null) {
          dismiss();
          // The keyboard came from the note and goes back to it.
          view.focus();
          return;
        }
        refusal.hidden = false;
        refusal.textContent = reason;
      });
  };

  for (const row of MENU_ROWS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "brain-menu-item";
    button.setAttribute("role", "menuitem");
    button.append(glyph(row.icon), document.createTextNode(row.label));
    button.addEventListener("click", () => choose(row.when(day)));
    element.append(button);
  }
  element.append(date);

  document.body.append(element);
  place(element, trigger);
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onViewportMoved, true);
  window.addEventListener("resize", onViewportMoved);
  currentMenu = { element, dismiss, detach };
  setOpen(view, itemPos);
  element.dataset.state = "open";
  element.querySelector<HTMLElement>(".brain-menu-item")?.focus();
}

/** Under the trigger, inside the window's right edge, flipped above it when
 *  there is no room below. The same rule the caret-anchored menus use. */
function place(element: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const height = element.offsetHeight;
  const above = shouldFlipAbove(
    { top: rect.top, bottom: rect.bottom },
    window.innerHeight,
    height,
  );
  element.style.left = `${Math.max(
    EDGE_GUTTER,
    Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE_GUTTER),
  )}px`;
  element.style.top = `${
    above ? rect.top - height - MENU_GAP : rect.bottom + MENU_GAP
  }px`;
  element.style.setProperty(
    "--radix-popover-content-transform-origin",
    above ? "bottom left" : "top left",
  );
}

function glyph(name: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "brain-menu-icon");
  svg.innerHTML = SOLAR[name as keyof typeof SOLAR] ?? "";
  return svg;
}

/* ── The two writes ──────────────────────────────────────────────────────── */

/** Null on success, else the words the menu should show.
 *
 *  The line and its record are resolved from the trigger and the live
 *  document HERE, at the moment of the write, not when the menu opened: the
 *  document can move underneath an open menu, and the whole point of the
 *  anchor is that the record names the line the person pointed at. */
async function applyChoice(
  view: EditorView,
  trigger: HTMLElement,
  promote: PromoteContext,
  when: string | null,
): Promise<string | null> {
  const target = markTargetOf(view, trigger);
  if (target === null) return "That line has gone";
  return target.taskId === null
    ? promoteLine(view, target.index, promote, when)
    : reschedule(view, target.taskId, when);
}

async function promoteLine(
  view: EditorView,
  index: number,
  promote: PromoteContext,
  when: string | null,
): Promise<string | null> {
  const state = promoteKey.getState(view.state);
  const page = state?.page ?? null;
  if (page === null) return "This note cannot hold a task";

  const items = taskItemsOf(view.state.doc);
  if (index >= items.length) return "That line has gone";

  // The anchor is built from the markdown the store is about to receive, not
  // from the position in the document. `line` is a markdown line number, and
  // the text and the hash have to be the ones `parseTaskLines` reads, or the
  // store's first reconcile will not find the line.
  const markdown = promote.markdownOf(view.state.doc);
  if (markdown === null) return "This note could not be read";
  const lines = parseTaskLines(markdown);
  if (lines.length !== items.length) return "This note could not be read";
  const line = lines[index];
  if (line.normalized === "") return "Write the line first";

  const body: Record<string, unknown> = {
    title: line.normalized,
    page,
    anchor: {
      text: line.normalized,
      hash: line.hash,
      ordinal: line.ordinal,
      line: line.index,
    },
  };
  if (when !== null) body.when = when;
  const category = await pageCategory(page);
  if (category !== null) body.category = category;

  try {
    const response = await apiFetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return await refusalOf(response);
    const answer = (await response.json()) as { task: TaskView };
    publishTasks(view, [...(promoteKey.getState(view.state)?.tasks ?? []), answer.task]);
    return null;
  } catch {
    return "The task could not be saved";
  }
}

async function reschedule(
  view: EditorView,
  taskId: string,
  when: string | null,
): Promise<string | null> {
  try {
    const response = await apiFetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ when }),
    });
    if (!response.ok) return await refusalOf(response);
    const answer = (await response.json()) as { task: TaskView };
    publishTasks(
      view,
      (promoteKey.getState(view.state)?.tasks ?? []).map((task) =>
        task.id === taskId ? answer.task : task,
      ),
    );
    return null;
  } catch {
    return "The task could not be saved";
  }
}

/** Every task route answers `{ error, reason? }`, so a caller shows `reason`
 *  when there is one. */
async function refusalOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const shape = body as { error?: unknown; reason?: unknown };
      if (typeof shape.reason === "string") return shape.reason;
      if (typeof shape.error === "string") return shape.error;
    }
  } catch {
    // a body that is not JSON says nothing a reader can act on
  }
  return `The task could not be saved (${response.status})`;
}

/** The page's own category, which a new task takes as its default. A category
 *  is a default and never a requirement, so a page whose meta cannot be read
 *  still yields a task. */
async function pageCategory(page: string): Promise<string | null> {
  try {
    const response = await apiFetch(`/api/page/${page}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { meta?: { category?: unknown } };
    const category = body.meta?.category;
    return typeof category === "string" && category !== "" ? category : null;
  } catch {
    return null;
  }
}

export const taskCheckbox = [taskCheckboxView, taskSplitKeymap, taskPromote];
