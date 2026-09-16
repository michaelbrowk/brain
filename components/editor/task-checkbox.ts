import { serializerCtx } from "@milkdown/kit/core";
import { listItemSchema } from "@milkdown/kit/preset/commonmark";
import { keymap } from "@milkdown/kit/prose/keymap";
import type { Node as ProseNode, NodeType, ResolvedPos } from "@milkdown/kit/prose/model";
import { liftListItem, splitListItem, wrapRangeInList } from "@milkdown/kit/prose/schema-list";
import { EditorState, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import { canSplit } from "@milkdown/kit/prose/transform";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@milkdown/kit/prose/view";
import { $command, $prose, $view } from "@milkdown/kit/utils";

import { localDay, onDayChange } from "@/components/tasks-client";
import {
  prefersReducedMotion,
  renderTaskCheckbox,
  setTaskCheckboxChecked,
  setTaskCheckboxLabel,
} from "@/components/tasks-checkbox";
import { dayLabel } from "@/components/tasks-lists";
import { renderWhenPicker, type WhenValue } from "@/components/tasks-when-picker";
import { SOLAR } from "@/components/ui/solar-icons.generated";
import { apiFetch } from "@/lib/client";
import { notifyEditorDocChanged, TASKS_CHANGED_EVENT } from "@/lib/editor-events";
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
    if (!isTaskItem(initial)) return undefined as unknown as NodeView;

    const dom = document.createElement("li");
    dom.className = "brain-task-item";
    dom.setAttribute("data-item-type", "task");

    const contentDOM = document.createElement("div");
    contentDOM.className = "brain-task-body";

    const toggle = () => {
      const pos = getPos();
      if (pos == null) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || !isTaskItem(node)) return;
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
        if (!isTaskItem(node)) return false;
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
/** The popover, on the `brain-menu` material at the list menu's own 264: it
 *  holds one short word and the When picker's seven 36px day cells. */
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
/** 264, which is the list menu's own width and the seven 36px day cells of
 *  the When picker inside this popover. */
const MENU_WIDTH = 264;
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
    if (!isTaskItem(node)) return;
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
  // A DIALOG, WHICH IS WHAT IT OPENS. The panel holds a month grid and two
  // spinbuttons, so it stopped being a menu when the grid arrived, and the
  // arrow-key row walking that made it one went with the role.
  button.setAttribute("aria-haspopup", "dialog");
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

/** THE ONE ROW THE PICKER DOES NOT DRAW.
 *
 *  This popover IS the picker, with the note's own Inbox above it. Today,
 *  This Evening and Someday are the picker's own quick rows and Tomorrow is a
 *  cell in its grid, so a list of four here drew Today twice and Someday
 *  twice, four rows apart, and read as a bug. Inbox is the one word left: a
 *  task with no day at all, which no grid can say. */
const MENU_ROWS: { label: string; icon: string; when: (day: Day) => WhenValue }[] = [
  {
    label: "Inbox",
    icon: "inbox-linear",
    when: () => ({ when: null, evening: false, time: null }),
  },
];

interface OpenMenu {
  element: HTMLElement;
  /** Closes it and tells the editor, so the ghost stops being held open. */
  dismiss: (immediate?: boolean) => void;
  /** Takes it away and tells nobody, for an editor that is going away. */
  detach: () => void;
}

let currentMenu: OpenMenu | null = null;
/** True while a create or a reschedule is in flight. ONE WRITE AT A TIME for
 *  the line, across panels: a reader can press the mark again with a write
 *  still out, and the panel that opens over it is refused out loud rather than
 *  minting a second record for one checkbox. */
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
  // A DIALOG AND NOT A MENU. `role="menu"` may own menu items and nothing
  // else, and what stands in here is a month grid, two spinbuttons and four
  // checkbox rows: a screen reader told this was a menu would not expose the
  // grid as a grid. The panel carries the picker's own name for the same
  // reason the row's popover does.
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "When");

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
  /** The picker's element lives INSIDE this popover and holds no listener
   *  outside itself, so it leaves when the popover leaves and there is
   *  nothing here to destroy separately. */
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
    // THE PICKER ANSWERS ITS OWN ARROWS, and nothing else here answers any.
    // Its grid is a roving cell walked with all four of them; a panel that
    // also stepped between rows would move the focus out from under a reader
    // halfway across a month. The one row above it is a button, so Tab and
    // Enter reach it already.
  };

  /** The popover's own row. Held as a list rather than re-queried, because
   *  the picker below it draws `brain-menu-item` rows of its own and those
   *  are not this panel's. */
  const rows: HTMLButtonElement[] = [];

  /** The record a write from this panel has already made, so a second word
   *  moves it rather than minting a second one. See `applyChoice`. */
  let filed: string | null = null;
  /** WHAT THE RECORD SAYS, as far as this panel knows: the value the line
   *  carried when the panel opened, and then every value a route has TAKEN.
   *  It is what a clearing gesture is measured against, because a PATCH that
   *  leaves a field unnamed leaves that field standing: the reader switching the
   *  reminder off has to send `time: null`, and only a comparison with the
   *  record can tell that gesture from one that never touched the clock. The
   *  picker keeps the same belief for its own no-op rule; this is the note's,
   *  because the request body is written here. */
  let record: WhenValue | null = null;
  /** THIS PANEL'S OWN WRITE IS OUT. `writing` is the line's flag and one panel
   *  can open over another's write, so the panel that is waiting has to know
   *  which of the two it is: only its own write keeps it standing, and only
   *  its own write makes Escape a close rather than a cancel. */
  let sending = false;

  /** THE PANEL IS WAITING ON ITS ONE WRITE, and the row above the picker says
   *  so with it. The picker draws its own waiting state (`aria-busy`, quiet
   *  rows, a disabled Done); this row is the note's, drawn here, and a control
   *  that stayed lit while the panel was inert would be the one press this
   *  panel cannot answer. */
  const setBusy = (busy: boolean): void => {
    if (busy) element.setAttribute("aria-busy", "true");
    else element.removeAttribute("aria-busy");
    for (const row of rows) row.setAttribute("aria-disabled", String(busy));
  };

  /** True once the route took the value, false once it refused it, which is
   *  what the picker reads to decide whether the record has moved.
   *
   *  ONE WRITE AT A TIME, AND NO QUEUE. Two POSTs for one checkbox would leave
   *  two records contending for one line, and a queue of words waiting their
   *  turn was worse: it filed a value the reader could no longer see, and told
   *  each caller about somebody else's write. So the panel goes inert the
   *  moment a value leaves and comes back on the answer, and the presses made
   *  in between are not taken at all. */
  const choose = async (value: WhenValue): Promise<boolean> => {
    // A WRITE FROM THE PANEL BEFORE THIS ONE. Every control this panel holds
    // is inert while its own write is out, so the only caller that reaches
    // here is one in a panel opened over a line that is already saving. It is
    // refused, because two records contending for one checkbox is the state
    // with no honest reading, and it is refused out loud.
    if (writing) {
      refusal.hidden = false;
      refusal.textContent = "The last change is still saving";
      return false;
    }
    writing = true;
    sending = true;
    setBusy(true);
    let reason: string | null;
    try {
      const result = await applyChoice(view, trigger, promote, value, filed, record);
      reason = result.reason;
      if (result.taskId !== null) filed = result.taskId;
      // A value the route took IS the record now, and the next gesture is
      // measured against it rather than against the day the panel opened on.
      if (result.reason === null) record = { ...value };
    } finally {
      writing = false;
      sending = false;
      setBusy(false);
    }
    if (reason !== null) {
      // A REASON WITH NO PANEL LEFT TO SHOW IT IS DROPPED. Escape and a scroll
      // both close this popover with the write still out, and the words would
      // go into a node that has left the document, where nobody reads them.
      // The line stays a ghost, which is the report that nothing was filed.
      if (!dismissed) {
        refusal.hidden = false;
        refusal.textContent = reason;
      }
      return false;
    }
    // The panel this write belonged to may have gone (Escape, a scroll) and
    // the reader is somewhere else: there is nothing to dismiss and no focus
    // of theirs to take.
    if (dismissed) return true;
    dismiss();
    // The keyboard came from the note and goes back to it.
    view.focus();
    return true;
  };

  // WHAT THE LINE ALREADY SAYS. A line that is already a task opens the panel
  // on its own day, its own evening and its own clock: the picker draws the
  // record rather than a blank, and `Clear` on a line with a date clears it
  // instead of repeating a value the picker was told the record had. A line
  // that is not a task yet opens on nothing set and on NO baseline, so the
  // same `Clear` files it with no day the way the Inbox row above does: the
  // two were one word apart and did opposite things.
  const opened = whenOfLine(view, trigger);
  record = opened;
  const picker = renderWhenPicker({
    value: opened ?? { when: null, evening: false, time: null },
    baseline: opened,
    today: day.today,
    mode: "when",
    reduce: prefersReducedMotion(),
    // THE WHOLE VALUE. This Evening files the line in the evening and a grid
    // day arrives with its reminder, rather than the panel offering a section
    // and the write quietly dropping it.
    onPick: choose,
    // THE WRITE GOES OUT BEFORE THE PANEL DOES, which is the opposite of the
    // row's popover and for the reason the refusal above spells out: a route
    // that says no has to say it on the control the reader is holding. So the
    // dismissal waits for `choose`, which dismisses on success and shows the
    // reason on a refusal.
    onDone: () => {
      // ESCAPE ON A WAITING PANEL IS THE ONE PRESS THAT REACHES HERE while
      // this panel's write is out, because every other control is inert. It
      // closes and cancels nothing: the value is with the route, and the line
      // will say what the route made of it.
      if (sending) {
        dismiss();
        view.focus();
        return;
      }
      // A REASON BELONGS TO THE PRESS THAT GOT IT. The next press clears the
      // line before it asks, so what stands there is always an answer to the
      // word the reader last named.
      refusal.hidden = true;
      refusal.textContent = "";
      picker.commit();
      // The panel stands while its write is out, and stands on a reason the
      // press put there a moment ago: a route that says no says it on the control
      // the reader is holding.
      if (sending || !refusal.hidden) return;
      dismiss();
      view.focus();
    },
  });

  for (const row of MENU_ROWS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "brain-menu-item";
    button.append(glyph(row.icon), document.createTextNode(row.label));
    // THE PICKER ANSWERS THIS ROW TOO. Inbox and the picker's Clear are one
    // word apart and mean the same thing, so they cannot keep different rules:
    // handed down here, this press takes the no-op rule (a line already in the
    // Inbox sends nothing), the waiting state (a press made while a write is
    // out does nothing at all) and the refusal path (the panel stands, the
    // reason sits in it, the next press writes) that every row below it keeps.
    button.addEventListener("click", () => picker.pick(row.when(day)));
    rows.push(button);
    element.append(button);
  }
  // The same control the Tasks column draws, mounted as DOM because this
  // popover is a ProseMirror widget with no React tree inside it. No sheet on
  // touch here: this is already a popover over the line at every width.
  //
  // The scroller is the same one the row's own picker rides, class for class,
  // so a short window scrolls the grid here too rather than putting Done off
  // the bottom of the screen. `place()` below measures the room and writes it
  // where the rule reads it.
  const scroller = document.createElement("div");
  scroller.className = "edge-fade overflow-y-auto brain-when-scroll";
  scroller.append(picker.element);
  element.append(scroller);

  document.body.append(element);
  place(element, trigger);
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onViewportMoved, true);
  window.addEventListener("resize", onViewportMoved);
  currentMenu = { element, dismiss, detach };
  setOpen(view, itemPos);
  element.dataset.state = "open";
  rows[0]?.focus();
}

/** Under the trigger, inside the window's right edge, flipped above it when
 *  there is no room below. The same rule the caret-anchored menus use. */
function place(element: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const above = shouldFlipAbove(
    { top: rect.top, bottom: rect.bottom },
    window.innerHeight,
    element.offsetHeight,
  );
  // THE ROOM ON THE SIDE IT LANDS ON. The popover carries a month grid now,
  // and there are windows that hold neither side of it whole, so the grid
  // scrolls inside the material the way it does under a row. The property is
  // Radix's name for the same measurement, because the CSS that reads it is
  // the same CSS.
  element.style.setProperty(
    "--radix-popover-content-available-height",
    `${Math.max(
      0,
      (above ? rect.top : window.innerHeight - rect.bottom) - MENU_GAP - EDGE_GUTTER,
    )}px`,
  );
  // THE FLOATING TAB BAR IS BELOW, so a panel that landed ABOVE the line owes
  // it nothing: the room it was given is measured from the top of the window
  // down, and subtracting the bar as well took ~84px of grid away on a phone
  // for a bar the panel never reaches. The rule reads the property; this says
  // there is no bar on this side.
  element.style.setProperty("--tabbar-reserve", above ? "0px" : "");
  const height = element.offsetHeight;
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

/** WHAT THE LINE'S OWN RECORD SAYS, which is where the picker opens.
 *
 *  The panel is a claim about the line it stands over, so a task already filed
 *  in Today opens with Today checked and that cell selected, and the picker's
 *  no-op rule measures every press against the record rather than against a
 *  blank. `null` is a line with no record at all, which is not the same claim
 *  as a record with no day: there is nothing for a press to repeat, so every
 *  word in the panel writes. */
function whenOfLine(view: EditorView, trigger: HTMLElement): WhenValue | null {
  const id = markTargetOf(view, trigger)?.taskId ?? null;
  if (id === null) return null;
  const task = (promoteKey.getState(view.state)?.tasks ?? []).find(
    (entry) => entry.id === id,
  );
  if (task === undefined) return null;
  return {
    when: task.when ?? null,
    evening: task.evening === true,
    time: task.time ?? null,
  };
}

/* ── The two writes ──────────────────────────────────────────────────────── */

/** What one press of the panel did: the record it left behind, and the words
 *  the panel should show when the route said no.
 *
 *  The line and its record are resolved from the trigger and the live
 *  document HERE, at the moment of the write, not when the menu opened: the
 *  document can move underneath an open menu, and the whole point of the
 *  anchor is that the record names the line the person pointed at.
 *
 *  `filed` is the exception, and it is not a cached position: it is the record
 *  a write from THIS panel already made. The mark is redrawn the moment the
 *  line gets its word, so the trigger a second press was resolved from is no
 *  longer in the document, and resolving through it again would answer "That
 *  line has gone" about a line that is right there. */
interface ChoiceResult {
  taskId: string | null;
  reason: string | null;
}

async function applyChoice(
  view: EditorView,
  trigger: HTMLElement,
  promote: PromoteContext,
  value: WhenValue,
  filed: string | null,
  /** What the record says, for the fields a gesture can CLEAR. `null` is a
   *  line with no record behind it yet, where nothing can be cleared and only
   *  what the reader set is sent. */
  record: WhenValue | null,
): Promise<ChoiceResult> {
  // THE WHOLE OF IT IS INSIDE THE TRY, the reading of the document as much as
  // the request. `markTargetOf` and the markdown the anchor is built from walk
  // a live ProseMirror document, and a throw there used to reject the caller:
  // the panel stood mute with no reason and no dismissal, waiting on a write
  // that had already failed. It takes a programming error to reach, and a
  // programming error is the case that most needs to end in a sentence.
  try {
    if (filed !== null) {
      return { taskId: filed, reason: await reschedule(view, filed, value, record) };
    }
    const target = markTargetOf(view, trigger);
    if (target === null) return { taskId: null, reason: "That line has gone" };
    if (target.taskId === null) return await promoteLine(view, target.index, promote, value);
    return {
      taskId: target.taskId,
      reason: await reschedule(view, target.taskId, value, record),
    };
  } catch {
    return { taskId: filed, reason: "The task could not be saved" };
  }
}

/** The two fields that only travel with a day.
 *
 *  `lib/tasks/model.ts` refuses a clock or an evening without one, and the
 *  store drops both when a patch takes the day away, so neither is named on a
 *  value with no day of its own.
 *
 *  ONLY WHAT THE GESTURE CHANGED, and `null` IS A CHANGE. This only ever ADDED
 *  the two, so switching the reminder off sent `{ when, evening: true }` and
 *  the clock stayed on the record: the panel reopened showing the time the
 *  reader had cleared a moment before, and the reminder went on firing. A patch that
 *  leaves a field unnamed leaves that field standing, so clearing one means sending
 *  `null` for it, which can only be told from a gesture that never touched it
 *  by comparing against what the record says. `record` is that answer, and
 *  `null` is a line with no record yet: nothing there can be cleared, so only
 *  what the reader set travels. `components/tasks-actions.ts` does the same
 *  comparison for the row's own When chip. */
function extras(value: WhenValue, record: WhenValue | null): Record<string, unknown> {
  if (value.when === null || value.when === "someday") return {};
  if (record === null) {
    return {
      ...(value.time !== null ? { time: value.time } : {}),
      ...(value.evening ? { evening: true } : {}),
    };
  }
  return {
    ...(value.time !== record.time ? { time: value.time } : {}),
    ...(value.evening !== record.evening
      ? { evening: value.evening ? true : null }
      : {}),
  };
}

async function promoteLine(
  view: EditorView,
  index: number,
  promote: PromoteContext,
  value: WhenValue,
): Promise<ChoiceResult> {
  const refused = (reason: string): ChoiceResult => ({ taskId: null, reason });
  const state = promoteKey.getState(view.state);
  const page = state?.page ?? null;
  if (page === null) return refused("This note cannot hold a task");

  const items = taskItemsOf(view.state.doc);
  if (index >= items.length) return refused("That line has gone");

  // The anchor is built from the markdown the store is about to receive, not
  // from the position in the document. `line` is a markdown line number, and
  // the text and the hash have to be the ones `parseTaskLines` reads, or the
  // store's first reconcile will not find the line.
  const markdown = promote.markdownOf(view.state.doc);
  if (markdown === null) return refused("This note could not be read");
  const lines = parseTaskLines(markdown);
  if (lines.length !== items.length) return refused("This note could not be read");
  const line = lines[index];
  if (line.normalized === "") return refused("Write the line first");

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
  if (value.when !== null) body.when = value.when;
  // A CREATE HAS NO RECORD TO DIFFER FROM: nothing on it can be cleared, so
  // only what the reader set is named.
  Object.assign(body, extras(value, null));
  const category = await pageCategory(page);
  if (category !== null) body.category = category;

  try {
    const response = await apiFetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return refused(await refusalOf(response));
    const answer = (await response.json()) as { task: TaskView };
    publishTasks(view, [...(promoteKey.getState(view.state)?.tasks ?? []), answer.task]);
    return { taskId: answer.task.id, reason: null };
  } catch {
    return refused("The task could not be saved");
  }
}

async function reschedule(
  view: EditorView,
  taskId: string,
  value: WhenValue,
  record: WhenValue | null,
): Promise<string | null> {
  try {
    const response = await apiFetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ when: value.when, ...extras(value, record) }),
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

/* ── The Task command ───────────────────────────────────────────────────── */

/** A task item, and not a plain bullet: the gfm preset leaves `checked` null
 *  on a bullet and sets a boolean on a task. THE one reading of that
 *  question, and every site in this file that asks it comes here: the
 *  NodeView, the promote walk that counts the items, and the targets a press
 *  collects. No two of them can answer differently about the same item.
 *  Whether a task is DONE is a different question, and reads `=== true`. */
function isTaskItem(node: ProseNode): boolean {
  return node.type.name === "list_item" && node.attrs.checked != null;
}

/** Whether a resolved position sits inside a blockquote. Walks the ancestor
 *  chain the way `isInTable` walks it for table context. */
export function isInQuote($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "blockquote") return true;
  }
  return false;
}

/** A TASK LINE CANNOT LIVE INSIDE A QUOTE.
 *
 *  `> * [ ] x` is a checkbox to the editor and prose to `TASK_LINE_RE`, whose
 *  `^\s*[-*+]` has no room for the `>`. One quoted task line on a page is
 *  enough for `promoteLine`'s `lines.length !== items.length` guard to fire,
 *  and every + Task on that page then answers "This note could not be read".
 *
 *  So both controls refuse it, the way they already refuse a table: the
 *  toolbar's button is disabled and says why, and the slash menu has no Task
 *  row inside a quote. The command refuses it again for anything that reaches
 *  it another way. */
export function selectionIsInQuote(state: Pick<EditorState, "selection">): boolean {
  return isInQuote(state.selection.$from) || isInQuote(state.selection.$to);
}

/** The depth of the nearest `list_item` above a position, or -1 for a block
 *  standing in no list at all. */
function listItemDepth($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "list_item") return depth;
  }
  return -1;
}

/** The range of the slash trigger a menu pick leaves behind, handed to the
 *  command rather than deleted before it.
 *
 *  The deletion and the conversion then land in ONE transaction: the typed
 *  `/task` and the line it became come back together on a single undo, and
 *  the words are never gone while the conversion is still deciding. */
export interface TaskTrigger {
  from: number;
  to: number;
}

/** One line a press acts on.
 *
 *  A list item IS the line, and the press changes that item: the siblings
 *  above and below it are no part of the press. A textblock standing in no
 *  item is a line with no item yet, and the press gives it one.
 *
 *  A joined block range is what used to reach past the selection. It runs
 *  from the first block of the range to the last, so a press on the second
 *  bullet of a list took the first one with it and nested the second. */
type TaskTarget =
  | { kind: "item"; pos: number; task: boolean; ordered: boolean }
  | { kind: "block"; pos: number; end: number };

/** Nothing sane nests a list this deep. The bound is here so a schema that
 *  surprises the lift ends the loop rather than the session. */
const MAX_LIFTS = 12;

/** What a list item looks like once it stands in a bullet list. An ordered
 *  item carries its number in `label` and `ordered` in `listType`, and both
 *  have to follow the item into its new list, or it draws a `1.` beside its
 *  own checkbox. */
const BULLET_ITEM_ATTRS = { label: "•", listType: "bullet" };

/** The lines the selection touches, in document order, and nothing else. */
function taskTargets(doc: ProseNode, from: number, to: number): TaskTarget[] {
  const targets: TaskTarget[] = [];
  const seen = new Set<number>();
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const $block = doc.resolve(pos);
    if ($block.parent.type.name !== "list_item") {
      // A heading, a code block, a math block: a line the press leaves where
      // it is. A heading pressed on its own is already left alone, because a
      // `list_item` wants a paragraph first and the wrap refuses, so one
      // caught in a longer selection is left alone too rather than swallowed
      // as the second block of the task above it.
      if (node.type.name !== "paragraph") return false;
      targets.push({ kind: "block", pos, end: pos + node.nodeSize });
      return false;
    }
    // An item with two paragraphs in it is still one line, and one press.
    const itemPos = $block.before($block.depth);
    if (seen.has(itemPos)) return false;
    seen.add(itemPos);
    targets.push({
      kind: "item",
      pos: itemPos,
      task: isTaskItem($block.parent),
      ordered: $block.node($block.depth - 1).type.name === "ordered_list",
    });
    return false;
  });
  return targets;
}

/** Whether every line the selection touches is already a task.
 *
 *  What the toolbar's `aria-pressed` says AND what decides which way a press
 *  goes, read off the same lines by the same walk, so the button and the
 *  action cannot disagree about a selection that spans a task and a
 *  paragraph. */
export function selectionIsTask(state: Pick<EditorState, "doc" | "selection">): boolean {
  const targets = taskTargets(state.doc, state.selection.from, state.selection.to);
  return targets.length > 0 && targets.every((t) => t.kind === "item" && t.task);
}

/** A bullet item becomes a task where it stands: one attribute on the item
 *  that is already there. No wrap, so it cannot nest, and no range, so the
 *  sibling above it is no part of the press.
 *
 *  `rebullet` is for an item fresh out of an ordered list and nothing
 *  else: the attributes an item already sitting in a bullet list carries are
 *  its own, and a press has no business rewriting them. */
function markItemAsTask(tr: Transaction, pos: number, rebullet = false) {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.type.name !== "list_item") return;
  tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    ...(rebullet ? BULLET_ITEM_ATTRS : {}),
    checked: false,
  });
}

/** `checked: false` on the items a wrap created, and on nothing else. */
function markNewItemsAsTask(tr: Transaction, from: number, to: number) {
  const positions: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "list_item" && !isTaskItem(node)) positions.push(pos);
  });
  for (const pos of positions) markItemAsTask(tr, pos);
}

/** A run of adjacent blocks becomes one list of task items. Adjacent, so one
 *  wrap covers the run rather than leaving a list per line, and bounded by
 *  the run, so a list standing beside it keeps its own items. */
function wrapBlocksAsTasks(
  tr: Transaction,
  from: number,
  to: number,
  bulletListType: NodeType,
) {
  const range = tr.doc.resolve(from + 1).blockRange(tr.doc.resolve(to - 1));
  if (!range) return;
  const base = tr.steps.length;
  if (!wrapRangeInList(tr, range, bulletListType)) return;
  const moved = tr.mapping.slice(base);
  markNewItemsAsTask(tr, moved.map(range.start, -1), moved.map(range.end, 1));
}

/** An ordered item becomes a bullet task item at the same depth.
 *
 *  The list is split around the item the way a lift splits one, and the piece
 *  left holding the item becomes a bullet list. `1. [ ] text` is not a task
 *  line to `TASK_LINE_RE`, so writing one drew a checkbox that
 *  `parseTaskLines` could not see: the counts disagreed and every + Task on
 *  the page answered "This note could not be read". */
function convertOrderedItem(
  tr: Transaction,
  pos: number,
  bulletListType: NodeType,
): number | null {
  const item = tr.doc.nodeAt(pos);
  if (!item) return null;
  const $item = tr.doc.resolve(pos);
  const list = $item.parent;
  const index = $item.index();
  const base = tr.steps.length;
  // The later split first, so it does not move the earlier one.
  const end = pos + item.nodeSize;
  const tailSplit = index < list.childCount - 1 && canSplit(tr.doc, end, 1);
  if (tailSplit) tr.split(end, 1);
  if (index > 0 && canSplit(tr.doc, pos, 1)) tr.split(pos, 1);
  const itemPos = tr.mapping.slice(base).map(pos);
  const $now = tr.doc.resolve(itemPos);
  if ($now.parent.type.name !== "ordered_list") return itemPos;
  if (tailSplit) keepTailCounting(tr, $now, list.attrs.order, index);
  tr.setNodeMarkup($now.before($now.depth), bulletListType, { spread: list.attrs.spread });
  return itemPos;
}

/** The piece of an ordered list below the press goes on counting.
 *
 *  `tr.split` copies the list's own attributes, `order` among them, so the
 *  tail restarted at the number the head began with: `3. / 4. / 5.` with the
 *  middle line pressed read `3.`, the task, `3.`. The line that left is not a
 *  numbered line any more, so the count carries on over the lines that are:
 *  `3.`, the task, `4.`. The preset's own `syncListOrderPlugin` reads `order`
 *  back off the list and relabels the items under it. */
function keepTailCounting(
  tr: Transaction,
  $item: ResolvedPos,
  order: unknown,
  index: number,
) {
  const tailPos = $item.after($item.depth);
  const tail = tr.doc.nodeAt(tailPos);
  if (!tail || tail.type.name !== "ordered_list") return;
  tr.setNodeMarkup(tailPos, undefined, {
    ...tail.attrs,
    order: (typeof order === "number" ? order : 1) + index,
  });
}

/** The siblings BELOW the pressed item stay in the list they were in.
 *
 *  `liftListItem` hands the items following the one it lifts to that item as
 *  children, which is right for the one lift it performs. The next lift then
 *  carried them out of the parent with it, so a press on one nested task took
 *  the two below it up a level with it, and neither was ever selected.
 *
 *  Moving them above the pressed item first leaves the lift nothing borrowed
 *  to carry. Only a nested list borrows: a list standing in no item splits
 *  around the lifted line instead, and its siblings keep their depth and
 *  their order both. */
function hoistFollowingSiblings(tr: Transaction, $inside: ResolvedPos): void {
  const depth = listItemDepth($inside);
  if (depth < 2 || $inside.node(depth - 2).type.name !== "list_item") return;
  const itemEnd = $inside.after(depth);
  const listEnd = $inside.end(depth - 1);
  if (itemEnd >= listEnd) return;
  const tail = tr.doc.slice(itemEnd, listEnd).content;
  tr.delete(itemEnd, listEnd);
  tr.insert($inside.before(depth), tail);
}

/** A task item becomes a paragraph, however deep it sat, on ONE press.
 *
 *  A single lift only outdents a nested item, which left the line a task one
 *  level out: pressed, pressed again, still a checkbox. The item's own
 *  children come out with it and stand as a list under the paragraph. */
function liftItemToParagraph(tr: Transaction, pos: number, listItemType: NodeType) {
  let blockPos = pos + 1;
  for (let lift = 0; lift < MAX_LIFTS; lift += 1) {
    if (blockPos + 1 > tr.doc.content.size) return;
    let $inside = tr.doc.resolve(blockPos + 1);
    if (listItemDepth($inside) < 0) return;
    const hoisted = tr.steps.length;
    hoistFollowingSiblings(tr, $inside);
    if (tr.steps.length !== hoisted) {
      blockPos = tr.mapping.slice(hoisted).map(blockPos);
      $inside = tr.doc.resolve(blockPos + 1);
    }
    const base = tr.steps.length;
    // A bare state over the transaction's own document: `liftListItem` reads
    // a selection and writes steps, and the steps it writes are against this
    // document, so they belong in this transaction. One press, one undo.
    const bare = EditorState.create({
      doc: tr.doc,
      selection: TextSelection.near($inside),
    });
    liftListItem(listItemType)(bare, (sub) => {
      for (const step of sub.steps) tr.step(step);
    });
    if (tr.steps.length === base) return;
    blockPos = tr.mapping.slice(base).map(blockPos);
  }
}

/** The press, both routes.
 *
 *  The rule the whole of it serves: the command acts on the blocks the
 *  selection touches, in place, and nowhere else. A paragraph gains a task
 *  item, a bullet becomes one where it stands, an ordered item moves to a
 *  bullet list at its own depth, and a task goes back to a paragraph.
 *
 *  `mode` decides only what a line that is ALREADY a task does: the slash
 *  menu's Task leaves it alone, the toolbar's Task takes it back. */
function taskCommand(mode: "ensure" | "toggle", trigger: TaskTrigger | null): Command {
  return (state, dispatch) => {
    const bulletListType = state.schema.nodes.bullet_list;
    const listItemType = state.schema.nodes.list_item;
    if (!bulletListType || !listItemType) return false;

    // Refused whole, and before the trigger is touched: the `/task` the
    // reader typed stays on the line rather than being deleted for a
    // conversion that cannot happen.
    if (selectionIsInQuote(state)) return false;

    const tr = state.tr;
    if (trigger !== null && trigger.to > trigger.from && trigger.to <= tr.doc.content.size) {
      tr.delete(trigger.from, trigger.to);
    }
    const targets = taskTargets(tr.doc, tr.selection.from, tr.selection.to);
    if (targets.length === 0) return false;

    // One answer for the whole selection. Every line a task means the press
    // takes them all back to paragraphs; anything else means it makes them
    // all tasks. `selectionIsTask` asks the same question of the same lines.
    const lift = mode === "toggle" && selectionIsTask({ doc: tr.doc, selection: tr.selection });
    const steps = tr.steps.length;

    // Backwards through the document, so converting one line never moves a
    // line still waiting for its own conversion.
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (target.kind === "item") {
        if (lift) {
          liftItemToParagraph(tr, target.pos, listItemType);
          continue;
        }
        // Already a task: nothing to do, and `checked: true` is not something
        // a press that leaves the line a task may drop on the floor.
        if (target.task) continue;
        if (!target.ordered) {
          markItemAsTask(tr, target.pos);
          continue;
        }
        const moved = convertOrderedItem(tr, target.pos, bulletListType);
        if (moved !== null) markItemAsTask(tr, moved, true);
        continue;
      }
      if (lift) continue;
      let first = i;
      let firstPos = target.pos;
      while (first > 0) {
        const previous = targets[first - 1];
        if (previous.kind !== "block" || previous.end !== firstPos) break;
        firstPos = previous.pos;
        first -= 1;
      }
      wrapBlocksAsTasks(tr, firstPos, target.end, bulletListType);
      i = first;
    }

    if (tr.steps.length === steps && !tr.docChanged) return mode === "ensure";
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/** NO TASK ITEM EVER STANDS UNDER AN ORDERED LIST.
 *
 *  The Task press moves an ordered item to a bullet one, and nobody presses
 *  anything when a note is opened, pasted into, or imported from Notion.
 *  `TASK_LINE_RE` in `lib/tasks/task-lines.ts` reads `- [ ]` and nothing
 *  else, so `1. [ ] b` draws a checkbox the editor understands and the store
 *  cannot see, and one such line makes every + Task on the page answer "This
 *  note could not be read".
 *
 *  Every way in lands here: the document the editor opened with, through the
 *  plugin's view, and every transaction after it, through
 *  `appendTransaction`. The store's regex is left alone — the editor holds
 *  the shape the store already reads.
 */
function orderedTaskItems(doc: ProseNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (parent?.type.name === "ordered_list" && isTaskItem(node)) positions.push(pos);
  });
  return positions;
}

/** The item keeps whatever `checked` it arrived with: an imported `1. [x]` is
 *  a task that is done, and re-bulleting it is not un-ticking it. */
function rebulletItem(tr: Transaction, pos: number) {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.type.name !== "list_item") return;
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...BULLET_ITEM_ATTRS });
}

function everyChildIsTask(list: ProseNode): boolean {
  let every = list.childCount > 0;
  list.forEach((child) => {
    if (!isTaskItem(child)) every = false;
  });
  return every;
}

function rebulletOrderedTasks(state: EditorState): Transaction | null {
  const bulletListType = state.schema.nodes.bullet_list;
  if (!bulletListType) return null;
  // One at a time, re-read from the transaction's own doc each turn:
  // converting an item splits the list it stood in, which moves every
  // position after it. Bounded by the count the document arrived with, so a
  // conversion that cannot happen costs a turn rather than spinning.
  const budget = orderedTaskItems(state.doc).length;
  if (budget === 0) return null;
  const tr = state.tr;
  for (let turn = 0; turn < budget; turn += 1) {
    const [pos] = orderedTaskItems(tr.doc);
    if (pos === undefined) break;
    const steps = tr.steps.length;
    const $item = tr.doc.resolve(pos);
    const list = $item.parent;
    if (everyChildIsTask(list)) {
      // A list that is nothing but tasks becomes one bullet list. Splitting
      // it item by item would leave a list per line, which the reader wrote
      // as one and the editor would then draw apart.
      const start = $item.start($item.depth);
      tr.setNodeMarkup($item.before($item.depth), bulletListType, {
        spread: list.attrs.spread,
      });
      let offset = 0;
      list.forEach((child) => {
        rebulletItem(tr, start + offset);
        offset += child.nodeSize;
      });
    } else {
      const moved = convertOrderedItem(tr, pos, bulletListType);
      if (moved !== null) rebulletItem(tr, moved);
    }
    if (tr.steps.length === steps) break;
  }
  return tr.steps.length === 0 ? null : tr;
}

const orderedTaskRebullet = $prose(
  () =>
    new Plugin({
      view: (editorView) => {
        const tr = rebulletOrderedTasks(editorView.state);
        // Not an edit the reader made, so undo does not put the shape the
        // store cannot read back.
        if (tr) editorView.dispatch(tr.setMeta("addToHistory", false));
        return {};
      },
      appendTransaction: (transactions, _old, state) =>
        transactions.some((tr) => tr.docChanged)
          ? rebulletOrderedTasks(state)
          : null,
    }),
);

/** A transaction landed in the editor.
 *
 *  A press changes the document without moving the browser's own selection,
 *  and `selectionchange` was all the floating toolbar listened to. So the
 *  Task button stayed unpressed on the very line it had turned into a task.
 *  This says the document moved; the toolbar re-reads the line from it. */
const taskDocNotifier = $prose(
  () =>
    new Plugin({
      view: () => ({
        update: (view, previous) => {
          if (previous.doc.eq(view.state.doc)) return;
          notifyEditorDocChanged();
        },
      }),
    }),
);

/** The slash menu's Task item: make the lines the selection touches tasks,
 *  and leave a line that is one exactly as it is. Takes the trigger's own
 *  range so the `/task` and the line it becomes are one transaction. */
export const ensureTaskCommand = $command(
  "EnsureTask",
  () => (trigger?: TaskTrigger | null) => taskCommand("ensure", trigger ?? null),
);
/** The floating toolbar's Task button: task on the first press, paragraph on
 *  the second, whatever list the line was standing in. */
export const toggleTaskCommand = $command("ToggleTask", () => () => taskCommand("toggle", null));

export const taskCheckbox = [
  taskCheckboxView,
  taskSplitKeymap,
  taskPromote,
  orderedTaskRebullet,
  taskDocNotifier,
  ensureTaskCommand,
  toggleTaskCommand,
];
