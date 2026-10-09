import type {
  DOMOutputSpec,
  Node as ProseNode,
  NodeType,
  Schema,
} from "@milkdown/kit/prose/model";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type { MarkdownNode, ParserState, Root, SerializerState } from "@milkdown/kit/transformer";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { paragraphSchema } from "@milkdown/kit/preset/commonmark";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { classifyInternalPageLink } from "@/lib/internal-page-link";

export interface PageInfo {
  title: string;
  icon?: string;
  /** An app page. The chip is chrome the NodeView draws; it never enters
   *  `pageRefVisibleText`, which is what the serializer writes and what
   *  search indexes. */
  kind?: "app";
}

/** The label text one page-ref anchor carries, with the AI chip left out.
 *  `parseDOM` bakes this into the node's `label`, which is the string a ref
 *  falls back to once the page it names is gone, so a chip that slipped into
 *  it would become part of a title on the next paste. */
export function pageRefLabelFromDom(dom: HTMLElement): string {
  let text = "";
  for (const child of Array.from(dom.childNodes)) {
    if (child.nodeType === 1 && (child as Element).classList.contains("ai-chip")) {
      continue;
    }
    text += child.textContent ?? "";
  }
  return text;
}

/** Single live page directory shared by the serializer and mounted NodeViews.
 * The editor keeps this in sync with the tree, so display and Markdown always
 * use the same current title/icon without dispatching an edit transaction. */
export const livePageInfo = new Map<string, PageInfo>();
let pageRefOrigin = "";
const mountedPageRefViews = new Set<() => void>();

export function setPageRefOrigin(origin: string) {
  pageRefOrigin = origin;
}

/** The origin a page URL is judged against, for the plugins that read a
 *  pasted address (`web-link.ts`): the editor sets it from the window. */
export function currentPageRefOrigin(): string {
  return pageRefOrigin;
}

/** Where a ref points at display time. Unset, the owner's rule: a page the
 *  live directory knows links at `/p/<id>`, one it does not is unavailable.
 *  A link visitor's island sets one instead: the share URL for a page inside
 *  the shared subtree, null for every other, which renders as unavailable the
 *  way the read-only page flattens it. Display only, like `attachmentSrc`:
 *  `toMarkdown` still writes `/p/<id>`, and `toDOM`, which feeds the
 *  clipboard, stays on the owner's address, so the stored document never
 *  learns the share URL. Module-scoped for the same reason as that resolver:
 *  a NodeView is plain DOM with no React context, and Brain never mounts two
 *  editors at once. */
type PageRefHrefResolver = (id: string) => string | null;
let pageRefHrefResolver: PageRefHrefResolver | null = null;

export function setPageRefHrefResolver(resolver: PageRefHrefResolver | null) {
  pageRefHrefResolver = resolver;
  mountedPageRefViews.forEach((refresh) => refresh());
}

export function pageRefHref(id: string): string | null {
  if (pageRefHrefResolver) return pageRefHrefResolver(id);
  return livePageInfo.has(id) ? `/p/${id}` : null;
}

/** Whether a host has taken over where a page id may point. A surface that
 *  has says so for every link into the owner's page namespace, not only for
 *  the refs the editor placed, so the click handler asks this before it lets
 *  an ordinary link mark address `/p/`. */
export function hasPageRefHrefResolver(): boolean {
  return pageRefHrefResolver !== null;
}

/** Replace the shared directory and refresh mounted page-ref DOM directly.
 * This deliberately does not dispatch a ProseMirror transaction: a rename,
 * icon update, or newly resolved page is live display state, not a note edit. */
export function syncLivePageInfo(
  pages?: readonly { id: string; title: string; icon?: string; kind?: "app" }[],
) {
  livePageInfo.clear();
  for (const page of pages ?? []) {
    livePageInfo.set(page.id, { title: page.title, icon: page.icon, kind: page.kind });
  }
  mountedPageRefViews.forEach((refresh) => refresh());
}

/** A reference to another Brain page rendered as an atomic "page block"
 *  (Notion-style child-page mention). The label/title isn't free text you can
 *  edit — it shows the linked page, and renaming happens on the page itself.
 *
 *  On disk it stays an ordinary markdown link `[label](/p/<id>)`, so nothing
 *  about the storage format changes; only the editor treats internal page
 *  links as atoms instead of editable link text. */

type PageRefMarkdownNode = MarkdownNode & {
  type: "pageRef";
  id: string;
  label: string;
};

function isPageRefMarkdownNode(node: MarkdownNode): node is PageRefMarkdownNode {
  return node.type === "pageRef" && typeof node.id === "string" && typeof node.label === "string";
}

function pageRefAttrs(node: ProseNode) {
  const id = node.attrs.id;
  const label = node.attrs.label;

  return {
    id: typeof id === "string" ? id : "",
    label: typeof label === "string" ? label : "",
  };
}

function livePageRefLabel(info: PageInfo) {
  return `${info.icon || "📄"} ${info.title}`;
}

/** A ref to `page`, with the label the serializer would write for it. The
 *  title is an attribute here, never Markdown: a `]` or a `*` in it is the
 *  serializer's to escape. */
export function createPageRef(
  schema: Schema,
  page: { id: string; title: string; icon?: string },
): ProseNode {
  return schema.nodes.page_ref.create({ id: page.id, label: livePageRefLabel(page) });
}

/** Text rendered by the atomic page-ref NodeView. Search indexing uses this
 * same helper so its visible-text projection cannot drift from the editor. */
export function pageRefVisibleText(node: ProseNode) {
  const { id, label } = pageRefAttrs(node);
  const info = livePageInfo.get(id);
  return info ? livePageRefLabel(info) : label || id;
}

/** A baked label written by the serializer starts with the page emoji. Match
 * one emoji grapheme (with optional variation selector, skin tone, keycap, or
 * ZWJ sequence) followed by the single separating space. */
const LEADING_ICON =
  /^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*) (?=\S)/u;

/** The visible text split into the page icon and the ` title` remainder, so the
 * icon can sit in its own element with a small gap. Concatenated, the parts are
 * byte-identical to `pageRefVisibleText` — parseDOM and search read textContent. */
export function pageRefVisibleParts(
  node: ProseNode,
): { icon: string; rest: string } | { icon: null; rest: string } {
  const { id, label } = pageRefAttrs(node);
  const info = livePageInfo.get(id);
  if (info) return { icon: info.icon || "📄", rest: ` ${info.title}` };
  const text = label || id;
  const match = LEADING_ICON.exec(text);
  return match
    ? { icon: match[1], rest: text.slice(match[1].length) }
    : { icon: null, rest: text };
}

function walk(node: MarkdownNode, fn: (node: MarkdownNode) => MarkdownNode | null | undefined | void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.children)) {
    node.children = node.children.map((child) => {
      const replaced = fn(child);
      const next = replaced ?? child;
      walk(next, fn);
      return next;
    });
  }
}

/** Rewrite only exact relative or same-origin Brain page destinations into
 * pageRef nodes. Non-exact and external links stay ordinary links. */
export const remarkPageRef = $remark("remarkPageRef", () => () => {
  return (tree: Root) => {
    walk(tree as unknown as MarkdownNode, (n) => {
      if (n?.type !== "link" || typeof n.url !== "string") return null;
      const internal = classifyInternalPageLink(n.url, pageRefOrigin);
      if (!internal) return null;
      const label = (n.children ?? [])
        .map((child) => (typeof child.value === "string" ? child.value : ""))
        .join("");
      return { type: "pageRef", id: internal.id, label };
    });
  };
});

/** Whether `node` is the space after a ref alone on its line: the last child
 *  of a paragraph or a cell, only whitespace, right after a link to a page. */
function isPageRefSpacer(node: MarkdownNode, parent: MarkdownNode | undefined) {
  const children = parent?.children ?? [];
  const [ref, spacer] = children;
  return (
    (parent?.type === "paragraph" || parent?.type === "tableCell") &&
    children.length === 2 &&
    spacer === node &&
    typeof node.value === "string" &&
    /^[ \t]+$/.test(node.value) &&
    ref?.type === "link" &&
    typeof ref.url === "string" &&
    classifyInternalPageLink(ref.url, pageRefOrigin) !== null
  );
}

type TextHandler = (
  node: MarkdownNode,
  parent: MarkdownNode | undefined,
  state: { safe: (value: string, info: unknown) => string },
  info: unknown,
) => string;

/** The space after a ref alone in a list item or a cell is the caret's, not
 *  the writer's (`insertInline`): without it the browser takes the next key
 *  to the line below. Markdown drops a trailing space on reading, so it is
 *  not written either, first save included. Every other text goes to
 *  Milkdown's own handler, which this wraps: a stringify option, because
 *  options outrank every `toMarkdownExtensions` entry. */
export const pageRefSpacer: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const handlers = (options.handlers ?? {}) as Record<string, TextHandler>;
    const text = handlers.text;
    const wrapped: TextHandler = (node, parent, state, info) => {
      if (isPageRefSpacer(node, parent)) return "";
      return text ? text(node, parent, state, info) : state.safe(String(node.value ?? ""), info);
    };
    return { ...options, handlers: { ...handlers, text: wrapped } } as typeof options;
  });
  return () => {};
};

export const pageRefSchema = $nodeSchema("page_ref", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: "" }, label: { default: "" } },
  parseDOM: [
    {
      tag: 'a[data-page-ref]',
      getAttrs: (dom: HTMLElement) => ({
        id: dom.getAttribute("data-page-ref") || "",
        label: pageRefLabelFromDom(dom),
      }),
    },
  ],
  toDOM: (node: ProseNode): DOMOutputSpec => {
    const { id, label } = pageRefAttrs(node);
    const info = livePageInfo.get(id);
    const attrs: Record<string, string> = {
      "data-page-ref": id,
      class: "brain-page-ref",
    };
    if (info) {
      attrs.href = `/p/${id}`;
    } else {
      attrs.class += " brain-page-ref-missing";
      attrs["aria-disabled"] = "true";
      attrs["aria-label"] = `Page unavailable: ${label || id}`;
    }

    // No `title` here, though the view draws one for the hover: this is the
    // clipboard's markup, and the link-mark rule that reads a copied chip
    // back keeps a title, so every copy and paste of a chip wrote
    // `[label](/p/<id> "label")` into the note.

    const parts = pageRefVisibleParts(node);
    // NO CHIP HERE. `toDOM` is the clipboard's markup and the schema's own
    // serialization, not what a reader looks at: the NodeView below draws the
    // live ref and is the one that wears the chip.
    //
    // A chip in here rides the clipboard, and commonmark's link-mark rule
    // outranks this node's own `parseDOM`, so a copied ref comes back as an
    // ordinary link whose TEXT is "🃏 TrainerAI". The serializer writes that
    // to disk as the label, and the two letters are part of somebody's title
    // for good. Guarding `getAttrs` does not help, because `getAttrs` is not
    // the rule that matched.
    return parts.icon === null
      ? ["a", attrs, parts.rest]
      : ["a", attrs, ["span", { class: "brain-page-ref-icon" }, parts.icon], parts.rest];
  },
  parseMarkdown: {
    match: (node: MarkdownNode) => isPageRefMarkdownNode(node),
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      if (!isPageRefMarkdownNode(node)) return;
      state.addNode(type, { id: node.id, label: node.label });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "page_ref",
    runner: (state: SerializerState, node: ProseNode) => {
      const { id, label: fallbackLabel } = pageRefAttrs(node);
      const info = livePageInfo.get(id);
      const label = info ? livePageRefLabel(info) : fallbackLabel;
      state.addNode("link", undefined, undefined, {
        url: `/p/${id}`,
        children: [{ type: "text", value: label }],
      });
    },
  },
}));

/** NodeView renders the LIVE title + icon, falling back to the baked label
 * when the page is unknown. A reference `pageRefHref` cannot place has no
 * href, so it cannot navigate; resolving the id later, or a host installing
 * a resolver, refreshes this DOM without a transaction. */
export const pageRefView = $view(pageRefSchema.node, () => ((initial: ProseNode): NodeView => {
  const dom = document.createElement("a");
  dom.setAttribute("contenteditable", "false");
  let current = initial;
  const render = (node: ProseNode) => {
    const { id, label } = pageRefAttrs(node);
    const href = pageRefHref(id);
    const text = pageRefVisibleText(node);
    dom.className = href
      ? "brain-page-ref"
      : "brain-page-ref brain-page-ref-missing";
    if (href) {
      dom.setAttribute("href", href);
      dom.removeAttribute("aria-disabled");
      dom.removeAttribute("aria-label");
    } else {
      dom.removeAttribute("href");
      dom.setAttribute("aria-disabled", "true");
      dom.setAttribute("aria-label", `Page unavailable: ${label || id}`);
    }
    dom.setAttribute("data-page-ref", id);
    dom.title = text;
    const parts = pageRefVisibleParts(node);
    if (parts.icon === null) {
      dom.textContent = parts.rest;
    } else {
      const icon = document.createElement("span");
      icon.className = "brain-page-ref-icon";
      icon.textContent = parts.icon;
      dom.replaceChildren(icon, document.createTextNode(parts.rest));
    }
    if (livePageInfo.get(id)?.kind === "app") {
      const chip = document.createElement("span");
      chip.className = "ai-chip";
      chip.title = "Built by an agent";
      chip.textContent = "AI";
      dom.append(chip);
    }
  };
  const refresh = () => render(current);
  mountedPageRefViews.add(refresh);
  render(initial);
  return {
    dom,
    update: (node: ProseNode) => {
      if (node.type.name !== "page_ref") return false;
      current = node;
      render(node);
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: () => false,
    destroy: () => mountedPageRefViews.delete(refresh),
  };
}) satisfies NodeViewConstructor);

/** Whether a paragraph is one page row: its whole content is one page-ref
 *  atom. `page-filing.ts` files that shape, and the tail's menu names it. */
function isPageRefOnly(node: ProseNode): boolean {
  return node.childCount === 1 && node.firstChild?.type.name === "page_ref";
}

/** Mark only paragraphs whose entire document content is one page-ref atom.
 * CSS cannot distinguish adjacent text nodes with :has(), while this semantic
 * class keeps compact child-page lists from tightening ordinary prose that
 * happens to contain an inline page mention.
 *
 * A NodeView for every paragraph, which toggles the class when its own node
 * changes, and nothing else: the element and its attributes are what the
 * preset's own `toDOM` renders. This used to be a node decoration on every
 * row, and ProseMirror prices a decoration at the top level against every
 * top-level block, on every transaction, twice (once to map the set, once to
 * update the view): a page of 600 rows paid eight milliseconds per keystroke
 * for a class name. A view costs a keystroke nothing. */
export const pageRefParagraphs = $view(paragraphSchema.node, () => ((initial: ProseNode): NodeView => {
  const spec = initial.type.spec.toDOM?.(initial) ?? ["p", 0];
  const { dom, contentDOM } = DOMSerializer.renderSpec(document, spec);
  const element = dom as HTMLElement;
  let current = initial;
  const sync = (node: ProseNode) => {
    element.classList.toggle("brain-page-ref-only", isPageRefOnly(node));
  };
  sync(initial);
  return {
    dom: element,
    contentDOM,
    update: (node: ProseNode) => {
      // Another type, or other attributes, is the preset's markup to redraw.
      if (!node.sameMarkup(current)) return false;
      current = node;
      sync(node);
      return true;
    },
  };
}) satisfies NodeViewConstructor);

export const pageRef = [
  remarkPageRef,
  pageRefSpacer,
  pageRefSchema,
  pageRefView,
  pageRefParagraphs,
].flat();
