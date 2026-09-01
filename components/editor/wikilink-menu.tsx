"use client";

import { useInstance } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";
import { insert } from "@milkdown/kit/utils";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { DUR, EASE_OUT } from "@/lib/motion";
import type { PageRef } from "./floating-toolbar";
import { clampMenuLeft, shouldFlipAbove } from "./menu-position";

interface State {
  top?: number; // when placed below the caret
  bottom?: number; // when flipped above the caret (caret near the viewport bottom)
  left: number;
  query: string;
}

const MENU_W = 260;
const MENU_H = 280;

/** Type `[[` to link a page inline — a Notion/Obsidian wiki-link. Picks from
 *  the page list, inserts a real `[Title](/p/id)` markdown link. */
export function WikiLinkMenu({
  container,
  pages,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  pages: PageRef[];
}) {
  const [, getEditor] = useInstance();
  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState(0);
  const raf = useRef<number>(0);
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
      const node = sel.anchorNode;
      const block = (
        node?.nodeType === 1 ? (node as HTMLElement) : node?.parentElement
      )?.closest("p, h1, h2, h3, li");
      if (!block || !root.contains(block)) {
        setState(null);
        return;
      }
      // text from block start up to the caret
      const range = sel.getRangeAt(0).cloneRange();
      range.setStart(block, 0);
      const before = range.toString();
      // an unclosed [[ with the query after it, no closing ]] and no line break
      const m = /\[\[([^\]\n]*)$/.exec(before);
      if (!m) {
        setState(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const flip = shouldFlipAbove(rect, vh, MENU_H);
      setState({
        left: clampMenuLeft(rect.left - r.left, r.width, MENU_W),
        query: m[1],
        ...(flip
          ? { bottom: r.bottom - rect.top + 6 }
          : { top: rect.bottom - r.top + 6 }),
      });
      setActive(0);
    });
  }, [container]);

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
        ? pages
            .filter((p) =>
              state.query
                ? p.title.toLowerCase().includes(state.query.toLowerCase())
                : true,
            )
            .slice(0, 8)
        : [],
    [pages, state],
  );

  const run = useCallback(
    (pg: PageRef) => {
      const ed = getEditor();
      if (!ed || !state) return;
      const drop = state.query.length + 2; // "[[" + query
      ed.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state: s } = view;
        const to = s.selection.$from.pos;
        const from = Math.max(s.selection.$from.start(), to - drop);
        if (to > from) view.dispatch(s.tr.delete(from, to));
        view.focus();
      });
      ed.action(insert(`[${pg.title}](/p/${pg.id})`));
      setState(null);
    },
    [getEditor, state],
  );

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter" && results[active]) {
        e.preventDefault();
        run(results[active]);
      } else if (e.key === "Escape") {
        setState(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state, results, active, run]);

  return (
    <AnimatePresence>
      {state && results.length > 0 && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={reduce ? { duration: DUR.base } : { duration: DUR.base, ease: EASE_OUT }}
          style={{ top: state.top, bottom: state.bottom, left: state.left }}
          className="absolute z-[calc(var(--z-drawer)_-_10)] max-h-[280px] w-[260px] overflow-y-auto rounded-lg border border-line bg-paper p-1 shadow-[var(--shadow-overlay)]"
        >
          {results.map((pg, i) => (
            <button
              key={pg.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(pg)}
              className={`flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] transition-colors ${
                i === active ? "bg-fill-active text-ink" : "text-ink-2"
              }`}
            >
              <span className="text-[14px] leading-none">{pg.icon ?? DEFAULT_PAGE_ICON}</span>
              <span className="truncate">{pg.title}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
