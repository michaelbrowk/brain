"use client";

import { apiFetch } from "@/lib/client";
import { useInstance } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  AllSelection,
  TextSelection,
  type EditorState,
} from "@milkdown/kit/prose/state";
import { callCommand, markdownToSlice } from "@milkdown/kit/utils";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  turnIntoTextCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand, insertTableCommand } from "@milkdown/kit/preset/gfm";
import { setTextColorCommand, setHighlightCommand } from "./color-mark";
import { AnimatePresence, motion } from "framer-motion";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { DUR, EASE_OUT } from "@/lib/motion";
import {
  EDITOR_DOC_CHANGED_EVENT,
  EDITOR_LINK_FIELD_EVENT,
  notifyNestedTableBlocked,
} from "@/lib/editor-events";
import { linkSelection } from "./insert-inline";
import { linkedWordsHref, linkedWordsPageId } from "@/lib/internal-page-link";
import { isInTable } from "./table-guard";
import { selectionIsInQuote, selectionIsTask, toggleTaskCommand } from "./task-checkbox";
import {
  type LinkRange,
  hrefForWords,
  linkRangeAt,
  removeLink,
  setLinkHref,
  webHref,
} from "./web-link";

const COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
  "brown",
] as const;
type SelectionAiMode = "improve" | "summarize" | "fix";

const AI_ACTIONS: { label: string; mode: SelectionAiMode }[] = [
  { label: "Improve", mode: "improve" },
  { label: "Summarize", mode: "summarize" },
  { label: "Fix grammar", mode: "fix" },
];

interface Pos {
  top: number;
  left: number;
  /** on touch the bar docks above the keyboard (full width) instead of
   *  floating over the selection — avoids overflow + the iOS menu collision */
  mobile?: boolean;
}

interface ToolbarViewport {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const VIEWPORT_GAP = 8;
const TOOLBAR_GAP = 6;

/** A selection can start with a zero-width rect (for example around an inline
 * atom). Anchor to the first painted rect so the toolbar never jumps to the
 * editor origin. */
export function firstVisibleSelectionRect(range: Range): DOMRect | null {
  try {
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    const fallback = range.getBoundingClientRect();
    return fallback.width > 0 && fallback.height > 0 ? fallback : null;
  } catch {
    return null;
  }
}

function viewportBounds(): ToolbarViewport {
  const vv = window.visualViewport;
  const left = vv?.offsetLeft ?? 0;
  const top = vv?.offsetTop ?? 0;
  return {
    left,
    top,
    right: left + (vv?.width ?? window.innerWidth),
    bottom: top + (vv?.height ?? window.innerHeight),
  };
}

/** Fixed-position placement shared by the initial estimate and measured
 * reflow. It clamps horizontally and flips below when the top edge is tight. */
export function placeFloatingToolbar(
  anchor: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width">,
  size: { width: number; height: number },
  viewport: ToolbarViewport,
): Pos {
  const half = size.width / 2;
  const minLeft = viewport.left + VIEWPORT_GAP + half;
  const maxLeft = viewport.right - VIEWPORT_GAP - half;
  const desiredLeft = anchor.left + anchor.width / 2;
  const left =
    minLeft <= maxLeft
      ? Math.min(Math.max(desiredLeft, minLeft), maxLeft)
      : viewport.left + (viewport.right - viewport.left) / 2;

  const above = anchor.top - TOOLBAR_GAP - size.height;
  const below = anchor.bottom + TOOLBAR_GAP;
  const top =
    above >= viewport.top + VIEWPORT_GAP
      ? above
      : Math.min(below, viewport.bottom - VIEWPORT_GAP - size.height);

  return {
    left,
    top: Math.max(viewport.top + VIEWPORT_GAP, top),
  };
}

export function selectionRectIntersectsViewport(
  anchor: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  viewport: ToolbarViewport,
): boolean {
  return (
    anchor.bottom >= viewport.top &&
    anchor.top <= viewport.bottom &&
    anchor.right >= viewport.left &&
    anchor.left <= viewport.right
  );
}

export function selectionIsInTable(state: Pick<EditorState, "selection">): boolean {
  return isInTable(state.selection.$from) || isInTable(state.selection.$to);
}

/** Whether every line the selection touches is already a task, and whether
 *  the selection sits in a quote at all. Both live with the command that acts
 *  on those lines, so the pressed state this toolbar draws, the button it
 *  disables, and the press behind them read the same blocks. */
export { selectionIsTask, selectionIsInQuote };

/** The browser can keep a painted DOM range after the editor loses focus, and
 * ProseMirror keeps a NodeSelection after a block drag. Neither is an active
 * text selection: reacting to later scroll/resize events would resurrect the
 * formatting toolbar even though the user did not select text. */
export function selectionOwnsFloatingToolbar(
  state: Pick<EditorState, "selection">,
  editorHasFocus: boolean,
): boolean {
  return (
    editorHasFocus &&
    (state.selection instanceof TextSelection ||
      state.selection instanceof AllSelection) &&
    !state.selection.empty
  );
}

async function askAi(mode: SelectionAiMode, text: string): Promise<string> {
  try {
    const res = await apiFetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, text }),
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    if (data?.error || typeof data?.result !== "string") return "";
    return data.result.trim();
  } catch {
    return "";
  }
}

/** Notion-style selection toolbar: appears above a text selection,
 *  runs Milkdown commands without stealing the selection. */
export interface PageRef {
  id: string;
  title: string;
  icon?: string;
  /** An app page, so every surface that names it can draw the AI chip. */
  kind?: "app";
}

export function FloatingToolbar({
  container,
  pages = [],
  ai = false,
  tasks = true,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  pages?: PageRef[];
  /** Renders the AI control. Without it the /api/ai call has no way in:
   *  the button that opens the panel is not in the DOM. */
  ai?: boolean;
  /** The Tasks module. Off and the Task button is absent, because the
   *  command it runs is not registered with the editor at all. */
  tasks?: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState<SelectionAiMode | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  // The link the field is editing, when it opened over one that is already
  // there (a click on it, or the caret in it): Enter rewrites its address
  // over its whole extent, and the rows under the field open or remove it.
  const [linkEdit, setLinkEdit] = useState<LinkRange | null>(null);
  // The origin a page address is judged against, read once: the window is
  // not a value to read while rendering.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [inTable, setInTable] = useState(false);
  const [inQuote, setInQuote] = useState(false);
  const [taskActive, setTaskActive] = useState(false);
  const [, getEditor] = useInstance();
  const [pos, setPos] = useState<Pos | null>(null);
  const raf = useRef<number>(0);
  const barRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  // touch = dock the bar above the keyboard; kbInset tracks the keyboard height
  // via visualViewport (a fixed element sits below the keyboard otherwise)
  const [isMobile, setIsMobile] = useState(false);
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const onMq = () => setIsMobile(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    const vv = window.visualViewport;
    const onVv = () => {
      if (vv) setKbInset(Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)));
    };
    onVv();
    vv?.addEventListener("resize", onVv);
    vv?.addEventListener("scroll", onVv);
    return () => {
      mq.removeEventListener("change", onMq);
      vv?.removeEventListener("resize", onVv);
      vv?.removeEventListener("scroll", onVv);
    };
  }, []);

  const submenuOpen = linkOpen || colorOpen || aiOpen;

  const currentSelectionIsInTable = useCallback(() => {
    let next = false;
    getEditor()?.action((ctx) => {
      next = selectionIsInTable(ctx.get(editorViewCtx).state);
    });
    return next;
  }, [getEditor]);

  const currentSelectionIsTask = useCallback(() => {
    let next = false;
    getEditor()?.action((ctx) => {
      next = selectionIsTask(ctx.get(editorViewCtx).state);
    });
    return next;
  }, [getEditor]);

  const currentSelectionIsInQuote = useCallback(() => {
    let next = false;
    getEditor()?.action((ctx) => {
      next = selectionIsInQuote(ctx.get(editorViewCtx).state);
    });
    return next;
  }, [getEditor]);

  const editorOwnsLiveSelection = useCallback(() => {
    let ownsSelection = false;
    getEditor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      ownsSelection = selectionOwnsFloatingToolbar(view.state, view.hasFocus());
    });
    return ownsSelection;
  }, [getEditor]);

  const update = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const root = container.current;
      const sel = window.getSelection();
      if (!root) {
        setPos(null);
        return;
      }

      const hasLiveEditorSelection = Boolean(
        editorOwnsLiveSelection() &&
          sel &&
          !sel.isCollapsed &&
          sel.rangeCount > 0 &&
          root.contains(sel.anchorNode) &&
          root.contains(sel.focusNode),
      );
      const toolbarOwnsFocus = Boolean(
        document.activeElement &&
          barRef.current?.contains(document.activeElement),
      );
      let range: Range | null = null;
      if (hasLiveEditorSelection && sel) {
        range = sel.getRangeAt(0).cloneRange();
        savedRange.current = range;
      } else if ((submenuOpen || toolbarOwnsFocus) && savedRange.current) {
        range = savedRange.current;
      }

      if (!range || !root.contains(range.commonAncestorContainer)) {
        savedRange.current = null;
        setPos(null);
        setInTable(false);
        setInQuote(false);
        setTaskActive(false);
        return;
      }

      // The line the selection sits in, BEFORE anything about where the bar
      // goes. A press rewrites the block under a caret that has not moved, so
      // the rect can be stale or gone while the pressed state is still owed
      // an answer.
      setInTable(currentSelectionIsInTable());
      setInQuote(currentSelectionIsInQuote());
      setTaskActive(currentSelectionIsTask());

      const rect = firstVisibleSelectionRect(range);
      if (!rect) {
        setPos(null);
        return;
      }
      const viewport = viewportBounds();
      if (!selectionRectIntersectsViewport(rect, viewport)) {
        setPos(null);
        return;
      }

      // touch: don't chase the selection — dock at the bottom (rendered fixed)
      if (isMobile) {
        setPos({ mobile: true, top: 0, left: 0 });
        return;
      }

      const measured = barRef.current?.getBoundingClientRect();
      const estimate = {
        width: measured?.width || Math.min(520, window.innerWidth - VIEWPORT_GAP * 2),
        height: measured?.height || 38,
      };
      setPos(placeFloatingToolbar(rect, estimate, viewport));
    });
  }, [
    container,
    currentSelectionIsInQuote,
    currentSelectionIsInTable,
    currentSelectionIsTask,
    editorOwnsLiveSelection,
    isMobile,
    submenuOpen,
  ]);

  useEffect(() => {
    document.addEventListener("selectionchange", update);
    // The editor's own transactions, for the press that changes the line
    // without moving the browser's selection.
    window.addEventListener(EDITOR_DOC_CHANGED_EVENT, update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener(EDITOR_DOC_CHANGED_EVENT, update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [update]);

  // The frame a placement is waiting on goes only with the toolbar. It used
  // to go every time the listeners above were re-bound, which is every time
  // `update` is remade: the frame the layout effect below had just asked for
  // was cancelled in the same commit, and a field opened with no bar up
  // (over a link the caret already stood in) never got its place.
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // The first pass uses an estimate. Re-run after the portal has measured the
  // actual main bar or submenu, which can have very different dimensions.
  // The link field can open with no bar up (over a link the caret is in, with
  // nothing selected), so its opening is a reason to place the bar too.
  useLayoutEffect(() => {
    if (pos || linkOpen) update();
    // `pos` intentionally contributes only visibility: depending on its
    // coordinates would turn the measurement correction into a render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(pos), linkOpen, colorOpen, aiOpen, aiLoading, update]);

  const closeAiAndRestoreSelection = useCallback(() => {
    setAiOpen(false);
    getEditor()?.action((ctx) => ctx.get(editorViewCtx).focus());
  }, [getEditor]);

  const closeLinkField = useCallback(() => {
    setLinkOpen(false);
    setLinkEdit(null);
    setLinkQuery("");
  }, []);

  const closeLinkAndRestoreSelection = useCallback(() => {
    closeLinkField();
    getEditor()?.action((ctx) => ctx.get(editorViewCtx).focus());
  }, [closeLinkField, getEditor]);

  /** The field, over the bar's saved range: for the selected words, or for
   *  the link the selection stands in, whose address it then shows. */
  const openLinkField = useCallback(
    (edit: LinkRange | null) => {
      setAiOpen(false);
      setColorOpen(false);
      setLinkEdit(edit);
      setLinkQuery(edit?.href ?? "");
      setLinkOpen(true);
    },
    [],
  );

  /** The web link the whole selection stands in, or null. Words selected
   *  inside one link are that link's: the field shows its address, and
   *  Enter rewrites it over the whole link, not only over the words. */
  const webLinkAroundSelection = useCallback(() => {
    let found: LinkRange | null = null;
    getEditor()?.action((ctx) => {
      const { state } = ctx.get(editorViewCtx);
      const { from, to } = state.selection;
      const range = linkRangeAt(state, from);
      if (!range || to > range.to || webHref(range.href, origin) === null) return;
      found = range;
    });
    return found;
  }, [getEditor, origin]);

  /** The field over a link with nothing selected, anchored to the anchor
   *  element the link is drawn as, so the bar stands over it. */
  const openLinkFieldOver = useCallback(
    (anchor: HTMLAnchorElement, range: LinkRange) => {
      const domRange = document.createRange();
      domRange.selectNodeContents(anchor);
      savedRange.current = domRange;
      openLinkField(range);
    },
    [openLinkField],
  );

  // A plain click on a web link, after the editor has put the caret in it.
  // The editor's own click handler leaves a web link alone on a plain click;
  // a modifier click stays the browser's, as for every link; a page link,
  // linked words, an attachment and a card never reach here (`webHref`, the
  // card's own attribute).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]") ?? null;
      const windowTarget = anchor?.getAttribute("target")?.trim().toLowerCase();
      if (
        !anchor ||
        !container.current?.contains(anchor) ||
        anchor.dataset.pageRef !== undefined ||
        anchor.hasAttribute("data-brain-link-card") ||
        anchor.hasAttribute("download") ||
        (windowTarget && windowTarget !== "_self") ||
        webHref(anchor.getAttribute("href"), origin) === null
      )
        return;
      getEditor()?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // A read-only editor (a lossy load, a frozen page) has no field: it
        // would edit a document that is never saved. The click stays the
        // editor's, which opens the link.
        if (!view.editable) return;
        const range = linkRangeAt(view.state, view.posAtDOM(anchor, 0));
        if (range) openLinkFieldOver(anchor, range);
      });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [container, getEditor, openLinkFieldOver, origin]);

  // Mod-Shift-k in the editor: the field for the selected words, or for the
  // link the caret stands in. With neither there is nothing to link.
  useEffect(() => {
    const onAsk = () => {
      getEditor()?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view.editable) return;
        const { selection } = view.state;
        if (!selection.empty) {
          if (!selectionOwnsFloatingToolbar(view.state, true)) return;
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange();
          openLinkField(webLinkAroundSelection());
          return;
        }
        const range = linkRangeAt(view.state, selection.from);
        if (!range || webHref(range.href, origin) === null) return;
        const { node } = view.domAtPos(Math.min(range.from + 1, range.to));
        const element = node instanceof Element ? node : node.parentElement;
        const anchor = element?.closest<HTMLAnchorElement>("a[href]");
        if (anchor) openLinkFieldOver(anchor, range);
      });
    };
    window.addEventListener(EDITOR_LINK_FIELD_EVENT, onAsk);
    return () => window.removeEventListener(EDITOR_LINK_FIELD_EVENT, onAsk);
  }, [getEditor, openLinkField, openLinkFieldOver, origin, webLinkAroundSelection]);

  useEffect(() => {
    if (!aiOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && barRef.current?.contains(event.target)) return;
      setAiOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAiAndRestoreSelection();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [aiOpen, closeAiAndRestoreSelection]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (key: any, payload?: unknown) => {
    getEditor()?.action(callCommand(key, payload));
    update();
  };

  const insertTable = () => {
    const editor = getEditor();
    if (!editor) return;
    let blocked = false;
    editor.action((ctx) => {
      blocked = selectionIsInTable(ctx.get(editorViewCtx).state);
    });
    if (blocked) {
      notifyNestedTableBlocked();
      setInTable(true);
      return;
    }
    editor.action(callCommand(insertTableCommand.key, { row: 3, col: 3 }));
    update();
  };

  const runAiOnSelection = useCallback(
    async (mode: SelectionAiMode) => {
      const ed = getEditor();
      if (!ed || aiLoading) return;

      let from = -1;
      let to = -1;
      let selectedText = "";

      ed.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        from = state.selection.from;
        to = state.selection.to;
        selectedText = state.doc.textBetween(from, to, "\n\n", "\n");
      });

      const text = selectedText.trim();
      if (!text || from === to) {
        setAiOpen(false);
        return;
      }

      setAiOpen(false);
      setAiLoading(mode);
      const result = await askAi(mode, text);
      setAiLoading(null);
      if (!result) return;

      ed.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        if (state.selection.from !== from || state.selection.to !== to) return;
        if (state.doc.textBetween(from, to, "\n\n", "\n") !== selectedText) return;
        const slice = markdownToSlice(result)(ctx);
        view.dispatch(state.tr.replace(from, to, slice).scrollIntoView());
        view.focus();
      });
    },
    [aiLoading, getEditor],
  );

  const insertPageLink = (pg: PageRef) => {
    getEditor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const tr = linkSelection(view.state, linkedWordsHref(pg.id));
      if (tr) view.dispatch(tr);
      view.focus();
    });
    closeLinkField();
    setPos(null);
  };

  const linkQueryText = linkQuery.trim();
  const linkResults = linkEdit
    ? []
    : pages
        .filter((pg) => pg.title.toLowerCase().includes(linkQuery.trim().toLowerCase()))
        .slice(0, 6);
  // The address the typed text reads as. A bare domain (`notes.md`) is one
  // only when no page is titled like it: a scheme, `www.`, a path or a mail
  // address says address on its own, and then the page rows stand under the
  // address row rather than giving way. One of this Brain's own page URLs
  // links the words to the page (`hrefForWords`), shown as typed.
  const linkCandidate = linkEdit ? null : hrefForWords(linkQueryText, origin);
  const addressOnItsOwn =
    /^(https?:\/\/|mailto:|www\.)/i.test(linkQueryText) ||
    linkQueryText.includes("/") ||
    linkQueryText.includes("@");
  const typedHref =
    linkCandidate && (addressOnItsOwn || linkResults.length === 0) ? linkCandidate : null;
  const typedHrefLabel =
    typedHref && linkedWordsPageId(typedHref, origin) !== null ? linkQueryText : typedHref;

  /** The link the field opened over, where it still is: the document may
   *  have changed under the field, and a rewrite of other words is worse
   *  than none. */
  const editedLink = (state: EditorState) => {
    if (!linkEdit) return null;
    const range = linkRangeAt(state, linkEdit.from);
    return range && range.href === linkEdit.href ? range : null;
  };

  /** `href` on the selected words, or over the whole link the field opened
   *  on. The words stay in either case. */
  const applyWebLink = (href: string) => {
    getEditor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = editedLink(view.state);
      const tr = linkEdit
        ? range && setLinkHref(view.state, range, href)
        : linkSelection(view.state, href);
      if (tr) view.dispatch(tr.scrollIntoView());
      view.focus();
    });
    closeLinkField();
    setPos(null);
  };

  const removeEditedLink = () => {
    getEditor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = editedLink(view.state);
      if (range) view.dispatch(removeLink(view.state, range).scrollIntoView());
      view.focus();
    });
    closeLinkField();
    setPos(null);
  };

  const openEditedLink = () => {
    const href = linkEdit?.href;
    closeLinkAndRestoreSelection();
    if (!href) return;
    // A mail address opens the mail client, not a tab.
    if (href.toLowerCase().startsWith("mailto:")) window.location.assign(href);
    else window.open(href, "_blank", "noopener,noreferrer");
  };

  /** Enter in the field: an address links (or, over a link, rewrites it, and
   *  emptied removes it); words pick the first page. Text that is neither
   *  leaves the field open. */
  const submitLinkField = () => {
    const typed = linkQuery.trim();
    if (linkEdit) {
      if (!typed) {
        removeEditedLink();
        return;
      }
      const href = hrefForWords(typed, origin);
      if (href) applyWebLink(href);
      return;
    }
    if (typedHref) {
      applyWebLink(typedHref);
      return;
    }
    if (linkResults[0]) insertPageLink(linkResults[0]);
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {pos && (
        <motion.div
          initial={pos.mobile ? { opacity: 0, y: 8 } : { opacity: 0, y: 4, scale: 0.98 }}
          animate={pos.mobile ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos.mobile ? 8 : 2, transition: { duration: 0.08 } }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
          ref={barRef}
          role="toolbar"
          aria-label="Text formatting"
          style={
            pos.mobile
              ? { position: "fixed", left: 0, right: 0, bottom: kbInset }
              : { position: "fixed", top: pos.top, left: pos.left }
          }
          className={
            pos.mobile
              ? "fixed z-[calc(var(--z-drawer)_-_10)] border-t border-line bg-paper py-1 pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.25)] [padding-bottom:max(0.25rem,env(safe-area-inset-bottom))]"
              : "fixed z-[calc(var(--z-drawer)_-_10)] max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-md border border-line bg-paper p-1 shadow-[var(--shadow-overlay)]"
          }
        >
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {aiLoading ? `AI ${aiLoading} in progress` : ""}
          </span>
          {colorOpen ? (
            <div className="w-[236px] p-1">
              <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-ink-3">
                Text
              </p>
              <div className="flex flex-wrap gap-1 px-1">
                {COLORS.map((c) => (
                  <button
                    key={`t-${c}`}
                    aria-label={`Text ${c}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      run(setTextColorCommand.key, c);
                      setColorOpen(false);
                    }}
                    style={{ color: `var(--tc-${c})` }}
                    className="brain-touch-min grid size-5 place-items-center rounded-sm border border-line text-[11px] font-semibold transition-colors hover:bg-fill-hover"
                  >
                    A
                  </button>
                ))}
              </div>
              <p className="px-1 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.06em] text-ink-3">
                Highlight
              </p>
              <div className="flex flex-wrap gap-1 px-1">
                {COLORS.map((c) => (
                  <button
                    key={`b-${c}`}
                    aria-label={`Highlight ${c}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      run(setHighlightCommand.key, c);
                      setColorOpen(false);
                    }}
                    style={{ background: `var(--tb-${c})` }}
                    className="brain-touch-min size-5 rounded-sm border border-line shadow-[inset_0_0_0_1px_rgb(0_0_0/0.07)] transition-transform hover:scale-110 dark:shadow-none"
                  />
                ))}
              </div>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run(setTextColorCommand.key, null);
                  run(setHighlightCommand.key, null);
                  setColorOpen(false);
                }}
                className="mt-2 w-full rounded-sm px-2 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
              >
                Clear colour
              </button>
            </div>
          ) : linkOpen ? (
            // Docked above the keyboard the field takes the bar's whole width.
            <div className={pos.mobile ? "w-full" : "w-[260px]"}>
              <input
                autoFocus
                aria-label="Link"
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={linkQuery}
                onChange={(e) => setLinkQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeLinkAndRestoreSelection();
                  }
                  if (e.key === "Enter") {
                    // Taken here: the editor has the focus back by the time
                    // the key's default runs, and it would split the line
                    // where the linked words are.
                    e.preventDefault();
                    submitLinkField();
                  }
                }}
                placeholder={linkEdit ? "Link address" : "Paste a link or search pages"}
                className="h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3 max-md:text-[16px]"
              />
              <div className="mt-1 max-h-44 overflow-y-auto">
                {linkEdit ? (
                  <>
                    <Row label="Open link" onRun={openEditedLink}>
                      <Icon name="arrow-right-linear" size={14} className="text-ink-3" />
                      Open link
                    </Row>
                    <Row label="Remove link" onRun={removeEditedLink}>
                      <Icon name="close-linear" size={14} className="text-ink-3" />
                      Remove link
                    </Row>
                  </>
                ) : (
                  <>
                    {typedHref && (
                      <Row label={`Link to ${typedHrefLabel}`} onRun={() => applyWebLink(typedHref)}>
                        <Icon name="link-linear" size={14} className="text-ink-3" />
                        <span className="truncate">Link to {typedHrefLabel}</span>
                      </Row>
                    )}
                    {linkResults.map((pg) => (
                      <Row key={pg.id} label={pg.title} onRun={() => insertPageLink(pg)}>
                        <span className="text-[14px]">{pg.icon ?? DEFAULT_PAGE_ICON}</span>
                        <span className="truncate">{pg.title}</span>
                      </Row>
                    ))}
                    {!typedHref && linkResults.length === 0 && (
                      <p className="px-2 py-3 text-center text-[12px] text-ink-3">No pages</p>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : aiOpen ? (
            <div className="w-[172px] p-1">
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={closeAiAndRestoreSelection}
                className="mb-1 flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
              >
                <Icon name="arrow-left-linear" size={14} />
                Back
              </button>
              <span role="separator" className="mb-1 block h-px bg-line" />
              {AI_ACTIONS.map((action) => (
                <button
                  key={action.mode}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void runAiOnSelection(action.mode)}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
                >
                  <Icon name="magic-stick-3-linear" size={14} className="text-ink-3" />
                  {action.label}
                </button>
              ))}
            </div>
          ) : (
            <div
              className={`brain-hscroll flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                pos?.mobile
                  ? "pr-5 [mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)]"
                  : ""
              }`}
            >
              {ai && (
                <>
                  <TB
                    label={aiLoading ? "AI writing" : "AI"}
                    active={aiOpen || !!aiLoading}
                    disabled={!!aiLoading}
                    onRun={() => {
                      setLinkOpen(false);
                      setColorOpen(false);
                      setAiOpen(true);
                    }}
                  >
                    <Icon
                      name="magic-stick-3-linear"
                      size={15}
                      className={aiLoading ? "animate-pulse" : undefined}
                    />
                  </TB>
                  <Sep />
                </>
              )}
              <TB label="Bold" onRun={() => run(toggleStrongCommand.key)}>
                <Icon name="text-bold-linear" size={15} />
              </TB>
              <TB label="Italic" onRun={() => run(toggleEmphasisCommand.key)}>
                <Icon name="text-italic-linear" size={15} />
              </TB>
              <TB label="Strikethrough" onRun={() => run(toggleStrikethroughCommand.key)}>
                <Icon name="text-cross-linear" size={15} />
              </TB>
              <TB label="Code" onRun={() => run(toggleInlineCodeCommand.key)}>
                <Icon name="code-linear" size={15} />
              </TB>
              <Sep />
              {!inTable && (
                <>
                  <TB label="Heading 1" onRun={() => run(wrapInHeadingCommand.key, 1)}>
                    <Tt>H1</Tt>
                  </TB>
                  <TB label="Heading 2" onRun={() => run(wrapInHeadingCommand.key, 2)}>
                    <Tt>H2</Tt>
                  </TB>
                  <TB label="Heading 3" onRun={() => run(wrapInHeadingCommand.key, 3)}>
                    <Tt>H3</Tt>
                  </TB>
                  <TB label="Text" onRun={() => run(turnIntoTextCommand.key)}>
                    <Tt>¶</Tt>
                  </TB>
                  <Sep />
                  <TB label="Bullet list" onRun={() => run(wrapInBulletListCommand.key)}>
                    <Icon name="list-linear" size={15} />
                  </TB>
                  <TB label="Numbered list" onRun={() => run(wrapInOrderedListCommand.key)}>
                    <Tt>1.</Tt>
                  </TB>
                  {tasks && (
                    <TB
                      label="Task"
                      // Two controls are named Task, and both are right: this
                      // one turns the line the caret is in into a checkbox, the
                      // slash menu's inserts one. The tooltip says which, and
                      // says why instead when a quote refuses the line.
                      title={inQuote ? "A task cannot live inside a quote" : "Task line"}
                      active={taskActive}
                      disabled={inQuote}
                      pressed={taskActive}
                      onRun={() => run(toggleTaskCommand.key)}
                    >
                      <Icon name="checklist-linear" size={15} />
                    </TB>
                  )}
                  <TB label="Quote" onRun={() => run(wrapInBlockquoteCommand.key)}>
                    <Tt>“</Tt>
                  </TB>
                  <Sep />
                  <TB label="Table" onRun={insertTable}>
                    <Icon name="widget-2-linear" size={15} />
                  </TB>
                </>
              )}
              <TB label="Link" onRun={() => openLinkField(webLinkAroundSelection())}>
                <Icon name="link-linear" size={15} />
              </TB>
              <TB
                label="Colour"
                onRun={() => {
                  setAiOpen(false);
                  setLinkOpen(false);
                  setColorOpen(true);
                }}
              >
                <Icon name="palette-linear" size={15} />
              </TB>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function TB({
  label,
  onRun,
  children,
  active = false,
  disabled = false,
  pressed,
  title,
}: {
  label: string;
  onRun: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** The tooltip, when it should read more plainly than the accessible name.
   *  Omitted, the two say the same thing. */
  title?: string;
  /** Renders `aria-pressed`, for a control that is a real toggle of document
   *  state (unlike `active`, which only decides the highlight). Omitted, a
   *  button stays out of the toggle role entirely. */
  pressed?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled}
      title={title ?? label}
      // preventDefault on mousedown keeps the text selection alive
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!disabled) onRun();
      }}
      className={`grid h-7 min-w-7 place-items-center rounded-xs px-1 transition-colors hover:bg-fill-hover hover:text-ink [@media(hover:none)]:h-9 [@media(hover:none)]:min-w-9 ${
        active ? "bg-fill-active text-ink" : "text-ink-2"
      } ${disabled ? "cursor-default opacity-70" : ""}`}
    >
      {children}
    </button>
  );
}

/** A row under the link field: a page to link to, the address typed, or an
 *  action on the link the field opened over. */
function Row({
  label,
  onRun,
  children,
}: {
  label: string;
  onRun: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      // preventDefault on mousedown keeps the text selection alive
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

function Tt({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] font-semibold">{children}</span>;
}

function Sep() {
  return <span role="separator" className="mx-0.5 h-4 w-px bg-line" />;
}
