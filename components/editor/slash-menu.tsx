"use client";

import { apiFetch } from "@/lib/client";
import { useInstance } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";
import { callCommand, insert } from "@milkdown/kit/utils";
import {
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  turnIntoTextCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand } from "@milkdown/kit/preset/gfm";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { DUR, EASE_OUT } from "@/lib/motion";
import { insertCalloutCommand } from "./callout";
import { notifyNestedTableBlocked } from "@/lib/editor-events";
import { insertToggleCommand } from "./toggle";
import { insertMathBlockCommand } from "./math";
import { attachmentMarkdown, uploadAttachment } from "./attachments";
import type { PageRef } from "./floating-toolbar";
import { clampMenuLeft, shouldFlipAbove } from "./menu-position";

interface Item {
  label: string;
  icon: string;
  /** a text glyph (H1/H2/H3) shown instead of the icon — three identical
   *  heading icons in a row are unscannable */
  glyph?: string;
  keywords: string;
  // the command PLUGIN — its `.key` is only assigned once the editor initializes
  // the plugin, so read `command.key` at CLICK time, never at module load
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command?: any;
  payload?: unknown;
  markdown?: string;
  aiMode?: "continue";
  fileAttachment?: boolean;
  /** file picker limited to images; inserts an inline image, not a file chip.
   *  The one upload path that works on iPhone (no drag-drop, flaky paste). */
  imageUpload?: boolean;
  /** Creates a child page and replaces the slash trigger with its page-ref. */
  newPage?: boolean;
}

const COLUMNS_MARKDOWN = [
  "::::cols",
  ":::col",
  "",
  ":::",
  "",
  ":::col",
  "",
  ":::",
  "::::",
].join("\n");

const ITEMS: Item[] = [
  {
    label: "New page",
    icon: "add-linear",
    keywords: "new page create child",
    newPage: true,
  },
  { label: "Text", icon: "text-linear", keywords: "text paragraph", command: turnIntoTextCommand },
  {
    label: "Continue writing",
    icon: "magic-stick-3-linear",
    keywords: "ai continue writing ask",
    aiMode: "continue",
  },
  { label: "Heading 1", icon: "text-bold-linear", glyph: "H1", keywords: "h1 heading title", command: wrapInHeadingCommand, payload: 1 },
  { label: "Heading 2", icon: "text-bold-linear", glyph: "H2", keywords: "h2 heading", command: wrapInHeadingCommand, payload: 2 },
  { label: "Heading 3", icon: "text-bold-linear", glyph: "H3", keywords: "h3 heading", command: wrapInHeadingCommand, payload: 3 },
  { label: "Bullet list", icon: "list-linear", keywords: "bullet list unordered", command: wrapInBulletListCommand },
  { label: "Numbered list", icon: "list-arrow-down-linear", keywords: "numbered ordered list", command: wrapInOrderedListCommand },
  { label: "Quote", icon: "text-field-linear", keywords: "quote blockquote", command: wrapInBlockquoteCommand },
  { label: "Callout", icon: "sticker-smile-circle-2-linear", keywords: "callout note tip info", command: insertCalloutCommand },
  { label: "Toggle", icon: "alt-arrow-right-linear", keywords: "toggle collapsible details disclosure", command: insertToggleCommand },
  { label: "Math block", icon: "calculator-minimalistic-linear", keywords: "math latex equation formula", command: insertMathBlockCommand },
  { label: "Code", icon: "code-square-linear", keywords: "code block", command: createCodeBlockCommand },
  { label: "Image", icon: "gallery-add-linear", keywords: "image photo picture upload фото картинка", imageUpload: true },
  { label: "File", icon: "document-text-linear", keywords: "file attachment upload pdf doc zip", fileAttachment: true },
  { label: "Columns", icon: "widget-2-linear", keywords: "columns column two layout grid", markdown: COLUMNS_MARKDOWN },
  { label: "Table", icon: "widget-4-linear", keywords: "table grid", command: insertTableCommand, payload: { row: 3, col: 3 } },
  { label: "Divider", icon: "text-cross-linear", keywords: "divider hr line rule", command: insertHrCommand },
];

async function askAi(mode: "continue", text: string): Promise<string> {
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

interface State {
  top?: number; // when placed below the caret
  bottom?: number; // when flipped above the caret (caret near the viewport bottom)
  left: number;
  query: string;
  from: number; // doc pos of the "/" so we can delete it
  inTable: boolean;
}

/** menu max height (max-h-[280px]) + breathing room */
const MENU_W = 220;
const MENU_H = 300;

/** Notion-style "/" menu: type / at the start of an empty line to insert a block. */
export function SlashMenu({
  container,
  onCreatePageAtCursor,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  onCreatePageAtCursor?: (
    insertPageRef: (page: PageRef) => boolean,
  ) => Promise<void>;
}) {
  const [, getEditor] = useInstance();
  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState(0);
  const raf = useRef<number>(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // whether the open picker should insert an inline image vs a file chip
  const imagePick = useRef(false);
  const creatingPage = useRef(false);
  const reduce = useReducedMotion();

  const update = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const root = container.current;
      const sel = window.getSelection();
      if (!root || !sel || !sel.isCollapsed || sel.rangeCount === 0) {
        setState(null);
        return;
      }
      const node = sel.anchorNode as HTMLElement | null;
      const block = node
        ? (node.nodeType === 1 ? node : node.parentElement)?.closest("p")
        : null;
      // only a paragraph whose whole text is "/word" triggers the menu
      const text = block?.textContent ?? "";
      const m = /^\/(\w*)$/.exec(text);
      if (!block || !root.contains(block) || !m) {
        setState(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const ed = getEditor();
      let from = -1;
      let inTable = false;
      ed?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        from = view.state.selection.$from.start();
        const $from = view.state.selection.$from;
        for (let depth = $from.depth; depth >= 0; depth -= 1) {
          const name = $from.node(depth).type.name;
          if (name === "table" || name === "table_cell" || name === "table_header") {
            inTable = true;
            break;
          }
        }
      });
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const flip = shouldFlipAbove(rect, vh, MENU_H);
      setState({
        left: clampMenuLeft(rect.left - r.left, r.width, MENU_W),
        query: m[1],
        from,
        inTable,
        ...(flip
          ? { bottom: r.bottom - rect.top + 6 }
          : { top: rect.bottom - r.top + 6 }),
      });
      setActive(0);
    });
  }, [container, getEditor]);

  useEffect(() => {
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      cancelAnimationFrame(raf.current);
    };
  }, [update]);

  const results = useMemo(
    () =>
      state
        ? ITEMS.filter(
            (i) =>
              (!state.inTable || i.command !== insertTableCommand) &&
              (state.query
                ? i.keywords.includes(state.query.toLowerCase()) ||
                  i.label.toLowerCase().includes(state.query.toLowerCase())
                : true),
          )
        : [],
    [state],
  );

  const run = useCallback(
    (item: Item) => {
      const ed = getEditor();
      if (!ed) return;
      if (item.newPage) {
        if (!onCreatePageAtCursor || creatingPage.current) return;

        const capture = ed.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state: editorState } = view;
          const from = editorState.selection.$from.start();
          const to = editorState.selection.$from.end();
          return {
            view,
            from,
            to,
            valid:
              editorState.selection.empty &&
              editorState.selection.$from.parent.type.name === "paragraph",
            triggerText: editorState.doc.textBetween(from, to, "", "\n"),
          };
        });
        const { view, from, to, valid, triggerText } = capture;
        if (from < 0 || to <= from || !valid || !/^\/\w*$/.test(triggerText)) {
          return;
        }

        creatingPage.current = true;
        setState(null);
        view.setProps({ editable: () => false });
        view.dom.setAttribute("aria-busy", "true");

        const unlock = () => {
          try {
            view.setProps({ editable: () => true });
            view.dom.removeAttribute("aria-busy");
          } catch {
            // The successful path navigates and destroys this editor first.
          }
        };

        void onCreatePageAtCursor((page) => {
          let inserted = false;
          try {
            ed.action((ctx) => {
              const liveView = ctx.get(editorViewCtx);
              if (liveView !== view) return;
              const { state: editorState } = liveView;
              const safeTo = Math.min(to, editorState.doc.content.size);
              const pageRefType = editorState.schema.nodes.page_ref;
              if (
                !pageRefType ||
                safeTo < from ||
                editorState.doc.textBetween(from, safeTo, "", "\n") !==
                  triggerText
              ) {
                return;
              }
              const label = `${page.icon ? `${page.icon} ` : ""}${page.title}`;
              const pageRef = pageRefType.create({ id: page.id, label });
              liveView.dispatch(
                editorState.tr.replaceWith(from, safeTo, pageRef).scrollIntoView(),
              );
              inserted = true;
            });
          } catch {
            // Shell keeps the created child visible in the tree if this editor
            // disappeared before the request completed.
          }
          return inserted;
        })
          .catch(() => {
            // Shell owns the mutation; never leave an unhandled rejection or
            // a permanently locked editor here if its orchestration aborts.
          })
          .finally(() => {
            creatingPage.current = false;
            unlock();
          });
        return;
      }
      if (item.fileAttachment || item.imageUpload) {
        ed.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state: s } = view;
          const from = s.selection.$from.start();
          const to = s.selection.$from.pos;
          if (to > from) view.dispatch(s.tr.delete(from, to));
          view.focus();
        });
        setState(null);
        imagePick.current = !!item.imageUpload;
        if (fileInput.current) {
          // accept=image/* opens the photo library directly on iOS
          if (item.imageUpload) fileInput.current.setAttribute("accept", "image/*");
          else fileInput.current.removeAttribute("accept");
          fileInput.current.click();
        }
        return;
      }
      if (item.aiMode === "continue") {
        setState(null);
        void (async () => {
          let from = -1;
          let to = -1;
          let triggerText = "";
          let context = "";

          ed.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state: s } = view;
            from = s.selection.$from.start();
            to = s.selection.$from.pos;
            triggerText = s.doc.textBetween(from, to, "", "\n");
            context = s.doc.textBetween(0, from, "\n\n", "\n").trim().slice(-1500);
          });

          const result = await askAi("continue", context);
          if (!result) return;

          let readyToInsert = false;
          ed.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state: s } = view;
            const safeTo = Math.min(to, s.doc.content.size);
            if (from < 0 || safeTo < from) return;
            if (!s.selection.empty || s.selection.from !== to) return;
            if (s.doc.textBetween(from, safeTo, "", "\n") !== triggerText) return;
            view.dispatch(s.tr.delete(from, safeTo).scrollIntoView());
            view.focus();
            readyToInsert = true;
          });
          if (!readyToInsert) return;
          ed.action(insert(result));
          setState(null);
        })();
        return;
      }
      if (item.markdown) {
        ed.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state: s } = view;
          const from = s.selection.$from.start();
          const to = s.selection.$from.pos;
          if (to > from) view.dispatch(s.tr.delete(from, to));
          view.focus();
        });
        ed.action(insert(item.markdown));
        setState(null);
        return;
      }
      if (!item.command) return;
      // The menu is filtered while open, and the live-state guard below keeps
      // a stale menu from creating an unsupported nested table after a move.
      if (item.command === insertTableCommand) {
        let inTable = false;
        ed.action((ctx) => {
          const $from = ctx.get(editorViewCtx).state.selection.$from;
          for (let depth = $from.depth; depth >= 0; depth -= 1) {
            const name = $from.node(depth).type.name;
            if (name === "table" || name === "table_cell" || name === "table_header") {
              inTable = true;
              break;
            }
          }
        });
        if (inTable) {
          notifyNestedTableBlocked();
          setState(null);
          return;
        }
      }
      // delete the "/query" (positions from the LIVE view state), then run the
      // block command — reading `command.key` NOW that the editor is initialized
      ed.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state: s } = view;
        const from = s.selection.$from.start();
        const to = s.selection.$from.pos;
        if (to > from) view.dispatch(s.tr.delete(from, to));
        view.focus();
      });
      ed.action(callCommand(item.command.key, item.payload));
      setState(null);
    },
    [getEditor, onCreatePageAtCursor],
  );

  const pickFile = useCallback(
    (file?: File) => {
      if (!file) return;
      const asImage = imagePick.current && file.type.startsWith("image/");
      void uploadAttachment(file).then((uploaded) => {
        if (!uploaded) return;
        const ed = getEditor();
        ed?.action((ctx) => {
          ctx.get(editorViewCtx).focus();
        });
        ed?.action(insert(asImage ? `![](${uploaded.url})` : attachmentMarkdown(uploaded)));
      });
    },
    [getEditor],
  );

  // keyboard nav
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[active]) run(results[active]);
      } else if (e.key === "Escape") {
        setState(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state, results, active, run]);

  // keep the highlighted row inside the scrollport while arrowing
  useEffect(() => {
    if (!state) return;
    menuRef.current?.children[active]?.scrollIntoView({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [state, active, reduce]);

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(e) => {
          pickFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <AnimatePresence>
        {state && results.length > 0 && (
          <motion.div
            ref={menuRef}
            data-testid="slash-menu"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: DUR.exit } }}
            transition={reduce ? { duration: DUR.base } : { duration: DUR.base, ease: EASE_OUT }}
            style={{ top: state.top, bottom: state.bottom, left: state.left }}
            className="absolute z-[calc(var(--z-drawer)_-_10)] max-h-[280px] w-[220px] overflow-y-auto rounded-lg border border-line bg-paper p-1 shadow-[var(--shadow-overlay)]"
          >
            {results.map((item, i) => (
              <button
                key={item.label}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => run(item)}
                className={`flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] transition-colors ${
                  i === active ? "bg-fill-active text-ink" : "text-ink-2"
                }`}
              >
                {item.glyph ? (
                  <span className="grid size-[15px] shrink-0 place-items-center text-[11px] font-semibold text-ink-3">
                    {item.glyph}
                  </span>
                ) : (
                  <Icon name={item.icon} size={15} className="text-ink-3" />
                )}
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
