"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  LayoutGroup,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import type { TreeNode } from "@/lib/store/types";
import { Icon } from "./ui/icon";
import { IconButton } from "./ui/button";
import { DUR, EASE_OUT, SPRING } from "@/lib/motion";

const DEFAULT_COLUMNS = ["Backlog", "In progress", "Done"];
const DRAG_THRESHOLD = 5;
/** distance from the scroller's edge where auto-pan kicks in */
const PAN_ZONE = 48;
const PAN_MAX = 12;

type DragSnapshot = {
  id: string;
  pointerId: number;
  originCol: string;
  originIndex: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

type DragVisual = {
  id: string;
  originCol: string;
  originIndex: number;
  width: number;
  height: number;
};

type DropTarget = {
  col: string;
  index: number;
};

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("button,input,textarea,select,a,[contenteditable='true']")
  );
}

const MENU_PANEL =
  "w-[184px] rounded-lg border border-line bg-paper p-1 shadow-[var(--shadow-overlay)]";
const MENU_ITEM =
  "flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-[13px] text-ink-2 outline-none transition-colors data-[highlighted]:bg-fill-hover";

/** Column "…" menu: rename always, delete only when the column is empty —
 *  a non-empty section is recreated from its cards' statuses, so deleting it
 *  would silently do nothing (the old hover-✕ trust bug). */
function ColumnMenu({
  children,
  canDelete,
  onRename,
  onDelete,
}: {
  children: ReactNode;
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-[var(--z-modal)] outline-none"
        >
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.14, ease: EASE_OUT }}
            style={{ transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)" }}
            className={MENU_PANEL}
          >
            <Dropdown.Item onSelect={onRename} className={MENU_ITEM}>
              <Icon name="pen-new-square-linear" size={15} className="text-ink-3" />
              Rename
            </Dropdown.Item>
            {canDelete ? (
              <Dropdown.Item
                onSelect={onDelete}
                className={`${MENU_ITEM} data-[highlighted]:font-medium data-[highlighted]:text-ink`}
              >
                <Icon name="trash-bin-trash-linear" size={15} className="text-ink-3" />
                Delete
              </Dropdown.Item>
            ) : (
              <div className="flex h-8 items-center gap-2.5 rounded-sm px-2 text-[13px] text-ink-3">
                <Icon name="trash-bin-trash-linear" size={15} className="text-ink-3 opacity-60" />
                <span className="flex-1">Delete</span>
                <span className="text-[12px]">has cards</span>
              </div>
            )}
          </motion.div>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Kanban view over a page's children: columns = statuses (customizable via
 *  the parent's `sections`), cards = child pages. Dragging commits BOTH the
 *  status and the position (fractional order via /api/move). */
export function Board({
  node,
  onSelect,
  onMoveCard,
  onAddCard,
  onAddColumn,
  onRenameColumn,
  onDeleteColumn,
  onSetTags,
}: {
  node: TreeNode;
  onSelect: (id: string) => void;
  onMoveCard: (cardId: string, status: string, beforeId: string | null) => void;
  onAddCard: (status: string, title: string) => void;
  onAddColumn: (name: string) => void;
  onRenameColumn: (from: string, to: string) => void;
  onDeleteColumn: (name: string) => void;
  onSetTags: (cardId: string, tags: string[]) => void;
}) {
  const [drag, setDrag] = useState<DragVisual | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newCol, setNewCol] = useState(false);
  const [tagFor, setTagFor] = useState<string | null>(null);
  const pendingDrag = useRef<DragSnapshot | null>(null);
  const activeDrag = useRef<DragVisual | null>(null);
  const activeDropTarget = useRef<DropTarget | null>(null);
  const cleanupDrag = useRef<(() => void) | null>(null);
  const suppressClick = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  // overlay follows the pointer through motion values — zero re-renders/px
  const mvX = useMotionValue(0);
  const mvY = useMotionValue(0);
  const targetRaf = useRef(0);
  const panVel = useRef(0);
  const panRaf = useRef(0);
  const flightBackstop = useRef(0);
  const reduce = useReducedMotion();

  const listed = node.sections?.length ? node.sections : DEFAULT_COLUMNS;
  const extra = [
    ...new Set(
      node.children.map((c) => c.status).filter((s): s is string => !!s && !listed.includes(s)),
    ),
  ];
  const columns = [...listed, ...extra];
  const cardsIn = (col: string) =>
    node.children.filter((c) => (c.status ?? columns[0]) === col);
  const activeCard = drag ? node.children.find((c) => c.id === drag.id) : null;

  const commitAdd = (col: string, keepOpen: boolean) => {
    const t = draft.trim();
    if (t) onAddCard(col, t);
    setDraft("");
    // Enter keeps the composer open for serial entry; Esc/blur (or an empty
    // Enter) close it
    if (!keepOpen || !t) setAdding(null);
  };
  const addTag = (cardId: string, current: string[], value: string) => {
    const t = value.trim();
    if (t && !current.includes(t)) onSetTags(cardId, [...current, t]);
    setTagFor(null);
  };

  useEffect(
    () => () => {
      cleanupDrag.current?.();
      cancelAnimationFrame(targetRaf.current);
      cancelAnimationFrame(panRaf.current);
    },
    [],
  );

  const setActiveTarget = (target: DropTarget | null) => {
    activeDropTarget.current = target;
    // React state at most once per frame — the raw pointermove is per-pixel
    cancelAnimationFrame(targetRaf.current);
    targetRaf.current = requestAnimationFrame(() => setDropTarget(activeDropTarget.current));
  };

  const findDropTarget = (clientX: number, clientY: number, activeId: string): DropTarget | null => {
    // columns hit-test by X only (Y just has to be inside the board): an EMPTY
    // column is ~80px tall, and a card dragged from mid-screen of a long column
    // would miss its rect entirely — snap-back on the most common triage move
    const board = containerRef.current?.getBoundingClientRect();
    if (board && (clientY < board.top || clientY > board.bottom)) return null;
    const col = columns.find((name) => {
      const rect = columnRefs.current.get(name)?.getBoundingClientRect();
      return rect && clientX >= rect.left && clientX <= rect.right;
    });
    if (!col) return null;

    const availableCards = cardsIn(col).filter((c) => c.id !== activeId);
    const targetIndex = availableCards.findIndex((c) => {
      const rect = cardRefs.current.get(c.id)?.getBoundingClientRect();
      return rect ? clientY < rect.top + rect.height / 2 : false;
    });

    return { col, index: targetIndex === -1 ? availableCards.length : targetIndex };
  };

  const resetDragState = () => {
    pendingDrag.current = null;
    activeDrag.current = null;
    activeDropTarget.current = null;
    cancelAnimationFrame(targetRaf.current);
    cancelAnimationFrame(panRaf.current);
    // a stale flight backstop must never fire into the NEXT drag's state
    window.clearTimeout(flightBackstop.current);
    panVel.current = 0;
    setDrag(null);
    setDropTarget(null);
  };

  const clearSuppressedClickSoon = (id: string) => {
    window.setTimeout(() => {
      if (suppressClick.current === id) suppressClick.current = null;
    }, 0);
  };

  const onCardPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    card: TreeNode,
    col: string,
    index: number,
  ) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || isInteractiveTarget(e.target)) return;

    cleanupDrag.current?.();
    resetDragState();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const snapshot: DragSnapshot = {
      id: card.id,
      pointerId: e.pointerId,
      originCol: col,
      originIndex: index,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };

    pendingDrag.current = snapshot;
    let previousUserSelect: string | null = null;

    // On touch, the board scrolls horizontally — a swipe must pan, not drag.
    // So require a short hold to pick up a card (Notion/Trello behaviour); a
    // mouse relies on the move-distance threshold and captures right away.
    const isTouch = e.pointerType !== "mouse";
    let armed = !isTouch;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const capture = () => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture can fail if the browser already cancelled the pointer
      }
    };
    if (isTouch) {
      holdTimer = setTimeout(() => {
        armed = true;
        capture();
        (navigator as unknown as { vibrate?: (n: number) => void }).vibrate?.(6);
      }, 180);
    } else {
      capture();
    }

    // auto-pan: while the pointer sits near the scroller's edge, keep panning
    const panLoop = () => {
      const c = containerRef.current;
      if (c && panVel.current !== 0) c.scrollLeft += panVel.current;
      panRaf.current = requestAnimationFrame(panLoop);
    };

    const updatePan = (clientX: number) => {
      const c = containerRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const fromLeft = clientX - r.left;
      const fromRight = r.right - clientX;
      panVel.current =
        fromLeft < PAN_ZONE
          ? -Math.ceil(((PAN_ZONE - fromLeft) / PAN_ZONE) * PAN_MAX)
          : fromRight < PAN_ZONE
            ? Math.ceil(((PAN_ZONE - fromRight) / PAN_ZONE) * PAN_MAX)
            : 0;
    };

    const activate = (event: PointerEvent) => {
      if (previousUserSelect === null) {
        previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
      }

      const next: DragVisual = {
        id: snapshot.id,
        originCol: snapshot.originCol,
        originIndex: snapshot.originIndex,
        width: snapshot.width,
        height: snapshot.height,
      };
      mvX.set(event.clientX - snapshot.offsetX);
      mvY.set(event.clientY - snapshot.offsetY);
      activeDrag.current = next;
      suppressClick.current = snapshot.id;
      setDrag(next);
      setActiveTarget(
        findDropTarget(event.clientX, event.clientY, snapshot.id) ?? {
          col: snapshot.originCol,
          index: snapshot.originIndex,
        },
      );
      panRaf.current = requestAnimationFrame(panLoop);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerId !== snapshot.pointerId) return;
      const dx = event.clientX - snapshot.startX;
      const dy = event.clientY - snapshot.startY;

      // touch, not yet armed: a move means the user is scrolling, not dragging —
      // cancel the hold and let the browser pan the board
      if (!armed) {
        if (Math.hypot(dx, dy) > 10) {
          if (holdTimer) clearTimeout(holdTimer);
          cleanupDrag.current?.();
        }
        return;
      }

      if (!activeDrag.current) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        activate(event);
      } else {
        mvX.set(event.clientX - snapshot.offsetX);
        mvY.set(event.clientY - snapshot.offsetY);
        setActiveTarget(findDropTarget(event.clientX, event.clientY, snapshot.id));
        updatePan(event.clientX);
      }

      event.preventDefault();
    };

    const finish = (commit: boolean, event?: PointerEvent) => {
      if (event && event.pointerId !== snapshot.pointerId) return;
      const currentDrag = activeDrag.current;
      const target = activeDropTarget.current;

      cleanupDrag.current?.();
      if (currentDrag && event) event.preventDefault();

      if (commit && currentDrag && target) {
        const colCards = cardsIn(target.col).filter((c) => c.id !== currentDrag.id);
        const beforeId = colCards[target.index]?.id ?? null;
        // fly the overlay into the placeholder slot, THEN release it — the
        // optimistic reorder has already put the real card underneath.
        // BOTH axes must settle: a same-column reorder has dx≈0, so the X
        // spring finishes instantly and its onComplete alone would cut the
        // Y flight short (the card would teleport on the most common gesture)
        const slot = placeholderRef.current?.getBoundingClientRect();
        onMoveCard(currentDrag.id, target.col, beforeId);
        if (slot && !reduce) {
          flightBackstop.current = window.setTimeout(() => resetDragState(), 500);
          Promise.all([animate(mvX, slot.left, SPRING), animate(mvY, slot.top, SPRING)]).then(
            () => resetDragState(),
          );
        } else {
          resetDragState();
        }
      } else {
        resetDragState();
      }
      if (currentDrag) clearSuppressedClickSoon(currentDrag.id);
    };

    const up = (event: PointerEvent) => finish(true, event);
    const cancel = (event: PointerEvent) => finish(false, event);
    // Esc cancels an in-flight drag
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeDrag.current) finish(false);
    };

    cleanupDrag.current = () => {
      if (holdTimer) clearTimeout(holdTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(panRaf.current);
      panVel.current = 0;
      if (previousUserSelect !== null) document.body.style.userSelect = previousUserSelect;
      try {
        if (el.hasPointerCapture(snapshot.pointerId)) el.releasePointerCapture(snapshot.pointerId);
      } catch {
        // The browser may release capture as part of pointer cancellation.
      }
      cleanupDrag.current = null;
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
  };

  const renderCardBody = (card: TreeNode, overlay = false) => {
    const tags = card.tags ?? [];
    const showMetaRow = tags.length > 0 || (!overlay && tagFor === card.id);
    return (
      <>
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 text-[14px] leading-none">
            {card.icon ?? DEFAULT_PAGE_ICON}
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-ink">
            {card.title}
          </span>
          {/* a tagless card stays one line tall — the affordance lives in the
              title row on hover instead of an always-there empty meta row */}
          {!overlay && !showMetaRow && (
            <button
              onClick={() => setTagFor(card.id)}
              aria-label="Add tag"
              className="brain-touch-min -my-0.5 shrink-0 rounded-full px-1 text-[12px] text-ink-3 opacity-0 transition-opacity hover:text-ink-2 group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60"
            >
              + tag
            </button>
          )}
        </div>
        {showMetaRow && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {tags.map((t) =>
              overlay ? (
                <span
                  key={t}
                  className="flex items-center gap-1 rounded-full bg-fill-active px-1.5 py-px text-[12px] text-ink-2"
                >
                  {t}
                </span>
              ) : (
                <button
                  key={t}
                  onClick={() =>
                    onSetTags(
                      card.id,
                      tags.filter((x) => x !== t),
                    )
                  }
                  className="brain-touch-min flex items-center gap-1 rounded-full bg-fill-active px-1.5 py-px text-[12px] text-ink-2 transition-colors hover:text-ink"
                  title="Remove tag"
                >
                  {t}
                </button>
              ),
            )}
            {!overlay &&
              (tagFor === card.id ? (
                <input
                  autoFocus
                  aria-label={`Tag for ${card.title}`}
                  onBlur={(e) => addTag(card.id, tags, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag(card.id, tags, (e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setTagFor(null);
                  }}
                  placeholder="tag"
                  className="w-16 appearance-none rounded-full bg-fill-active px-1.5 py-px text-[12px] leading-normal text-ink outline-none placeholder:text-ink-3 focus:outline-none"
                />
              ) : (
                <button
                  onClick={() => setTagFor(card.id)}
                  aria-label="Add tag"
                  className="brain-touch-min rounded-full px-1 text-[12px] text-ink-3 opacity-0 transition-opacity hover:text-ink-2 group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60"
                >
                  + tag
                </button>
              ))}
          </div>
        )}
      </>
    );
  };

  return (
    <LayoutGroup>
      <div
        ref={containerRef}
        onClickCapture={(e) => {
          if (!suppressClick.current) return;
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = null;
        }}
        className={`-mx-1.5 flex items-start gap-4 overflow-x-auto pb-24 pr-5 md:pr-6 ${
          drag ? "[scroll-snap-type:none]" : "snap-x snap-proximity"
        }`}
      >
        {columns.map((col, i) => {
          const cards = cardsIn(col);
          const visibleCards = drag ? cards.filter((c) => c.id !== drag.id) : cards;
          const placeholderIndex =
            drag && dropTarget?.col === col
              ? Math.min(dropTarget.index, visibleCards.length)
              : null;
          const isDropCol = drag != null && dropTarget?.col === col;

          // the list with the placeholder spliced in as a KEYED row — React
          // moves it (not remount), so framer's layout glides it between cards
          const rows: ReactNode[] = visibleCards.map((c, cardIndex) => (
            <motion.div
              key={c.id}
              layout={reduce ? false : true}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              // layout moves ride the spring; the mount fade gets its own curve
              // with a short cascade (columns stagger 0.04, cards trail behind)
              transition={{
                layout: SPRING,
                default: reduce
                  ? { duration: 0.15 }
                  : {
                      duration: DUR.base,
                      ease: EASE_OUT,
                      delay: 0.04 * i + 0.02 * Math.min(cardIndex, 6),
                    },
              }}
            >
              <div
                ref={(el) => {
                  if (el) cardRefs.current.set(c.id, el);
                  else cardRefs.current.delete(c.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(c.id);
                    return;
                  }
                  // ⌘/Ctrl + arrows move the focused card: ←/→ across columns,
                  // ↑/↓ within the column. Focus follows the card after the move.
                  if (!(e.metaKey || e.ctrlKey) || !e.key.startsWith("Arrow")) return;
                  e.preventDefault();
                  const refocus = () =>
                    requestAnimationFrame(() => cardRefs.current.get(c.id)?.focus());
                  if (e.key === "ArrowLeft" && i > 0) {
                    onMoveCard(c.id, columns[i - 1], null);
                    refocus();
                  } else if (e.key === "ArrowRight" && i < columns.length - 1) {
                    onMoveCard(c.id, columns[i + 1], null);
                    refocus();
                  } else if (e.key === "ArrowUp" && cardIndex > 0) {
                    onMoveCard(c.id, col, cards[cardIndex - 1].id);
                    refocus();
                  } else if (e.key === "ArrowDown" && cardIndex < cards.length - 1) {
                    onMoveCard(c.id, col, cards[cardIndex + 2]?.id ?? null);
                    refocus();
                  }
                }}
                onClick={(e) => {
                  // tag pills / inputs live inside the card — don't navigate
                  if (isInteractiveTarget(e.target)) return;
                  onSelect(c.id);
                }}
                onPointerDown={(e) => onCardPointerDown(e, c, col, cardIndex)}
                className="group/card min-h-[40px] cursor-pointer touch-manipulation rounded-md border border-line bg-surface px-3 py-2.5 transition-colors [@media(hover:hover)]:hover:bg-fill-active active:cursor-grabbing"
              >
                {renderCardBody(c)}
              </div>
            </motion.div>
          ));
          if (placeholderIndex !== null) {
            rows.splice(
              placeholderIndex,
              0,
              <motion.div
                key={`ph-${col}`}
                ref={placeholderRef}
                layout={reduce ? false : true}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ layout: SPRING, default: { duration: DUR.fast } }}
                style={{ height: drag?.height }}
                className="rounded-md bg-fill-active"
                aria-hidden
              />,
            );
          }

          return (
            <motion.div
              key={col}
              ref={(el) => {
                if (el) columnRefs.current.set(col, el);
                else columnRefs.current.delete(col);
              }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={
                reduce ? { duration: 0.15 } : { duration: DUR.base, ease: EASE_OUT, delay: 0.04 * i }
              }
              className={`flex w-[260px] shrink-0 snap-start scroll-ml-5 flex-col rounded-lg p-1.5 transition-colors md:scroll-ml-6 ${
                isDropCol ? "bg-fill-hover" : "bg-transparent"
              }`}
            >
              <header className="group/col mb-2 flex h-7 items-center gap-1.5 px-1.5">
                {renaming === col ? (
                  <input
                    autoFocus
                    aria-label={`Rename column ${col}`}
                    defaultValue={col}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== col) onRenameColumn(col, v);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        (e.target as HTMLInputElement).value = col;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="h-7 w-full appearance-none rounded-sm bg-fill-hover px-1.5 text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => setRenaming(col)}
                      className="text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
                    >
                      {col}
                    </button>
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={cards.length}
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                        transition={{ duration: DUR.fast, ease: EASE_OUT }}
                        className="text-[12px] tabular-nums text-ink-3"
                      >
                        {cards.length}
                      </motion.span>
                    </AnimatePresence>
                    <ColumnMenu
                      canDelete={cards.length === 0}
                      onRename={() => setRenaming(col)}
                      onDelete={() => onDeleteColumn(col)}
                    >
                      <IconButton
                        size="sm"
                        aria-label="Column actions"
                        className="ml-auto opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/col:opacity-100 [@media(hover:hover)]:group-focus-within/col:opacity-100"
                      >
                        <Icon name="menu-dots-bold" size={14} />
                      </IconButton>
                    </ColumnMenu>
                  </>
                )}
              </header>

              {/* composer ABOVE the cards: with a long column, "New" at the
                  bottom meant scrolling past everything. The created card is
                  inserted FIRST in the column (onAddCard moves it before the
                  current head), so it lands where the composer sits. */}
              {adding === col ? (
                <motion.input
                  layout={reduce ? false : true}
                  transition={SPRING}
                  autoFocus
                  aria-label={`New card in ${col}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitAdd(col, false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitAdd(col, true);
                    if (e.key === "Escape") {
                      setDraft("");
                      setAdding(null);
                    }
                  }}
                  placeholder="Card title…"
                  className="mb-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
                />
              ) : (
                <button
                  onClick={() => setAdding(col)}
                  className="brain-touch-hit mb-2 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
                >
                  <Icon name="add-linear" size={14} />
                  New
                </button>
              )}

              <div className="flex min-h-[8px] flex-col gap-2">{rows}</div>
            </motion.div>
          );
        })}

        {/* add a section — quiet, aligned with the header row */}
        {newCol ? (
          <input
            autoFocus
            aria-label="New section name"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) onAddColumn(v);
              setNewCol(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                (e.target as HTMLInputElement).value = "";
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Section name…"
            className="mt-1.5 h-7 w-[200px] shrink-0 appearance-none rounded-md bg-fill-hover px-2 text-[13px] font-medium text-ink outline-none placeholder:text-ink-3 max-md:text-[16px]"
          />
        ) : (
          <button
            onClick={() => setNewCol(true)}
            className="mt-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
          >
            <Icon name="add-linear" size={14} />
            Add section
          </button>
        )}

        {drag && activeCard ? (
          <motion.div
            aria-hidden
            initial={reduce ? {} : { scale: 1, rotate: 0 }}
            animate={reduce ? {} : { scale: 1.03, rotate: 1.5 }}
            transition={SPRING}
            style={{ x: mvX, y: mvY, width: drag.width, left: 0, top: 0 }}
            className="pointer-events-none fixed z-[var(--z-toast)] origin-top-left rounded-md border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow-lift)]"
          >
            {renderCardBody(activeCard, true)}
          </motion.div>
        ) : null}
      </div>
    </LayoutGroup>
  );
}
