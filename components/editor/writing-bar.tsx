"use client";

import { useInstance } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";
import { callCommand } from "@milkdown/kit/utils";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { redo, redoDepth, undo, undoDepth } from "@milkdown/kit/prose/history";
import type { Command, EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { DUR, EASE_OUT } from "@/lib/motion";
import { EDITOR_DOC_CHANGED_EVENT, notifyEditorDocChanged } from "@/lib/editor-events";
import { indentCode, outdentCode } from "./editing-core";
import { DOCK_CLASS, DOCK_SAFE_BOTTOM, Sep, TB, Tt } from "./floating-toolbar";
import { setScrollBandInset } from "./scroll-band";
import { selectionIsInQuote, selectionIsTask, toggleTaskCommand } from "./task-checkbox";
import { useTouchDock } from "./touch-dock";

/** Tab and Shift-Tab, which a phone keyboard has not got: the code block's
 *  own indent inside one, the list's nest and lift anywhere else. A dry run
 *  (no dispatch) says whether the line takes the press, which is what the
 *  button's disabled state reads. */
function indentFor(state: EditorState): Command {
  if (state.selection.$from.parent.type.spec.code) return indentCode;
  const item = state.schema.nodes.list_item;
  return item ? sinkListItem(item) : () => false;
}

function outdentFor(state: EditorState): Command {
  if (state.selection.$from.parent.type.spec.code) return outdentCode;
  const item = state.schema.nodes.list_item;
  return item ? liftListItem(item) : () => false;
}

interface BarState {
  canIndent: boolean;
  canOutdent: boolean;
  taskActive: boolean;
  inQuote: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** The writing bar: on a touch screen, while the caret is in the page, the
 *  keys the phone keyboard has not got, docked above it the way the selection
 *  toolbar docks there. It needs no selection. Outdent, Indent, Task, Undo,
 *  Redo, Slash, and Dismiss keyboard at the right edge where iOS keeps its
 *  own. It stays while words are selected: the selection toolbar then docks
 *  on top of it, through the `dockOffset` the editor passes down from the
 *  height this bar reports. It leaves with the focus. */
export function WritingBar({
  container,
  tasks = true,
  onHeight,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  /** The Tasks module. Off and the Task button is absent, because the
   *  command it runs is not registered with the editor at all. */
  tasks?: boolean;
  /** The bar's height while it stands, 0 when it does not: what the
   *  selection toolbar and the caret menus keep clear of. */
  onHeight: (height: number) => void;
}) {
  const [, getEditor] = useInstance();
  const { isTouch, kbInset } = useTouchDock();
  const [state, setState] = useState<BarState | null>(null);
  const [height, setHeight] = useState(0);
  const raf = useRef<number>(0);
  const barRef = useRef<HTMLDivElement | null>(null);

  const withView = useCallback(
    <T,>(read: (view: EditorView) => T): T | undefined => {
      let out: T | undefined;
      getEditor()?.action((ctx) => {
        out = read(ctx.get(editorViewCtx));
      });
      return out;
    },
    [getEditor],
  );

  const update = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      if (!isTouch || !container.current) {
        setState(null);
        return;
      }
      // The focus may be in a field one of the docked bars opened (the
      // selection toolbar's link field): the keyboard is still up, so the
      // bar stays rather than dropping the toolbar by its own height.
      const inDock = Boolean(document.activeElement?.closest("[data-editor-dock]"));
      const next = withView((view) => {
        if (!view.editable || !(view.hasFocus() || inDock)) return null;
        const { state: s } = view;
        return {
          canIndent: indentFor(s)(s),
          canOutdent: outdentFor(s)(s),
          taskActive: selectionIsTask(s),
          inQuote: selectionIsInQuote(s),
          canUndo: undoDepth(s) > 0,
          canRedo: redoDepth(s) > 0,
        };
      });
      setState(next ?? null);
    });
  }, [container, isTouch, withView]);

  useEffect(() => {
    update();
    document.addEventListener("selectionchange", update);
    window.addEventListener(EDITOR_DOC_CHANGED_EVENT, update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener(EDITOR_DOC_CHANGED_EVENT, update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      cancelAnimationFrame(raf.current);
    };
  }, [update]);

  const shown = state !== null;

  // Measured after paint, so the selection toolbar stacks on the real edge
  // and not on an estimate. 0 the moment the bar leaves.
  useLayoutEffect(() => {
    const next = shown ? (barRef.current?.getBoundingClientRect().height ?? 0) : 0;
    setHeight(next);
    onHeight(next);
  }, [shown, kbInset, onHeight]);

  // The bar owns the keyboard inset on this surface, so it owns the scroll
  // band too: while it stands the caret is kept above the keyboard and the
  // bar. The page's last lines can only come up if there is page below them
  // to scroll into, so the editor's root takes the same inset as padding
  // while the bar is up: the scroller is the shell's and keeps its height
  // under the keyboard.
  useEffect(() => {
    const inset = shown ? kbInset + height : 0;
    const root = container.current;
    if (root) root.style.paddingBottom = inset ? `${inset}px` : "";
    setScrollBandInset(inset);
    // A caret already under the keyboard comes up at once. Only when the
    // keyboard is there: the keyboard arrives after the tap and before the
    // first key, where a state update cannot land on a keystroke.
    if (shown && kbInset > 0) {
      withView((view) => view.dispatch(view.state.tr.scrollIntoView()));
    }
  }, [shown, kbInset, height, withView, container]);

  // A press moves the caret without the browser's `selectionchange`: WebKit
  // fires none for a selection the editor sets itself, so the caret menus
  // (slash, wiki-link) hear about the line the way they hear about a Task
  // press, through the editor's own event.
  const run = (command: (state: EditorState) => Command) => {
    withView((view) => {
      command(view.state)(view.state, view.dispatch, view);
      view.focus();
    });
    notifyEditorDocChanged();
    update();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.08 } }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
          ref={barRef}
          role="toolbar"
          aria-label="Writing"
          data-editor-dock=""
          style={{ position: "fixed", left: 0, right: 0, bottom: kbInset }}
          className={`${DOCK_CLASS} ${DOCK_SAFE_BOTTOM}`}
        >
          <div className="flex items-center gap-0.5">
            <TB label="Outdent" disabled={!state.canOutdent} onRun={() => run(outdentFor)}>
              <Icon name="double-alt-arrow-left-linear" size={15} />
            </TB>
            <TB label="Indent" disabled={!state.canIndent} onRun={() => run(indentFor)}>
              <Icon name="double-alt-arrow-right-linear" size={15} />
            </TB>
            {tasks && (
              <>
                <Sep />
                <TB
                  label="Task"
                  title={state.inQuote ? "A task cannot live inside a quote" : "Task line"}
                  active={state.taskActive}
                  disabled={state.inQuote}
                  pressed={state.taskActive}
                  onRun={() => {
                    getEditor()?.action(callCommand(toggleTaskCommand.key));
                    update();
                  }}
                >
                  <Icon name="checklist-linear" size={15} />
                </TB>
              </>
            )}
            <Sep />
            <TB label="Undo" disabled={!state.canUndo} onRun={() => run(() => undo)}>
              <Icon name="undo-left-round-linear" size={15} />
            </TB>
            <TB label="Redo" disabled={!state.canRedo} onRun={() => run(() => redo)}>
              <Icon name="undo-right-round-linear" size={15} />
            </TB>
            <Sep />
            <TB
              label="Slash"
              // On an empty line this opens the slash menu; on a line with
              // words it types the character the phone keyboard keeps
              // behind a mode switch. No block semantics of its own.
              title="Insert a block"
              onRun={() =>
                run(
                  () => (s, dispatch) => {
                    dispatch?.(s.tr.insertText("/").scrollIntoView());
                    return true;
                  },
                )
              }
            >
              <Tt>/</Tt>
            </TB>
            <span className="ml-auto" />
            <TB
              label="Dismiss keyboard"
              onRun={() => {
                withView((view) => view.dom.blur());
                update();
              }}
            >
              <Icon name="keyboard-linear" size={15} />
            </TB>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
