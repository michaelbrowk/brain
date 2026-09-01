"use client";

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  syncHeadingIdPlugin,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { block, BlockProvider } from "@milkdown/kit/plugin/block";
import {
  cursor,
  dropCursorConfig,
  dropIndicatorState,
} from "@milkdown/kit/plugin/cursor";
import type { Ctx } from "@milkdown/kit/ctx";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { $prose, insert } from "@milkdown/kit/utils";
import { colorMarks } from "./color-mark";
import { callout, CALLOUT_EMOJI_EVENT, type CalloutEmojiEventDetail } from "./callout";
import { columns } from "./columns";
import { emptyBlocks } from "./empty-block";
import { columnDrop } from "./column-drop";
import {
  editingCore,
  focusFirstEmptyBlock,
  TRAILING_PARAGRAPH_TRANSACTION_META,
} from "./editing-core";
import { normalizeLegacy } from "./normalize";
import {
  pageRef,
  setPageRefOrigin,
  syncLivePageInfo,
} from "./page-ref";
import {
  createPageRefNesting,
  standalonePageRefAnchors,
  type PageRefNestingSource,
  type ReparentPageRef,
  type RequestRemovePageRef,
} from "./page-ref-nesting";
import { pageFiling } from "./page-filing";
import {
  clearSearchHighlight,
  searchHighlight as searchHighlightPlugin,
  showSearchHighlight,
} from "./search-highlight";
import { toggle } from "./toggle";
import { images } from "./image";
import { handleWrapperImageDrop, imageUploadProgress } from "./image-upload";
import { math } from "./math";
import { linkPreview } from "./link-preview";
import { noNestedTables } from "./table-guard";
import { EditorBoundary } from "./editor-boundary";
import { EmojiPicker } from "../emoji-picker";

/** rows -> GFM table (pipes escaped, header = first row) */
function toGfmTable(rows: string[][]): string {
  const esc = (c: string) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    "| " + Array.from({ length: w }, (_, i) => esc(r[i] ?? "")).join(" | ") + " |";
  return [line(rows[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
}

/** clipboard text that looks like an Excel/Sheets range */
function parseTsv(t: string): string[][] | null {
  if (!t.includes("\t")) return null;
  const rows = t.replace(/\r/g, "").split("\n").filter((r) => r.length);
  if (rows.length < 2) return null;
  return rows.map((r) => r.split("\t"));
}
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FloatingToolbar, type PageRef } from "./floating-toolbar";
import { SlashMenu } from "./slash-menu";
import { WikiLinkMenu } from "./wikilink-menu";
import { attachmentMarkdown, isSpreadsheetFile, uploadAttachment } from "./attachments";
import {
  classifyInternalPageLink,
  followEditorLink,
  observeInternalPageLinks,
} from "./internal-page-link";
import "./milkdown.css";
import "./table-block.css";
import { hasTemplateCaret, takeTemplateCaret } from "@/lib/templates";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import type {
  SearchHighlightRequest,
  SearchHighlightStatus,
} from "@/lib/search-navigation";

interface EditorProps {
  value: string;
  onChange: (md: string) => void;
  onDirty?: () => void;
  onSerialized?: () => void;
  registerFlush?: (flush: () => void) => () => void;
  pages?: PageRef[];
  onNavigate?: (id: string) => void;
  onReparentPageRef?: ReparentPageRef;
  onRequestRemovePageRef?: RequestRemovePageRef;
  pageRefNestingPending?: boolean;
  pageRefNestingSource?: PageRefNestingSource;
  mutationsFrozen?: boolean;
  searchHighlight?: SearchHighlightRequest | null;
  onSearchHighlightStatus?: (
    requestId: number,
    status: SearchHighlightStatus,
  ) => void;
  onCreatePageAtCursor?: (
    insertPageRef: (page: PageRef) => boolean,
  ) => Promise<void>;
}

type CalloutEmojiAnchor = CalloutEmojiEventDetail & { id: number };

function isCalloutEmojiDetail(value: unknown): value is CalloutEmojiEventDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  return (
    typeof detail.pos === "number" &&
    Number.isFinite(detail.pos) &&
    typeof detail.left === "number" &&
    Number.isFinite(detail.left) &&
    typeof detail.top === "number" &&
    Number.isFinite(detail.top)
  );
}

const HANDLE_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g></svg>';

type BlockActive = NonNullable<BlockProvider["active"]>;

/** Milkdown's stock block service samples the horizontal center of the whole
 *  editor. In a two-column layout that points at the other column, so its drag
 *  handle can select the wrong block. Resolve the direct child of the actual
 *  column under the pointer instead. */
function columnBlockAtPoint(view: EditorView, event: PointerEvent): BlockActive | null {
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return null;

  const pos = Math.max(0, Math.min(coords.pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth - 1).type.name !== "col") continue;
    const node = $pos.node(depth);
    const nodePos = $pos.before(depth);
    const dom = view.nodeDOM(nodePos);
    const el = dom instanceof HTMLElement ? dom : dom?.parentElement;
    if (el) return { node, $pos: view.state.doc.resolve(nodePos), el };
  }

  if (coords.inside >= 0) {
    const node = view.state.doc.nodeAt(coords.inside);
    const $inside = view.state.doc.resolve(coords.inside);
    const dom = view.nodeDOM(coords.inside);
    const el = dom instanceof HTMLElement ? dom : dom?.parentElement;
    if (node?.isBlock && $inside.parent.type.name === "col" && el) {
      return { node, $pos: $inside, el };
    }
  }
  return null;
}

/** ProseMirror plugin view that owns the block drag handle. Registered via
 *  `ctx.set(block.key, { view })` so the block service drives update() on every
 *  transaction/hover — the piece the effect-based wiring was missing. */
class BlockHandleView {
  provider: BlockProvider;
  private readonly view: EditorView;
  private readonly content: HTMLDivElement;
  private columnActive: BlockActive | null = null;
  private activeSelection: NodeSelection | null = null;
  private customDragging = false;

  private readonly onPointerMove = (event: PointerEvent) => {
    const active = columnBlockAtPoint(this.view, event);
    if (!active) {
      this.columnActive = null;
      return;
    }
    // Keep the stock center-sampling handler from overwriting the correct
    // column-aware active block later in the same pointer event.
    event.stopImmediatePropagation();
    this.columnActive = active;
    this.provider.show(active);
  };

  private selectColumnBlock() {
    const active = this.columnActive;
    if (!active || !NodeSelection.isSelectable(active.node)) return null;
    const selection = NodeSelection.create(this.view.state.doc, active.$pos.pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.focus();
    this.activeSelection = selection;
    return selection;
  }

  private readonly onMouseDown = (event: MouseEvent) => {
    if (!this.columnActive) return;
    event.stopImmediatePropagation();
    this.selectColumnBlock();
  };

  private readonly onDragStart = (event: DragEvent) => {
    if (!this.columnActive) return;
    event.stopImmediatePropagation();
    const selection = this.activeSelection ?? this.selectColumnBlock();
    if (!selection || !event.dataTransfer) return;

    const slice = selection.content();
    const { dom, text } = this.view.serializeForClipboard(slice);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.clearData();
    event.dataTransfer.setData("text/html", dom.innerHTML);
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.setDragImage(this.columnActive.el, 0, 0);
    this.view.dragging = { slice, move: true };
    this.view.dom.dataset.dragging = "true";
    this.customDragging = true;
  };

  private readonly finishColumnDrag = () => {
    if (!this.customDragging) return;
    this.customDragging = false;
    this.activeSelection = null;
    this.columnActive = null;
    this.view.dragging = null;
    this.view.dom.dataset.dragging = "false";
    this.provider.hide();
  };

  private readonly onDragEnd = () => {
    if (!this.customDragging) return;
    this.finishColumnDrag();
  };

  constructor(ctx: Ctx, view: EditorView) {
    const content = document.createElement("div");
    content.className = "brain-block-handle";
    content.setAttribute("contenteditable", "false");
    content.innerHTML = HANDLE_SVG;
    this.view = view;
    this.content = content;
    this.provider = new BlockProvider({
      ctx,
      content,
      // List items indent their text past the marker column — push the handle
      // into the paragraph gutter so it never lands on bullets or numbers.
      getOffset: ({ active }) =>
        active.node.type.name === "list_item" ? 30 : 6,
    });
    this.view.dom.addEventListener("pointermove", this.onPointerMove, true);
    content.addEventListener("mousedown", this.onMouseDown, true);
    content.addEventListener("dragstart", this.onDragStart, true);
    content.addEventListener("dragend", this.onDragEnd, true);
    window.addEventListener("drop", this.finishColumnDrag);
    this.provider.update();
  }
  update() {
    this.provider.update();
  }
  destroy() {
    this.view.dom.removeEventListener("pointermove", this.onPointerMove, true);
    this.content.removeEventListener("mousedown", this.onMouseDown, true);
    this.content.removeEventListener("dragstart", this.onDragStart, true);
    this.content.removeEventListener("dragend", this.onDragEnd, true);
    window.removeEventListener("drop", this.finishColumnDrag);
    this.provider.destroy();
  }
}

class EditorSerializationSession {
  private documentChanged = false;
  private serializationBlocked: boolean;

  constructor(serializationBlocked: boolean) {
    this.serializationBlocked = serializationBlocked;
  }

  blockSerialization() {
    this.serializationBlocked = true;
  }

  isSerializationBlocked() {
    return this.serializationBlocked;
  }

  markDocumentChanged() {
    this.documentChanged = true;
  }

  takeDocumentChanged() {
    const documentChanged = this.documentChanged;
    this.documentChanged = false;
    return documentChanged;
  }
}

/** Milkdown syncs each heading's `id` attr with a transaction the moment the
 *  view mounts. The id never reaches markdown and `toDOM` derives it from the
 *  text anyway, so the transaction is display state. Counted as a document
 *  change, it made every read of a page with a heading a save on leave and a
 *  "Recovered unsaved draft" on the next visit. */
const commonmarkWithoutHeadingIdSync = commonmark.filter(
  (plugin) => plugin !== syncHeadingIdPlugin,
);

function Inner({
  value,
  onChange,
  onDirty,
  onSerialized,
  registerFlush,
  pages,
  onNavigate,
  onReparentPageRef,
  onRequestRemovePageRef,
  pageRefNestingPending = false,
  pageRefNestingSource,
  mutationsFrozen = false,
  searchHighlight,
  onSearchHighlightStatus,
  onCreatePageAtCursor,
}: EditorProps) {
  const lastEmitted = useRef(value);
  const [editorSession] = useState(
    () => new EditorSerializationSession(pageRefNestingPending),
  );
  // A centre-drop is server-first. Once accepted, the current document is a
  // frozen pre-move snapshot; blur, navigation and teardown must not serialize
  // it behind the composite request. Prop=true covers a remount after away/back
  // navigation, while onAccepted flips the old instance synchronously.
  const blockSerialization = useCallback(() => {
    editorSession.blockSerialization();
  }, [editorSession]);
  const emitMarkdown = useCallback((markdown: string) => {
    if (editorSession.isSerializationBlocked()) {
      onSerialized?.();
      return;
    }
    // The serializer ends the body with a newline the store trims, and the
    // first flush compares against the server body. Compare what the store
    // would persist, or every page differs from itself on its first flush.
    if (
      canonicalPageMarkdown(markdown) !==
      canonicalPageMarkdown(lastEmitted.current)
    ) {
      lastEmitted.current = markdown;
      const documentChanged = editorSession.takeDocumentChanged();
      // Initial serialization can normalize live page labels (for example by
      // adding the current icon) without any editor transaction. It is display
      // state, not a user edit, and must not materialize synthesized children.
      if (documentChanged) onChange(markdown);
    }
    onSerialized?.();
  }, [editorSession, onChange, onSerialized]);
  const notifyFromContext = useCallback((ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    const serialize = ctx.get(serializerCtx);
    emitMarkdown(serialize(view.state.doc));
  }, [emitMarkdown]);
  // Milkdown's markdown listener intentionally waits 200ms. Marking the editor
  // dirty in filterTransaction is synchronous and cheap, so SSE cannot replace
  // a just-typed document during that serialization window.
  const immediateDirty = useMemo(
    () =>
      $prose(
        () =>
          new Plugin({
            key: new PluginKey("brainImmediateDirty"),
            filterTransaction: (transaction) => {
              const isSyntheticTrailingParagraph =
                transaction.getMeta(TRAILING_PARAGRAPH_TRANSACTION_META) === true;
              if (transaction.docChanged && !isSyntheticTrailingParagraph) {
                editorSession.markDocumentChanged();
              }
              if (
                transaction.docChanged &&
                !isSyntheticTrailingParagraph &&
                transaction.getMeta("addToHistory") !== false
              ) {
                onDirty?.();
              }
              return true;
            },
          }),
      ),
    [editorSession, onDirty],
  );
  const pageRefNesting = useMemo(
    () =>
      createPageRefNesting(
        onReparentPageRef ?? (() => null),
        pageRefNestingPending,
        blockSerialization,
        onRequestRemovePageRef,
      ),
    [
      blockSerialization,
      onReparentPageRef,
      onRequestRemovePageRef,
      pageRefNestingPending,
    ],
  );
  const wrap = useRef<HTMLDivElement | null>(null);
  const calloutEmojiTrigger = useRef<HTMLButtonElement | null>(null);
  const calloutEmojiId = useRef(0);
  const [calloutEmoji, setCalloutEmoji] = useState<CalloutEmojiAnchor | null>(null);

  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, value);
        setPageRefOrigin(window.location.origin);
        ctx.set(editorViewOptionsCtx, {
          editable: () => !pageRefNestingPending && !mutationsFrozen,
          // B6: the toolbar pills float over the top of the canvas (36 +
          // inset 12); the caret and a typed line must never scroll up
          // under them — start scrolling inside the band and land below it
          scrollThreshold: { top: 64, right: 0, bottom: 24, left: 0 },
          scrollMargin: { top: 76, right: 0, bottom: 32, left: 0 },
          attributes: {
            "aria-label": "Page content",
            "aria-multiline": "true",
            ...(pageRefNestingPending || mutationsFrozen
              ? {
                  "aria-busy": "true",
                  "aria-readonly": "true",
                  ...(pageRefNestingPending
                    ? { "data-page-ref-nest-pending-editor": "true" }
                    : { "data-page-ref-restore-pending-editor": "true" }),
                }
              : {}),
          },
        });
        ctx
          .get(listenerCtx)
          .markdownUpdated((_, md, prev) => {
            if (md !== prev) emitMarkdown(md);
          })
          .blur(notifyFromContext);
        // Navigation and every Shell-driven remount serialize through the
        // registered flush callback before teardown. Milkdown removes the
        // serializer context before destroy listeners run, so serializing from
        // `destroy` is both too late and can surface a lifecycle exception.
        // register the block drag handle as the block plugin's view
        ctx.set(block.key, { view: (view) => new BlockHandleView(ctx, view) });
        // insertion line while dragging a block (like the sidebar drop-line)
        ctx.set(dropCursorConfig.key, {
          width: 2,
          color: "var(--ink)",
          class: "brain-drop-cursor",
        });
        // Seed the single live page directory used by the serializer and
        // mounted NodeViews.
        syncLivePageInfo(pages);
      })
      .use(commonmarkWithoutHeadingIdSync)
      .use(gfm)
      .use(noNestedTables)
      .use(normalizeLegacy)
      .use(editingCore)
      .use(colorMarks)
      .use(columns)
      .use(emptyBlocks)
      .use(callout)
      .use(toggle)
      .use(images)
      .use(imageUploadProgress)
      .use(math)
      .use(pageRef)
      .use(linkPreview)
      .use(tableBlock)
      .use(history)
      // markdown-aware copy/paste: pasted markdown text becomes real blocks
      // (headings, lists, quotes…) instead of literal text, pasted HTML from
      // Notion/Docs converts through the schema, and copy yields clean markdown
      .use(clipboard)
      .use(block)
      .use(cursor)
      // a child the body does not link yet is dragged out of the derived tail
      // and dropped into the document; the insertion is Milkdown's own
      // external-drop path, this owns the refusal (said on dragover, while the
      // reader can still act on it) and the report the tail announces
      .use(pageFiling)
      // centre of another standalone page block → make it the new parent;
      // upper/lower edges continue through Milkdown's normal reorder pipeline
      .use(pageRefNesting)
      // drag a block to another block's side edge → columns. Passive overlay:
      // never disturbs the block reorder above; only acts on a side-edge drop
      .use(columnDrop)
      .use(searchHighlightPlugin)
      .use(immediateDirty)
      .use(listener),
  );

  useEffect(() => {
    let attemptFrame = 0;
    let scrollFrame = 0;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    let mountedView: EditorView | null = null;
    let disposed = false;
    let attempts = 0;

    const apply = () => {
      if (disposed) return;
      let ready = false;
      try {
        get()?.action((ctx) => {
          ready = true;
          const view = ctx.get(editorViewCtx);
          mountedView = view;
          if (!searchHighlight) {
            clearSearchHighlight(view);
            return;
          }
          const resolution = showSearchHighlight(
            view,
            searchHighlight.requestId,
            searchHighlight.target,
          );
          onSearchHighlightStatus?.(
            searchHighlight.requestId,
            resolution.status,
          );
          if (resolution.status !== "exact") return;

          scrollFrame = requestAnimationFrame(() => {
            const match = view.dom.querySelector<HTMLElement>(
              `[data-search-highlight="${searchHighlight.requestId}"]`,
            );
            match?.scrollIntoView({
              block: "center",
              inline: "nearest",
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
            });
          });
          clearTimer = setTimeout(() => {
            clearSearchHighlight(view, searchHighlight.requestId);
            onSearchHighlightStatus?.(
              searchHighlight.requestId,
              "cleared",
            );
          }, 4_000);
        });
      } catch {
        ready = false;
      }
      if (!ready && attempts < 60) {
        attempts += 1;
        attemptFrame = requestAnimationFrame(apply);
      }
    };

    attemptFrame = requestAnimationFrame(apply);
    return () => {
      disposed = true;
      cancelAnimationFrame(attemptFrame);
      cancelAnimationFrame(scrollFrame);
      if (clearTimer) clearTimeout(clearTimer);
      if (mountedView && searchHighlight) {
        clearSearchHighlight(mountedView, searchHighlight.requestId);
      }
    };
  }, [get, onSearchHighlightStatus, searchHighlight]);

  // A page the New-page menu just built from a template opens writing-ready:
  // caret in the first empty section, so the slash hint shows under the first
  // heading. The menu keys the handoff by page id; the canonical /p/<id> URL
  // is already in place by the time this editor mounts.
  useEffect(() => {
    const pageId = classifyInternalPageLink(
      window.location.pathname,
      window.location.origin,
    )?.id;
    if (!pageId || !hasTemplateCaret(pageId)) return;
    let frame = 0;
    let attempts = 0;
    const place = () => {
      let ready = false;
      try {
        get()?.action((ctx) => {
          ready = true;
          // the handoff is taken only by the instance that places the caret —
          // the editor remounts while a page settles (and twice in dev)
          if (takeTemplateCaret(pageId)) {
            focusFirstEmptyBlock(ctx.get(editorViewCtx));
          }
        });
      } catch {
        ready = false;
      }
      if (!ready && attempts < 60) {
        attempts += 1;
        frame = requestAnimationFrame(place);
      }
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [get]);

  useEffect(() => {
    if (!pageRefNestingPending || !pageRefNestingSource) return;
    let marked: HTMLElement | null = null;
    const frame = requestAnimationFrame(() => {
      get()?.action((ctx) => {
        const editor = ctx.get(editorViewCtx).dom;
        const matches = standalonePageRefAnchors(editor).filter(
          (anchor) => anchor.dataset.pageRef === pageRefNestingSource.id,
        );
        marked = matches[pageRefNestingSource.occurrence] ?? null;
        marked?.setAttribute("data-page-ref-nest-pending", "true");
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      marked?.removeAttribute("data-page-ref-nest-pending");
    };
  }, [get, pageRefNestingPending, pageRefNestingSource]);

  useEffect(() => {
    if (!registerFlush) return;
    return registerFlush(() => {
      if (editorSession.isSerializationBlocked()) {
        onSerialized?.();
        return;
      }
      get()?.action(notifyFromContext);
    });
  }, [editorSession, get, notifyFromContext, onSerialized, registerFlush]);

  // prosemirror-dropcursor removes its line when drop/dragend reach the editor
  // DOM. Our capture handlers stopPropagation for image/file uploads, and a
  // drag cancelled outside the window never fires them at all — the line stuck
  // across the page ("рандомные линии"). Sweep strays at the window level.
  useEffect(() => {
    const clear = () => {
      // Milkdown owns one persistent indicator element and keeps updating it
      // through this state slice. Removing that DOM node fixes the current
      // line but permanently detaches every later drag indicator until reload.
      try {
        get()?.action((ctx) => ctx.set(dropIndicatorState.key, null));
      } catch {
        // A server-first nesting drop remounts the editor immediately. The
        // window-level cleanup can outlive the old cursor context by one tick;
        // the replacement editor already starts with an empty indicator.
      }
    };
    // capture phase: our own onDropCapture stopPropagation()s upload drops, so
    // bubble listeners would never fire
    const onDrop = () => setTimeout(clear, 0); // after PM handles the drop
    const onDragEnd = () => clear();
    // only when the drag leaves the WINDOW (cancelled file drag from Finder) —
    // inner dragleaves fire on every element boundary
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) clear();
    };
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("dragleave", onDragLeave, true);
    return () => {
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("dragleave", onDragLeave, true);
    };
  }, [get]);

  useEffect(() => {
    const root = wrap.current;
    if (!root) return;

    const onCalloutEmoji = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isCalloutEmojiDetail(event.detail)) return;
      event.stopPropagation();
      setCalloutEmoji({ ...event.detail, id: calloutEmojiId.current++ });
    };

    root.addEventListener(CALLOUT_EMOJI_EVENT, onCalloutEmoji);
    return () => root.removeEventListener(CALLOUT_EMOJI_EVENT, onCalloutEmoji);
  }, []);

  useEffect(() => {
    const root = wrap.current;
    if (!root) return;
    return observeInternalPageLinks(root, window.location.origin);
  }, []);

  useEffect(() => {
    if (!calloutEmoji) return;
    const frame = requestAnimationFrame(() => calloutEmojiTrigger.current?.click());
    return () => cancelAnimationFrame(frame);
  }, [calloutEmoji]);

  // Keep the page directory current so mounted blocks update immediately after
  // rename, icon changes, or a previously missing id becoming available.
  useEffect(() => {
    syncLivePageInfo(pages);
  }, [pages]);

  const pickCalloutEmoji = (emoji: string) => {
    const anchor = calloutEmoji;
    setCalloutEmoji(null);
    if (!anchor) return;

    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const node = view.state.doc.nodeAt(anchor.pos);
      if (!node || node.type.name !== "callout") return;
      view.dispatch(view.state.tr.setNodeAttribute(anchor.pos, "icon", emoji).scrollIntoView());
      view.focus();
    });
  };

  return (
    <div
      ref={wrap}
      className="relative"
      aria-busy={mutationsFrozen || undefined}
      aria-readonly={mutationsFrozen || undefined}
      onDragOverCapture={(e) => {
        // A frozen editor takes nothing. Say so during the drag: without a
        // preventDefault here the browser never arms the drop, and `no-drop`
        // is what tells the reader that before they let go.
        if (mutationsFrozen && e.dataTransfer) e.dataTransfer.dropEffect = "none";
      }}
      onDropCapture={(e) => {
        if (mutationsFrozen) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const images = Array.from(e.dataTransfer?.files ?? []).filter((x) =>
          x.type.startsWith("image/"),
        );
        if (images.length) {
          // Own every image drop at the wrapper boundary. A short document has
          // whitespace below ProseMirror; letting that native drop continue
          // navigates the tab to the local file instead of uploading it.
          e.preventDefault();
          e.stopPropagation();
          get()?.action((ctx) => {
            handleWrapperImageDrop(
              ctx.get(editorViewCtx),
              e.nativeEvent,
              images,
            );
          });
          return;
        }
        const f = e.dataTransfer?.files?.[0];
        if (!f) return;
        if (!isSpreadsheetFile(f)) {
          e.preventDefault();
          e.stopPropagation();
          uploadAttachment(f).then((file) => {
            if (file) get()?.action(insert(attachmentMarkdown(file)));
          });
          return;
        }
        // dropping an Excel/CSV file inserts it as a table
        e.preventDefault();
        e.stopPropagation();
        (async () => {
          const XLSX = await import("xlsx");
          const wb = XLSX.read(await f.arrayBuffer());
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
            header: 1,
            raw: false,
            defval: "",
          }) as string[][];
          const trimmed = rows.filter((r) => r.some((c) => String(c).trim())).slice(0, 200);
          if (trimmed.length) get()?.action(insert(toGfmTable(trimmed)));
        })();
      }}
      onPasteCapture={(e) => {
        if (mutationsFrozen) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Image files continue to ProseMirror's upload plugin so paste keeps
        // the original mapped cursor position while the request is in flight.
        if (Array.from(e.clipboardData?.files ?? []).some((x) => x.type.startsWith("image/"))) return;
        const file = Array.from(e.clipboardData?.files ?? []).find(
          (x) => !x.type.startsWith("image/") && !isSpreadsheetFile(x),
        );
        if (file) {
          e.preventDefault();
          uploadAttachment(file).then((uploaded) => {
            if (uploaded) get()?.action(insert(attachmentMarkdown(uploaded)));
          });
          return;
        }
        const t = e.clipboardData?.getData("text/plain")?.trim();
        // pasting a range from Excel/Sheets becomes a table
        const tsv = t ? parseTsv(t) : null;
        if (tsv) {
          e.preventDefault();
          get()?.action(insert(toGfmTable(tsv)));
          return;
        }
        // pasting a page URL turns into a titled link to that page
        const internal = classifyInternalPageLink(t, window.location.origin);
        if (!internal) return;
        const pg = pages?.find((x) => x.id === internal.id);
        if (pg) {
          e.preventDefault();
          const label = `${pg.icon ? pg.icon + " " : ""}${pg.title}`;
          get()?.action(insert(`[${label}](${internal.href})`));
        }
      }}
      onClickCapture={(e) => {
        // clicking a page link navigates (Notion behaviour). Clicking anywhere
        // else — including the empty part of a link's line — places the cursor,
        // so you can add prose above/below a link block.
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
        const target = anchor?.getAttribute("target")?.trim().toLowerCase();
        if (
          !anchor ||
          anchor.hasAttribute("download") ||
          (target && target !== "_self")
        )
          return;
        const followed = followEditorLink(
          anchor.getAttribute("href"),
          window.location.origin,
          onNavigate,
          (href) => window.open(href, "_blank", "noopener,noreferrer"),
        );
        if (!followed) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Milkdown />
      <FloatingToolbar container={wrap} pages={pages} />
      <SlashMenu
        container={wrap}
        onCreatePageAtCursor={onCreatePageAtCursor}
      />
      <WikiLinkMenu container={wrap} pages={pages ?? []} />
      {calloutEmoji && (
        <EmojiPicker
          key={calloutEmoji.id}
          onPick={pickCalloutEmoji}
          onRemove={() => setCalloutEmoji(null)}
        >
          <button
            ref={calloutEmojiTrigger}
            type="button"
            tabIndex={-1}
            aria-label="Change callout icon"
            style={{
              position: "fixed",
              left: calloutEmoji.left,
              top: calloutEmoji.top,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        </EmojiPicker>
      )}
    </div>
  );
}

/** Milkdown markdown-WYSIWYG. Re-mount per page via `key` to load new content. */
export function MilkdownEditor(props: EditorProps) {
  return (
    <EditorBoundary value={props.value}>
      <MilkdownProvider>
        <Inner {...props} />
      </MilkdownProvider>
    </EditorBoundary>
  );
}
