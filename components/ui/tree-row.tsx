"use client";

import { motion, useReducedMotion } from "framer-motion";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { SPRING_SELECT } from "@/lib/motion";
import { Icon } from "./icon";

/** Tree row on glass — 28px capsule r14 (DESIGN.md v2 → Hover, Motion).
 *
 *  Presentational: `tree/sortable-tree.tsx` adopts it in the shell train and
 *  keeps owning dnd-kit, the context menu and every handler — this component
 *  renders one row from props and spreads the rest onto the root `div` (role,
 *  tabIndex, listeners, ref).
 *
 *  States (classes in globals.css): rest transparent; hover the ink tint + the
 *  "…" slot revealed; selected a white .78 capsule, 600, that flows between
 *  rows on SPRING_SELECT through a shared `layoutId` (framer, because it
 *  physically moves; a plain fill under reduced motion); `dragging` lifts on
 *  --lift.
 *
 *  A drag proposes exactly one of two things and the row says which: `dropInto`
 *  rings the whole row in yellow — the page is going inside this one — while
 *  `dropEdge` draws the yellow insertion line on that edge of the row, at
 *  `dropDepth`, meaning the page lands beside it. Never both. */
export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(function TreeRow(
  {
    title,
    emoji,
    icon = "hashtag",
    depth = 0,
    selected = false,
    hasChildren = false,
    expanded = false,
    onToggle,
    menu,
    dragging,
    dropInto,
    dropEdge,
    dropDepth = 0,
    hover,
    layoutId = "tree-selected",
    className = "",
    style,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  return (
    <div
      ref={ref}
      className={`tree-row focus-inset ${className}`}
      data-selected={selected ? "" : undefined}
      data-hover={hover ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-drop-into={dropInto ? "" : undefined}
      data-drop-edge={dropEdge || undefined}
      aria-current={selected ? "page" : undefined}
      style={{ ...style, paddingLeft: 10 + depth * 20 }}
      {...rest}
    >
      {dropEdge && <TreeInsertion depth={dropDepth} edge={dropEdge} />}
      {selected && (
        <motion.span
          aria-hidden
          className="tree-row-capsule"
          layoutId={reduce ? undefined : layoutId}
          transition={SPRING_SELECT}
        />
      )}
      {onToggle && (
        <button
          type="button"
          className="tree-row-toggle focus-inset"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={hasChildren ? expanded : undefined}
          data-leaf={hasChildren ? undefined : ""}
          tabIndex={hasChildren ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="alt-arrow-right" size={13} />
        </button>
      )}
      <span className="tree-row-glyph" aria-hidden>
        {emoji ?? <Icon name={icon} size={16} variant={selected ? "bold" : "linear"} />}
      </span>
      <span className="tree-row-title">{title}</span>
      {menu && <span className="tree-row-more">{menu}</span>}
    </div>
  );
});

export type TreeRowProps = Omit<HTMLAttributes<HTMLDivElement>, "title" | "className"> & {
  title: ReactNode;
  /** Page emoji; without one the Solar `icon` renders (bold when selected). */
  emoji?: string;
  icon?: string;
  depth?: number;
  selected?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  /** Renders the disclosure toggle (hidden but space-keeping on leaves). */
  onToggle?: () => void;
  /** The "…" slot: a menu trigger (IconButton 28) — revealed on hover/focus. */
  menu?: ReactNode;
  dragging?: boolean;
  /** The page is going inside this row. */
  dropInto?: boolean;
  /** The page is landing beside this row, on this edge. */
  dropEdge?: "before" | "after" | null;
  /** The indent the insertion line is drawn at, so it says which parent it
   *  means where two rows of different depth share a boundary. */
  dropDepth?: number;
  /** Static hover for the stand and screenshots. */
  hover?: boolean;
  /** Shared between the rows of one tree so the capsule flows between them. */
  layoutId?: string;
  className?: string;
};

/** The yellow insertion indicator: a 2px line with a dot, at the depth the
 *  drop would land. Transient — gone with the gesture. With `edge` it pins
 *  itself to that edge of the row it sits in, which is how the line follows
 *  the pointer without the list underneath having to move. */
export function TreeInsertion({
  depth = 0,
  edge,
}: {
  depth?: number;
  edge?: "before" | "after";
}) {
  return (
    <div
      aria-hidden
      className={edge ? "tree-insert tree-insert_edge" : "tree-insert"}
      data-edge={edge}
      style={{ marginLeft: 10 + depth * 20 }}
    />
  );
}
