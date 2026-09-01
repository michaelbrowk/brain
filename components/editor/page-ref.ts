import type { DOMOutputSpec, Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { MarkdownNode, ParserState, Root, SerializerState } from "@milkdown/kit/transformer";
import { $nodeSchema, $remark, $prose, $view } from "@milkdown/kit/utils";
import { classifyInternalPageLink } from "@/lib/internal-page-link";

export interface PageInfo {
  title: string;
  icon?: string;
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

/** Replace the shared directory and refresh mounted page-ref DOM directly.
 * This deliberately does not dispatch a ProseMirror transaction: a rename,
 * icon update, or newly resolved page is live display state, not a note edit. */
export function syncLivePageInfo(
  pages?: { id: string; title: string; icon?: string }[],
) {
  livePageInfo.clear();
  for (const page of pages ?? []) {
    livePageInfo.set(page.id, { title: page.title, icon: page.icon });
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
        label: dom.textContent || "",
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

    // full title on hover — the column layout truncates long refs
    attrs.title = pageRefVisibleText(node);

    const parts = pageRefVisibleParts(node);
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
 * when the page is unknown. Unknown references have no href, so they cannot
 * navigate; resolving the id later refreshes this DOM without a transaction. */
export const pageRefView = $view(pageRefSchema.node, () => ((initial: ProseNode): NodeView => {
  const dom = document.createElement("a");
  dom.setAttribute("contenteditable", "false");
  let current = initial;
  const render = (node: ProseNode) => {
    const { id, label } = pageRefAttrs(node);
    const info = livePageInfo.get(id);
    const text = pageRefVisibleText(node);
    dom.className = info
      ? "brain-page-ref"
      : "brain-page-ref brain-page-ref-missing";
    if (info) {
      dom.setAttribute("href", `/p/${id}`);
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

/** Mark only paragraphs whose entire document content is one page-ref atom.
 * CSS cannot distinguish adjacent text nodes with :has(), while this semantic
 * class keeps compact child-page lists from tightening ordinary prose that
 * happens to contain an inline page mention. */
export const pageRefParagraphs = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainPageRefParagraphs"),
      props: {
        decorations(state) {
          const found: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === "paragraph" &&
              node.childCount === 1 &&
              node.firstChild?.type.name === "page_ref"
            ) {
              found.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "brain-page-ref-only",
                }),
              );
            }
          });
          return DecorationSet.create(state.doc, found);
        },
      },
    }),
);

export const pageRef = [
  remarkPageRef,
  pageRefSchema,
  pageRefView,
  pageRefParagraphs,
].flat();
