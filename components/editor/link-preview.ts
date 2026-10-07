import type { MarkType, Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type { MarkdownNode, ParserState, Root, SerializerState } from "@milkdown/kit/transformer";
import { $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";

/** Link cards: a paragraph that holds nothing but an external link whose text
 *  is its own URL reads as a preview card.
 *
 *  The card is a block node of its own (`link_card`), an atom with its own
 *  view, and not a decoration over the paragraph. The paragraph used to stay
 *  in the document, collapsed to nothing, while a widget drew the card beside
 *  it, so the caret could sit in text nobody could see: Enter on a phone
 *  opened the next line above the card and linked it, desktop Safari typed
 *  into the hidden link, Chromium dropped the keys, and the decorations were
 *  rebuilt for the whole page on every keystroke. As a node the card is
 *  something the caret goes around, the way it goes around an image, and it
 *  is drawn once.
 *
 *  On disk nothing changes. The card is read from the same Markdown and
 *  written back as the same paragraph holding the same link, so a page made
 *  before the node existed opens and saves unchanged. */

type UnfurlMeta = {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  url?: string;
};

export const LINK_CARD_NODE = "link_card";
const LINK_CARD_MDAST = "brainLinkCard";

const linkCardEditingKey = new PluginKey<number | null>("brainLinkCardEditing");
const previewCache = new Map<string, UnfurlMeta | null>();
const previewInflight = new Map<string, Promise<UnfurlMeta | null>>();

function hostnameLabel(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

function isInternalPageUrl(url: URL) {
  if (!/^\/p\/[\w-]+/.test(url.pathname)) return false;
  if (typeof window === "undefined" || !window.location.host) return false;
  return url.host === window.location.host;
}

function externalHttpUrl(href: unknown) {
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isInternalPageUrl(url)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sameUrlText(text: string, href: string) {
  const visible = text.trim();
  if (!visible || visible !== text) return false;
  if (visible === href) return true;
  return visible.replace(/\/$/, "") === href.replace(/\/$/, "");
}

/** The link a paragraph would become a card for, or null. */
function bareExternalLink(node: ProseNode) {
  if (node.type.name !== "paragraph" || node.childCount !== 1) return null;

  const child = node.child(0);
  if (!child.isText || child.marks.length !== 1) return null;

  const link = child.marks[0];
  if (link.type.name !== "link") return null;
  const href = typeof link.attrs.href === "string" ? link.attrs.href : "";
  if (!externalHttpUrl(href) || !sameUrlText(child.text ?? "", href)) return null;

  return { href, text: child.text ?? href, title: link.attrs.title ?? null };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function image(url: string, className: string) {
  const img = document.createElement("img");
  img.className = className;
  img.src = url;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    img.hidden = true;
  });
  return img;
}

function renderSkeleton(card: HTMLAnchorElement) {
  card.className = "brain-embed brain-embed-loading";

  const body = el("span", "brain-embed-body");
  const site = el("span", "brain-embed-site");
  site.append(el("span", "brain-embed-skeleton brain-embed-skeleton-icon"));
  site.append(el("span", "brain-embed-skeleton brain-embed-skeleton-site"));
  body.append(site);
  body.append(el("span", "brain-embed-skeleton brain-embed-skeleton-title"));
  body.append(el("span", "brain-embed-skeleton brain-embed-skeleton-desc"));

  const thumb = el("span", "brain-embed-skeleton brain-embed-skeleton-thumb");
  card.replaceChildren(body, thumb);
}

function renderFallback(card: HTMLAnchorElement, url: string) {
  card.className = "brain-embed brain-embed-fallback";
  card.textContent = url;
}

function shouldFallback(meta: UnfurlMeta | null, url: string) {
  if (!meta) return true;
  const host = hostnameLabel(url);
  const title = (meta.title ?? "").trim();
  return !meta.description && !meta.image && !meta.siteName && !meta.favicon && (!title || title === host);
}

function renderCard(card: HTMLAnchorElement, url: string, meta: UnfurlMeta) {
  if (shouldFallback(meta, url)) {
    renderFallback(card, url);
    return;
  }

  const resolvedUrl = meta.url || url;
  const host = hostnameLabel(resolvedUrl);
  const siteText = meta.siteName || host;
  const titleText = meta.title || host;

  card.className = "brain-embed";

  const body = el("span", "brain-embed-body");
  const site = el("span", "brain-embed-site");
  if (meta.favicon) site.append(image(meta.favicon, "brain-embed-favicon"));
  const siteName = el("span", "brain-embed-site-name");
  siteName.textContent = siteText;
  site.append(siteName);

  const title = el("span", "brain-embed-title");
  title.textContent = titleText;

  body.append(site, title);

  if (meta.description) {
    const description = el("span", "brain-embed-description");
    description.textContent = meta.description;
    body.append(description);
  }

  const nodes: HTMLElement[] = [body];
  if (meta.image) {
    const thumb = el("span", "brain-embed-thumb");
    thumb.append(image(meta.image, "brain-embed-thumb-image"));
    nodes.push(thumb);
  }

  card.replaceChildren(...nodes);
}

function loadPreview(url: string) {
  if (previewCache.has(url)) return Promise.resolve(previewCache.get(url) ?? null);

  const pending = previewInflight.get(url);
  if (pending) return pending;

  const promise = fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as UnfurlMeta | null;
      if (!data || typeof data !== "object") return null;
      return data;
    })
    .catch(() => null)
    .then((data) => {
      previewInflight.delete(url);
      previewCache.set(url, data);
      return data;
    });

  previewInflight.set(url, promise);
  return promise;
}

/** Draw the card for `url` into `card`: the cached preview at once, or a
 *  skeleton until /api/unfurl answers. `current` says whether the card still
 *  shows this URL when the answer arrives; a card whose URL was edited in the
 *  meantime must not be painted with the old preview. */
function fillCard(card: HTMLAnchorElement, url: string, current: () => boolean) {
  const cached = previewCache.get(url);
  if (cached !== undefined) {
    if (cached) renderCard(card, url, cached);
    else renderFallback(card, url);
    return;
  }

  renderSkeleton(card);
  void loadPreview(url).then((meta) => {
    if (!card.isConnected || !current()) return;
    if (meta) renderCard(card, url, meta);
    else renderFallback(card, url);
  });
}

type MutableMarkdownNode = MarkdownNode & {
  children?: MutableMarkdownNode[];
  name?: unknown;
  title?: unknown;
  url?: unknown;
  value?: unknown;
};

/** Where a card may stand: a parent whose content the editor holds as
 *  `block+`. A list item's FIRST paragraph is not one (the schema wants a
 *  paragraph there), so that line stays a link. A heading, a table cell and a
 *  paragraph hold inline content and never reach this question. */
const CARD_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
const CARD_DIRECTIVES = new Set(["callout", "toggle", "col"]);

function holdsCards(node: MutableMarkdownNode) {
  if (CARD_PARENTS.has(node.type)) return true;
  return node.type === "containerDirective" && CARD_DIRECTIVES.has(String(node.name));
}

function asLinkCard(node: MutableMarkdownNode): MutableMarkdownNode | null {
  if (node.type !== "paragraph" || node.children?.length !== 1) return null;
  const link = node.children[0];
  if (link?.type !== "link" || link.children?.length !== 1) return null;
  const text = link.children[0];
  if (text?.type !== "text" || typeof text.value !== "string") return null;
  const href = typeof link.url === "string" ? link.url : "";
  if (!externalHttpUrl(href) || !sameUrlText(text.value, href)) return null;
  return {
    type: LINK_CARD_MDAST,
    url: href,
    value: text.value,
    title: typeof link.title === "string" ? link.title : null,
  };
}

function walkLinkCards(node: MutableMarkdownNode) {
  if (!Array.isArray(node.children)) return;
  const canHold = holdsCards(node);
  node.children = node.children.map((child, index) => {
    if (canHold && !(node.type === "listItem" && index === 0)) {
      const card = asLinkCard(child);
      if (card) return card;
    }
    walkLinkCards(child);
    return child;
  });
}

export const remarkLinkCard = $remark(
  "remarkBrainLinkCard",
  () => () => (tree: Root) => {
    walkLinkCards(tree as unknown as MutableMarkdownNode);
  },
);

function cardText(node: ProseNode) {
  const text = typeof node.attrs.text === "string" ? node.attrs.text : "";
  return text || String(node.attrs.href ?? "");
}

export const linkCardSchema = $nodeSchema(LINK_CARD_NODE, () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    href: { default: "" },
    // The link's visible text as stored. It may differ from `href` by a
    // trailing slash, and writing it back as read keeps the file unchanged.
    text: { default: "" },
    title: { default: null },
  },
  parseDOM: [
    {
      tag: "a[data-brain-link-card]",
      // Above the link mark's own `a[href]` rule, which would otherwise read
      // a copied card back as a linked word.
      priority: 60,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const href = dom.getAttribute("href") ?? "";
        return { href, text: dom.textContent || href, title: dom.getAttribute("title") };
      },
    },
  ],
  // What a copy puts on the clipboard, and what parseDOM reads back. The
  // drawn card lives in the view below.
  toDOM: (node) => [
    "a",
    { "data-brain-link-card": "true", href: node.attrs.href, title: node.attrs.title },
    cardText(node),
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === LINK_CARD_MDAST,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const md = node as MutableMarkdownNode;
      state.addNode(type, {
        href: typeof md.url === "string" ? md.url : "",
        text: typeof md.value === "string" ? md.value : "",
        title: typeof md.title === "string" ? md.title : null,
      });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === LINK_CARD_NODE,
    runner: (state: SerializerState, node: ProseNode) => {
      // The same tree the paragraph and its link mark write: one paragraph,
      // one link, one text. remark-stringify then spells it as it always has.
      state
        .openNode("paragraph")
        .openNode("link", undefined, { url: node.attrs.href, title: node.attrs.title })
        .addNode("text", undefined, cardText(node))
        .closeNode()
        .closeNode();
    },
  },
}));

export const linkCardView = $view(linkCardSchema.node, () => ((initial: ProseNode): NodeView => {
  const card = document.createElement("a");
  card.target = "_blank";
  card.rel = "noreferrer noopener";
  card.setAttribute("contenteditable", "false");
  card.setAttribute("data-brain-link-card", "true");

  let shown = "";
  const render = (node: ProseNode) => {
    const href = String(node.attrs.href ?? "");
    const url = externalHttpUrl(href) ?? href;
    if (url === shown) return;
    shown = url;
    card.href = url;
    card.setAttribute("aria-label", url);
    fillCard(card, url, () => shown === url);
  };
  render(initial);

  return {
    dom: card,
    update: (node) => {
      if (node.type !== initial.type) return false;
      render(node);
      return true;
    },
    // The preview arrives after mount and rewrites the card's children. That
    // is the view's own drawing, not an edit for ProseMirror to read back.
    ignoreMutation: () => true,
    // A click opens the link in a new tab, as the card always has.
    stopEvent: (event) => event.type === "click" || event.type === "mousedown",
    // An attribute, not ProseMirror's class: the preview rewrites the card's
    // class names when it arrives, which would drop a selection class.
    selectNode: () => {
      card.dataset.selected = "true";
    },
    deselectNode: () => {
      delete card.dataset.selected;
    },
  };
}) satisfies NodeViewConstructor);

function cardFromLink(type: NodeType, link: { href: string; text: string; title: unknown }) {
  return type.create({ href: link.href, text: link.text, title: link.title ?? null });
}

function lineFromCard(state: EditorState, card: ProseNode) {
  const link = state.schema.marks.link;
  const paragraph = state.schema.nodes.paragraph;
  if (!link || !paragraph) return null;
  const text = cardText(card);
  return paragraph.create(
    null,
    state.schema.text(text, [link.create({ href: card.attrs.href, title: card.attrs.title })]),
  );
}

/** Backspace at the start of the line after a card opens the card's URL as
 *  the text it is stored as, with the caret at its end: the way into a card
 *  from the keyboard, and the way to edit its address. An empty line is
 *  removed on the way, the way Backspace removes an empty line anywhere; a
 *  line with words keeps them, because joining prose onto a URL is never
 *  what a reader asks for. Leaving the line draws the card again
 *  (`settleLinkCardEditing`). */
export function openLinkCardBefore(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.parentOffset !== 0 || !$from.parent.isTextblock || $from.depth < 1) return null;
  const index = $from.index($from.depth - 1);
  if (index === 0) return null;
  const card = $from.node($from.depth - 1).child(index - 1);
  if (card.type.name !== LINK_CARD_NODE) return null;
  const line = lineFromCard(state, card);
  if (!line) return null;

  const blockStart = $from.before();
  const cardStart = blockStart - card.nodeSize;
  const tr = state.tr;
  if ($from.parent.type === line.type && $from.parent.content.size === 0) {
    tr.delete(blockStart, $from.after());
  }
  tr.replaceWith(cardStart, cardStart + card.nodeSize, line);
  tr.setSelection(TextSelection.create(tr.doc, cardStart + line.nodeSize - 1));
  return tr.setMeta(linkCardEditingKey, cardStart).scrollIntoView();
}

/** Enter on a selected card writes on a new line below it. ProseMirror's own
 *  answer puts that line above a block that opens its parent, which is where
 *  a card pasted on a page's first line always is. */
export function lineAfterSelectedCard(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== LINK_CARD_NODE) {
    return null;
  }
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;
  const tr = state.tr.insert(selection.to, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, selection.to + 1)).scrollIntoView();
}

/** A URL pasted on its own.
 *
 *  On an empty line it becomes a card, and the caret goes to a line after it:
 *  the next empty one, or a new one, never the card's own. Over a selected
 *  card it replaces that card's address. Anywhere else (a sentence, a
 *  heading, a list item's first line) it is an inline link where the caret
 *  is, as a pasted link always was; a card there would split the line in
 *  three. Null when the paste is not a lone external URL, or lands somewhere
 *  this does not decide, and the clipboard plugin takes it. */
export function pasteLinkCard(state: EditorState, pasted: string): Transaction | null {
  const text = pasted.trim();
  if (!text || /\s/.test(text) || !externalHttpUrl(text)) return null;
  const { schema, selection } = state;
  const cardType = schema.nodes[LINK_CARD_NODE];
  const link = schema.marks.link;
  const paragraph = schema.nodes.paragraph;
  if (!cardType || !link || !paragraph) return null;
  const urlLink = { href: text, text, title: null };

  if (selection instanceof NodeSelection) {
    if (selection.node.type !== cardType) return null;
    const tr = state.tr.setNodeMarkup(selection.from, undefined, { href: text, text, title: null });
    return tr.setSelection(NodeSelection.create(tr.doc, selection.from)).scrollIntoView();
  }

  const { $from, $to } = selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) {
    return null;
  }
  const line = $from.parent;
  const wholeLine = $to.parentOffset - $from.parentOffset === line.content.size;
  const container = $from.depth > 0 ? $from.node($from.depth - 1) : null;
  const index = $from.depth > 0 ? $from.index($from.depth - 1) : 0;
  const fitsCard =
    line.type === paragraph &&
    wholeLine &&
    container !== null &&
    container.canReplaceWith(index, index + 1, cardType);

  if (!fitsCard) {
    const tr = state.tr.replaceSelectionWith(schema.text(text, [link.create({ href: text })]), false);
    return tr.removeStoredMark(link).scrollIntoView();
  }

  const lineStart = $from.before();
  const card = cardFromLink(cardType, urlLink);
  const tr = state.tr.replaceWith(lineStart, $from.after(), card);
  const after = lineStart + card.nodeSize;
  const next = tr.doc.resolve(after).nodeAfter;
  if (!(next?.type === paragraph && next.content.size === 0)) {
    tr.insert(after, paragraph.create());
  }
  return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
}

function linkMarkedTo(node: ProseNode, link: MarkType, href: string) {
  let marked = true;
  node.forEach((child) => {
    const mark = link.isInSet(child.marks);
    if (!child.isText || !mark || mark.attrs.href !== href) marked = false;
  });
  return marked;
}

/** The line a card was opened into, after each change.
 *
 *  While the caret is in it, the link's address follows its text, so an
 *  edited URL is saved as the URL the reader sees rather than the one the
 *  card had. Not during an IME composition, whose text node must not be
 *  rewritten under it; the next keystroke catches up. Once the caret leaves,
 *  a line that is still a bare URL is drawn as a card again, and anything else
 *  stays the text it now is.
 *
 *  Only that one line is looked at, never the document. */
export function settleLinkCardEditing(
  state: EditorState,
  transactions: readonly Transaction[] = [],
): Transaction | null {
  const pos = linkCardEditingKey.getState(state);
  if (pos === null || pos === undefined) return null;
  const node = pos <= state.doc.content.size ? state.doc.nodeAt(pos) : null;
  if (!node || node.type.name !== "paragraph") {
    return state.tr.setMeta(linkCardEditingKey, null);
  }

  const { selection } = state;
  const inside = selection.from > pos && selection.to < pos + node.nodeSize;
  if (inside) {
    const link = state.schema.marks.link;
    if (!link || !transactions.some((tr) => tr.docChanged)) return null;
    if (transactions.some((tr) => tr.getMeta("composition") !== undefined)) return null;
    const text = node.textContent;
    if (text !== text.trim() || !externalHttpUrl(text)) return null;
    if (linkMarkedTo(node, link, text)) return null;
    const from = pos + 1;
    const to = pos + node.nodeSize - 1;
    return state.tr
      .removeMark(from, to, link)
      .addMark(from, to, link.create({ href: text }))
      .setMeta("addToHistory", false);
  }

  const tr = state.tr.setMeta(linkCardEditingKey, null);
  const bare = bareExternalLink(node);
  const cardType = state.schema.nodes[LINK_CARD_NODE];
  if (bare && cardType) {
    tr.replaceWith(pos, pos + node.nodeSize, cardFromLink(cardType, bare));
  }
  return tr;
}

function plainKey(event: KeyboardEvent) {
  return !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
}

export function createLinkCardEditingPlugin() {
  return new Plugin<number | null>({
    key: linkCardEditingKey,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const meta = tr.getMeta(linkCardEditingKey) as number | null | undefined;
        if (meta !== undefined) return meta;
        if (value === null) return null;
        const mapped = tr.mapping.mapResult(value, 1);
        return mapped.deletedAfter ? null : mapped.pos;
      },
    },
    props: {
      handleKeyDown: (view, event) => {
        if (!plainKey(event) || event.isComposing) return false;
        const tr =
          event.key === "Backspace"
            ? openLinkCardBefore(view.state)
            : event.key === "Enter"
              ? lineAfterSelectedCard(view.state)
              : null;
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
      handlePaste: (view, event) => {
        if (!view.editable) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const tr = pasteLinkCard(view.state, text);
        if (!tr) return false;
        view.dispatch(tr.setMeta("uiEvent", "paste"));
        return true;
      },
    },
    appendTransaction: (transactions, _oldState, state) =>
      settleLinkCardEditing(state, transactions),
  });
}

export const linkCardEditing = $prose(() => createLinkCardEditingPlugin());

/** Absent capability, absent affordance: without `unfurl` a bare link stays a
 *  bare link. No card node, and no request to /api/unfurl. */
export function linkPreviewPlugin(enabled: boolean) {
  if (!enabled) return [];
  return [remarkLinkCard, linkCardSchema, linkCardView, linkCardEditing].flat();
}

/** The owner's plugins, as `scripts/verify-embed-roundtrip.mjs` loads them. */
export const linkPreview = linkPreviewPlugin(true);
