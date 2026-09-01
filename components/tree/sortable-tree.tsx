"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragMoveEvent,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/button";
import { TreeRow } from "../ui/tree-row";
import { RowMenu, PageContextMenu } from "./row-menu";
import { AnimatePresence, motion } from "framer-motion";
import { SIDEBAR_SELECT_LAYOUT_ID } from "../shell/sidebar-select";
import { DUR, EASE_OUT } from "@/lib/motion";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "@/lib/store/types";
import { resolveDropZone, type DropZone } from "@/lib/drop-zone";
import { resolveTreeDrop, type TreeDrop } from "./drop-intent";
import {
  acceptExternalPageRefNesting,
  BRAIN_PAGE_REF_DRAG_MIME,
  decodePageRefDragPayload,
  getActivePageRefDragSource,
  pageRefDragSourcesMatch,
  type ReparentPageRef,
  validatePageRefNestingTarget,
} from "../editor/page-ref-nesting";

interface Flat {
  id: string;
  parentId: string | null;
  depth: number;
  node: TreeNode;
}

export function flattenVisibleTree(
  tree: TreeNode[],
  expanded: Set<string>,
): Flat[] {
  const out: Flat[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      // Collection rows are full pages so their body stays editable, but the
      // collection surface is their navigation. Listing every imported row in
      // the ordinary page tree would turn a 44-row database into 44 sidebar
      // entries and would also expose them to unrestricted page drag/drop.
      if (n.collectionRow) continue;
      const hasVisibleChildren = n.children.some((child) => !child.collectionRow);
      out.push({
        id: n.id,
        parentId: n.parentId,
        depth,
        node:
          hasVisibleChildren === n.hasChildren
            ? n
            : { ...n, hasChildren: hasVisibleChildren },
      });
      if (expanded.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

function descendantIds(node: TreeNode): string[] {
  const ids: string[] = [];
  const walk = (n: TreeNode) =>
    n.children.forEach((c) => {
      if (c.collectionRow) return;
      ids.push(c.id);
      walk(c);
    });
  walk(node);
  return ids;
}

/** The row under the pointer, not the row nearest the dragged block's centre.
 * Which row you are on has to be the row the pointer is visibly on, because
 * "into or between" is read off that row's own height. Rows tile without gaps,
 * so `pointerWithin` answers everywhere over the list; the fallback only
 * covers the pointer leaving the list sideways. */
const rowUnderPointer: CollisionDetection = (args) => {
  const withinRow = pointerWithin(args);
  return withinRow.length > 0 ? withinRow : closestCenter(args);
};

/** The rows hold still for the whole gesture. A drop says what it is about to
 * do with a ring or a line; the list does not mime it by opening a gap, and a
 * rect measured mid-drag is the rect the drop is resolved against.
 *
 * Module scope on purpose: a strategy created per render changes the sortable
 * context on every keystroke's worth of state, which re-registers every row —
 * mid-drag that is enough to lose the drag. */
const holdStill: SortingStrategy = () => null;

export interface TreeHandlers {
  selectedId: string | null;
  expanded: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (id: string, title: string) => void;
  onRename: (id: string, title: string, invoker: HTMLElement | null) => void;
  onCopyLink: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDialogIntent: () => void;
  onMoveRequest: (
    id: string,
    title: string,
    invoker: HTMLElement | null,
  ) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onMove: (id: string, newParentId: string | null, beforeId: string | null) => void;
  onReparentPageRef?: ReparentPageRef;
  pageRefSourcePageId: string | null;
  /** warm the page cache when a row is hovered, so the click is instant */
  onPrefetch?: (id: string) => void;
}

// memoized: the sidebar tree only depends on tree/selection/expanded + stable
// callbacks, so typing in the editor (which bumps unrelated shell state) no
// longer re-renders the whole tree
export const SortableTree = memo(function SortableTree({
  tree,
  ...h
}: { tree: TreeNode[] } & TreeHandlers) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Which band of the hovered row the pointer is in. The middle means "into
  // this page", the top and bottom mean "between rows" — the same model the
  // editor's page-ref drag uses, out of the same function.
  const [zone, setZone] = useState<DropZone | null>(null);

  // whole-row dragging: mouse needs a small distance so clicks still select;
  // touch needs a hold delay so the list can still scroll
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  // The live pointer — not the dragged block's centre, and not the activator
  // event plus a delta: while the list autoscrolls those two move in opposite
  // directions and the band would be read off the wrong place.
  const pointerY = useRef<number | null>(null);
  useEffect(() => {
    if (!activeId) return;
    const trackPointer = (event: MouseEvent) => {
      pointerY.current = event.clientY;
    };
    const trackTouch = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (touch) pointerY.current = touch.clientY;
    };
    window.addEventListener("pointermove", trackPointer, true);
    window.addEventListener("touchmove", trackTouch, true);
    return () => {
      window.removeEventListener("pointermove", trackPointer, true);
      window.removeEventListener("touchmove", trackTouch, true);
    };
  }, [activeId]);

  const flat = useMemo(
    () => flattenVisibleTree(tree, h.expanded),
    [tree, h.expanded],
  );

  // during drag, hide the dragged node's descendants (it moves as a unit), so
  // no drop resolved from this list can land inside the subtree being moved
  const items = useMemo(() => {
    if (!activeId) return flat;
    const activeNode = flat.find((i) => i.id === activeId)?.node;
    const hidden = new Set(activeNode ? descendantIds(activeNode) : []);
    return flat.filter((i) => !hidden.has(i.id));
  }, [flat, activeId]);

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);

  const drop: TreeDrop | null = useMemo(() => {
    if (!activeId) return null;
    return resolveTreeDrop({
      rows: items.map((i) => ({
        id: i.id,
        parentId: i.parentId,
        depth: i.depth,
        collection: !!i.node.collection,
      })),
      activeId,
      overId,
      zone,
    });
  }, [activeId, overId, zone, items]);

  const activeNode = flat.find((i) => i.id === activeId)?.node ?? null;
  const dropIntoId = drop?.into ? overId : null;

  // hovering the middle of a collapsed parent long enough expands it, so a
  // drag can descend into subtrees without a second trip
  useEffect(() => {
    if (!dropIntoId || h.expanded.has(dropIntoId)) return;
    const over = flat.find((i) => i.id === dropIntoId);
    if (!over?.node.hasChildren) return;
    const t = setTimeout(() => h.onToggle(dropIntoId), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropIntoId]);

  const endDrag = () => {
    setActiveId(null);
    setOverId(null);
    setZone(null);
    pointerY.current = null;
  };

  return (
    <DndContext
      id="brain-page-tree"
      sensors={sensors}
      collisionDetection={rowUnderPointer}
      onDragStart={({ active }: DragStartEvent) => {
        setActiveId(String(active.id));
        setOverId(String(active.id));
        setZone(null);
      }}
      onDragMove={({ over }: DragMoveEvent) => {
        setOverId(over ? String(over.id) : null);
        const clientY = pointerY.current;
        setZone(
          over && clientY !== null
            ? resolveDropZone({
                clientY,
                targetTop: over.rect.top,
                targetHeight: over.rect.height,
              })
            : null,
        );
      }}
      onDragEnd={({ active }: DragEndEvent) => {
        if (drop) h.onMove(String(active.id), drop.parentId, drop.beforeId);
        endDrag();
      }}
      onDragCancel={endDrag}
    >
      <SortableContext items={itemIds} strategy={holdStill}>
        <AnimatePresence initial={false}>
          {items.map((it) => (
            <motion.div
              key={it.id}
              // expand/collapse + create/delete grow and shrink rows;
              // disabled during drag to not fight dnd-kit's transforms
              initial={activeId ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={activeId ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: DUR.base, ease: EASE_OUT }}
              // overflow-hidden clips a row when dnd-kit translates it during a
              // drag (rows vanish); only clip when animating expand/collapse
              className={activeId ? undefined : "overflow-hidden"}
            >
              <Row
                flat={it}
                tree={tree}
                isDropInto={it.id === dropIntoId && it.id !== activeId}
                dropEdge={
                  drop && !drop.into && overId === it.id && it.id !== activeId
                    ? (zone as "before" | "after")
                    : null
                }
                dropDepth={drop?.depth ?? 0}
                {...h}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </SortableContext>
      <DragOverlay>
        {activeNode ? (
          /* the lifted row under the pointer (--lift); the slot it left stays
             open at its own height so nothing below it shifts */
          <div className="tree-row-overlay">
            <span className="tree-row-glyph" aria-hidden>
              {activeNode.icon ?? <Icon name="hashtag" size={16} />}
            </span>
            <span className="tree-row-title">{activeNode.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

function Row({
  flat,
  tree,
  isDropInto,
  dropEdge,
  dropDepth,
  selectedId,
  expanded,
  onSelect,
  onToggle,
  onAddChild,
  onDelete,
  onRename,
  onCopyLink,
  onDuplicate,
  onDialogIntent,
  onMoveRequest,
  onTogglePin,
  onPrefetch,
  onReparentPageRef,
  pageRefSourcePageId,
}: {
  flat: Flat;
  tree: TreeNode[];
  isDropInto?: boolean;
  dropEdge?: "before" | "after" | null;
  dropDepth?: number;
} & TreeHandlers) {
  const node = flat.node;
  const depth = flat.depth;
  const prefetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(prefetchTimer.current), []);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id });
  const open = expanded.has(node.id);
  const active = node.id === selectedId;
  const [pageRefOver, setPageRefOver] = useState(false);

  const hasPageRefDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes(BRAIN_PAGE_REF_DRAG_MIME);
  const validActivePageRefDrag = (event: React.DragEvent) => {
    if (!onReparentPageRef || !hasPageRefDrag(event)) return null;
    const source = getActivePageRefDragSource();
    if (
      !source ||
      !validatePageRefNestingTarget({
        tree,
        pageId: pageRefSourcePageId,
        source,
        targetId: node.id,
        scope: "tree",
      }).valid
    ) {
      return null;
    }
    return source;
  };
  const validDroppedPageRef = (event: React.DragEvent) => {
    const activeSource = validActivePageRefDrag(event);
    const droppedSource = decodePageRefDragPayload(
      event.dataTransfer.getData(BRAIN_PAGE_REF_DRAG_MIME),
    );
    return pageRefDragSourcesMatch(activeSource, droppedSource)
      ? droppedSource
      : null;
  };

  const dragHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (!hasPageRefDrag(event)) return;
      if (!validActivePageRefDrag(event)) {
        event.dataTransfer.dropEffect = "none";
        setPageRefOver(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setPageRefOver(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!hasPageRefDrag(event)) return;
      if (!validActivePageRefDrag(event)) {
        event.dataTransfer.dropEffect = "none";
        setPageRefOver(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (!pageRefOver) setPageRefOver(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) return;
      setPageRefOver(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!hasPageRefDrag(event)) return;
      const source = validDroppedPageRef(event);
      if (!source) {
        event.dataTransfer.dropEffect = "none";
        setPageRefOver(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPageRefOver(false);
      const request = onReparentPageRef?.(source, node.id, "tree");
      if (request) acceptExternalPageRefNesting(request);
    },
  };

  // The dragged row rides the DragOverlay. The slot it left keeps its height,
  // so every row below stays exactly where the reader last saw it.
  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        data-tree-page-id={node.id}
        data-tree-row-slot=""
        {...attributes}
        {...listeners}
        className="tree-row-slot"
        style={{ transform: CSS.Translate.toString(transform), transition }}
      />
    );
  }

  return (
    <PageContextMenu
      pinned={node.pinned}
      canAddChild={!node.collection}
      onAddChild={() => onAddChild(node.id)}
      onRename={(invoker) => onRename(node.id, node.title, invoker)}
      onCopyLink={() => onCopyLink(node.id)}
      onDuplicate={() => onDuplicate(node.id)}
      onDialogIntent={onDialogIntent}
      onMoveRequest={(invoker) =>
        onMoveRequest(node.id, node.title, invoker)
      }
      onTogglePin={() => onTogglePin(node.id, !node.pinned)}
      onDelete={() => onDelete(node.id, node.title)}
    >
    <TreeRow
      ref={setNodeRef}
      data-tree-page-id={node.id}
      {...attributes}
      {...listeners}
      {...dragHandlers}
      title={node.title}
      emoji={node.icon || undefined}
      depth={depth}
      selected={active}
      hasChildren={!!node.hasChildren}
      expanded={open}
      onToggle={() => onToggle(node.id)}
      dropInto={isDropInto || pageRefOver}
      dropEdge={dropEdge ?? null}
      dropDepth={dropDepth}
      layoutId={SIDEBAR_SELECT_LAYOUT_ID}
      className="touch-manipulation"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      onClick={() => onSelect(node.id)}
      onPointerEnter={() => {
        // hover-intent: only a deliberate pause prefetches — sweeping the
        // pointer across the tree must not fire a GET per row crossed
        if (!onPrefetch) return;
        clearTimeout(prefetchTimer.current);
        prefetchTimer.current = setTimeout(() => onPrefetch(node.id), 120);
      }}
      onPointerLeave={() => clearTimeout(prefetchTimer.current)}
      menu={
        /* single "…" menu owns all row actions (New page inside lives inside) */
        <RowMenu
          pinned={node.pinned}
          canAddChild={!node.collection}
          onAddChild={() => onAddChild(node.id)}
          onRename={(invoker) => onRename(node.id, node.title, invoker)}
          onCopyLink={() => onCopyLink(node.id)}
          onDuplicate={() => onDuplicate(node.id)}
          onDialogIntent={onDialogIntent}
          onMoveRequest={(invoker) =>
            onMoveRequest(node.id, node.title, invoker)
          }
          onTogglePin={() => onTogglePin(node.id, !node.pinned)}
          onDelete={() => onDelete(node.id, node.title)}
        >
          <IconButton
            size={28}
            aria-label="More actions"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="menu-dots-bold" size={16} />
          </IconButton>
        </RowMenu>
      }
    />
    </PageContextMenu>
  );
}
