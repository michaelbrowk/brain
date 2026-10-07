import type {
  DOMOutputSpec,
  Node as ProseNode,
  NodeType,
} from "@milkdown/kit/prose/model";
import { keymap } from "@milkdown/kit/prose/keymap";
import { Plugin, PluginKey, TextSelection, type Command } from "@milkdown/kit/prose/state";
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@milkdown/kit/prose/view";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $command, $ctx, $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";
import remarkDirectivePlugin from "remark-directive";
import { insertContainerBlock } from "./insert-block";

/** The title a toggle written without a `summary` attribute has always been
 *  shown with. Kept as its text, so such a note opens and saves as before. */
const LEGACY_SUMMARY = "Toggle";

/** A toggle's title is its first child, a line of plain text. The file keeps
 *  it where it always was, in the `summary` attribute, so every note written
 *  before the title became editable opens unchanged. An empty string is an
 *  untitled toggle, which only an absent attribute is not. */
function readSummary(attributes: { summary?: unknown } | undefined) {
  const summary = attributes?.summary;
  return typeof summary === "string" ? summary : LEGACY_SUMMARY;
}

/** Which page's toggles this editor remembers, or "" for none. Whether a
 *  toggle is open is how this reader is reading the page, not what the page
 *  says, so it is kept on this device and never in the file: folding a
 *  section is not an edit, saves nothing, and cannot conflict with another
 *  tab or an agent writing the same page. */
export const toggleMemoryCtx = $ctx("", "brainToggleMemory");

const MEMORY_PREFIX = "brain:toggles-closed:";

function readClosed(memoryKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(MEMORY_PREFIX + memoryKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeClosed(memoryKey: string, closed: Set<string>) {
  try {
    if (closed.size === 0) localStorage.removeItem(MEMORY_PREFIX + memoryKey);
    else localStorage.setItem(MEMORY_PREFIX + memoryKey, JSON.stringify([...closed]));
  } catch {
    // Storage can be full or refused. The toggle still folds; it only
    // forgets on the next mount.
  }
}

/** A toggle is remembered by its title and by how many toggles with the same
 *  title come before it, so a toggle added above another keeps the other's
 *  state unless the two share a title. */
function toggleIdentity(doc: ProseNode, pos: number, node: ProseNode): string {
  const title = node.firstChild?.textContent ?? "";
  let occurrence = 0;
  doc.nodesBetween(0, pos, (child, childPos) => {
    if (childPos >= pos) return false;
    if (child.type === node.type && (child.firstChild?.textContent ?? "") === title) {
      occurrence += 1;
    }
    return true;
  });
  return `${title}#${occurrence}`;
}

function createToggleArrow() {
  const arrow = document.createElement("button");
  arrow.type = "button";
  arrow.className = "brain-toggle-arrow";
  arrow.setAttribute("contenteditable", "false");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 5l6 7l-6 7");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "1.5");

  svg.append(path);
  arrow.append(svg);
  return arrow;
}

function labelArrow(arrow: Element | null, open: boolean) {
  if (!arrow) return;
  arrow.setAttribute("aria-expanded", String(open));
  arrow.setAttribute("aria-label", open ? "Collapse toggle" : "Expand toggle");
}

export const remarkToggleDirective = $remark(
  "remarkToggleDirective",
  () => remarkDirectivePlugin,
);

export const toggleSummarySchema = $nodeSchema("toggle_summary", () => ({
  content: "text*",
  marks: "",
  defining: true,
  selectable: false,
  parseDOM: [
    {
      tag: "summary",
      contentElement: (dom: Node) =>
        (dom instanceof HTMLElement && dom.querySelector<HTMLElement>(".brain-toggle-summary")) ||
        (dom as HTMLElement),
    },
  ],
  toDOM: (): DOMOutputSpec => [
    "summary",
    { class: "brain-toggle-head" },
    ["span", { class: "brain-toggle-summary" }, 0],
  ],
  // The title is read and written by the toggle itself, as its attribute.
  parseMarkdown: {
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "toggle_summary",
    runner: () => {},
  },
}));

export const toggleSchema = $nodeSchema("toggle", (ctx) => ({
  content: "toggle_summary block+",
  group: "block",
  defining: true,
  isolating: true,
  parseDOM: [{ tag: 'details[data-toggle="true"]' }],
  toDOM: (): DOMOutputSpec => [
    "details",
    { "data-toggle": "true", class: "brain-toggle", open: "" },
    0,
  ],
  parseMarkdown: {
    match: ({ type, name }: { type: string; name?: string }) =>
      type === "containerDirective" && name === "toggle",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const summary = readSummary(node.attributes as { summary?: unknown } | undefined);
      state.openNode(type).openNode(toggleSummarySchema.type(ctx));
      if (summary) state.addText(summary);
      state.closeNode().next(node.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "toggle",
    runner: (state: SerializerState, node: ProseNode) => {
      const title = node.firstChild;
      const titled = title?.type.name === "toggle_summary";
      state
        .openNode("containerDirective", undefined, {
          name: "toggle",
          attributes: { summary: titled ? title.textContent : "" },
        })
        .next(titled ? node.content.cut(title.nodeSize) : node.content)
        .closeNode();
    },
  },
}));

/** The title line: the arrow that folds the toggle, then the editable text.
 *  It is a `<summary>`, so the browser's own disclosure does the folding,
 *  its animation included, but a press on the text is a press in a line of
 *  text and only the arrow folds. */
export const toggleSummaryView = $view(toggleSummarySchema.node, () => ((
  initialNode: ProseNode,
): NodeView => {
  const dom = document.createElement("summary");
  dom.className = "brain-toggle-head";

  const arrow = createToggleArrow();
  const contentDOM = document.createElement("span");
  contentDOM.className = "brain-toggle-summary";
  dom.append(arrow, contentDOM);

  const render = (node: ProseNode) => {
    // The placeholder is drawn from this class; the title stays empty.
    dom.classList.toggle("is-empty", node.content.size === 0);
  };

  const onTextClick = (event: MouseEvent) => {
    if (event.target instanceof Node && arrow.contains(event.target)) return;
    event.preventDefault();
  };
  const onArrowDown = (event: Event) => {
    // keep the caret where it is: the arrow folds, it does not take focus
    event.preventDefault();
  };
  const onArrowClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const details = dom.parentElement;
    if (details instanceof HTMLDetailsElement) details.open = !details.open;
  };

  dom.addEventListener("click", onTextClick);
  arrow.addEventListener("pointerdown", onArrowDown);
  arrow.addEventListener("mousedown", onArrowDown);
  arrow.addEventListener("click", onArrowClick);
  render(initialNode);

  return {
    dom,
    contentDOM,
    update: (node: ProseNode) => {
      if (node.type.name !== "toggle_summary") return false;
      render(node);
      return true;
    },
    ignoreMutation: (mutation: ViewMutationRecord) =>
      !(mutation.target === contentDOM || contentDOM.contains(mutation.target)),
    stopEvent: (event: Event) =>
      event.target instanceof Node && arrow.contains(event.target),
    destroy: () => {
      dom.removeEventListener("click", onTextClick);
      arrow.removeEventListener("pointerdown", onArrowDown);
      arrow.removeEventListener("mousedown", onArrowDown);
      arrow.removeEventListener("click", onArrowClick);
    },
  };
}) satisfies NodeViewConstructor);

export const toggleView = $view(toggleSchema.node, (ctx) => ((
  initialNode: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView => {
  const memoryKey = ctx.get(toggleMemoryCtx.key);
  let node = initialNode;

  // The title and the body are the toggle's children, the title first, so
  // the `<details>` is its own content element and the title's `<summary>`
  // is its first child, as the element requires.
  const details = document.createElement("details");
  details.className = "brain-toggle";
  details.setAttribute("data-toggle", "true");

  const identityAt = (current: ProseNode) => {
    const pos = getPos();
    if (typeof pos !== "number" || view.state.doc.nodeAt(pos) !== current) return null;
    return toggleIdentity(view.state.doc, pos, current);
  };

  let identity = memoryKey ? identityAt(node) : null;
  details.open = !(memoryKey && identity && readClosed(memoryKey).has(identity));

  const arrow = () => details.querySelector(":scope > summary > .brain-toggle-arrow");

  /** A caret left in a body that has just folded away would type into text
   *  nobody can see, so it moves to the end of the title. */
  const keepCaretVisible = () => {
    const pos = getPos();
    const title = node.firstChild;
    if (typeof pos !== "number" || !title) return;
    const titleEnd = pos + title.nodeSize;
    const bodyEnd = pos + node.nodeSize - 1;
    const { from, to } = view.state.selection;
    if (to <= titleEnd || from > bodyEnd) return;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, titleEnd)),
    );
  };

  const onToggle = () => {
    labelArrow(arrow(), details.open);
    if (!details.open) keepCaretVisible();
    if (!memoryKey) return;
    identity = identityAt(node);
    if (!identity) return;
    const closed = readClosed(memoryKey);
    if (details.open) closed.delete(identity);
    else closed.add(identity);
    writeClosed(memoryKey, closed);
  };

  details.addEventListener("toggle", onToggle);
  // The title's view is built after this one, so its arrow is labelled once
  // both are in place.
  queueMicrotask(() => labelArrow(arrow(), details.open));

  return {
    dom: details,
    contentDOM: details,
    update: (updated: ProseNode) => {
      if (updated.type.name !== "toggle") return false;
      node = updated;
      labelArrow(arrow(), details.open);
      if (!memoryKey || details.open) return true;
      // A folded toggle whose title changed is remembered under its new name.
      const next = identityAt(updated);
      if (next && identity && next !== identity) {
        const closed = readClosed(memoryKey);
        closed.delete(identity);
        closed.add(next);
        writeClosed(memoryKey, closed);
      }
      if (next) identity = next;
      return true;
    },
    ignoreMutation: (mutation: ViewMutationRecord) =>
      mutation.type === "attributes" && mutation.target === details,
    destroy: () => {
      details.removeEventListener("toggle", onToggle);
    },
  };
}) satisfies NodeViewConstructor);

function caretInTitle(state: Parameters<Command>[0]) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "toggle_summary") return null;
  return $from;
}

/** Enter in the title goes to the first line of the body, opening a new one
 *  at the top unless that line is already empty. The title never splits. */
const enterFromTitle: Command = (state, dispatch, view) => {
  const $from = caretInTitle(state);
  if (!$from) return false;
  if (!dispatch) return true;
  const first = $from.node(-1).child(1);
  const bodyStart = $from.after();
  const details = view?.nodeDOM($from.before(-1));
  if (details instanceof HTMLDetailsElement) details.open = true;
  if (first.type.name === "paragraph" && first.content.size === 0) {
    dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, bodyStart + 1)).scrollIntoView(),
    );
    return true;
  }
  const tr = state.tr.insert(bodyStart, state.schema.nodes.paragraph.create());
  dispatch(tr.setSelection(TextSelection.create(tr.doc, bodyStart + 1)).scrollIntoView());
  return true;
};

/** Backspace at the start of the title unwraps the toggle: the title becomes
 *  a line of its own and the body follows it, the way a heading turns back
 *  into text. A body that is one empty line is not kept. */
const unwrapFromTitle: Command = (state, dispatch) => {
  const $from = caretInTitle(state);
  if (!$from || $from.parentOffset !== 0) return false;
  if (!dispatch) return true;
  const toggleNode = $from.node(-1);
  const start = $from.before(-1);
  const { paragraph } = state.schema.nodes;
  const blocks = [paragraph.create(null, toggleNode.child(0).content)];
  toggleNode.forEach((child, _offset, index) => {
    if (index === 0) return;
    const lone = toggleNode.childCount === 2;
    if (lone && child.type === paragraph && child.content.size === 0) return;
    blocks.push(child);
  });
  const tr = state.tr.replaceWith(start, start + toggleNode.nodeSize, blocks);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
  return true;
};

/** Offered the key before the preset's own Enter and Backspace; see
 *  `taskSplitKeymap` for the ordering. */
export const toggleKeymap = $prose(() =>
  keymap({ Enter: enterFromTitle, Backspace: unwrapFromTitle }),
);

const IOS_ENTER_FALLBACK_MS = 300;

/** Enter on iOS never reaches the keymap first. ProseMirror lets the browser
 *  split the line and reads the split back, and WebKit split the title into
 *  a second `<summary>` that the body's words were then typed into. The
 *  split is refused at `beforeinput` and the title's own Enter runs instead.
 *  ProseMirror still replays the Enter it held back about 200ms later (its
 *  fallback for a keyboard that changed nothing), so that one replay is
 *  swallowed: the caret is in the body by then, and it would open a line. */
export const toggleTitleInput = $prose(() => {
  const handledAt = new WeakMap<EditorView, number>();
  return new Plugin({
    key: new PluginKey("brainToggleTitleInput"),
    props: {
      handleDOMEvents: {
        beforeinput: (view, event) => {
          const { inputType } = event as InputEvent;
          if (inputType !== "insertParagraph" && inputType !== "insertLineBreak") return false;
          if (!caretInTitle(view.state)) return false;
          event.preventDefault();
          enterFromTitle(view.state, view.dispatch, view);
          handledAt.set(view, Date.now());
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter") return false;
        const at = handledAt.get(view);
        if (at === undefined) return false;
        handledAt.delete(view);
        return Date.now() - at < IOS_ENTER_FALLBACK_MS;
      },
    },
  });
});

/** A new toggle has an empty title with the caret in it and one empty body
 *  line. It used to be titled "Toggle" and hold the words "Hidden content"
 *  with the caret after them, so the title typed next landed in the body as
 *  "Hidden contentSummary". The title's placeholder is drawn, never written. */
export const insertToggleCommand = $command<unknown, "InsertToggle">(
  "InsertToggle",
  (ctx) => (payload) => (state, dispatch) => {
    const summary = typeof payload === "string" ? payload : "";
    const title = toggleSummarySchema
      .type(ctx)
      .create(null, summary ? state.schema.text(summary) : undefined);
    const node = toggleSchema
      .type(ctx)
      .create(null, [title, state.schema.nodes.paragraph.create()]);

    if (!dispatch) return true;
    // the title is the toggle's first line, so the caret lands in it
    dispatch(insertContainerBlock(state.tr, node).scrollIntoView());
    return true;
  },
);

export const toggle = [
  toggleMemoryCtx,
  remarkToggleDirective,
  toggleSummarySchema,
  toggleSchema,
  toggleSummaryView,
  toggleView,
  toggleTitleInput,
  toggleKeymap,
  insertToggleCommand,
].flat();
