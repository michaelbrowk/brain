"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useDndContext, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragMoveEvent, type DragOverEvent, type DragStartEvent } from "@dnd-kit/core";
import type { TaskView } from "@/lib/tasks/model";
import { taskCategoryKey } from "@/lib/tasks/details";
import { resolveTaskDrop, type TaskDragTarget, type TaskDropIntent } from "./tasks-drag-intent";
import { TreeInsertion } from "./ui/tree-row";

interface TasksDragState { activeId: string | null; intent: TaskDropIntent | null; enabled: boolean }
const TaskDragState = createContext<TasksDragState>({ activeId: null, intent: null, enabled: false });
export function useTasksDragState() { return useContext(TaskDragState); }

function coordinates(event: Event): { x: number; y: number } | null {
  if ("touches" in event) {
    const touch = (event as TouchEvent).touches[0] || (event as TouchEvent).changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return "clientX" in event ? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY } : null;
}

export function TasksDragProvider({ tasks, disabled, children, renderOverlay, onMove, onActiveChange, onExpandCategory }: {
  tasks: readonly TaskView[];
  disabled: boolean;
  children: ReactNode;
  renderOverlay: (task: TaskView) => ReactNode;
  onMove: (id: string, intent: TaskDropIntent) => void;
  onActiveChange: (active: boolean) => void;
  onExpandCategory: (category: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [intent, setIntent] = useState<TaskDropIntent | null>(null);
  const intentRef = useRef<TaskDropIntent | null>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 220, tolerance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );
  const collision = useCallback<CollisionDetection>((args) => {
    point.current = args.pointerCoordinates;
    const hits = pointerWithin(args);
    // A row is more precise than the category section containing it.
    return hits.sort((a, b) => Number(args.droppableContainers.find((entry) => entry.id === b.id)?.data.current?.kind === "task") - Number(args.droppableContainers.find((entry) => entry.id === a.id)?.data.current?.kind === "task"));
  }, []);
  const clear = useCallback(() => {
    setActiveId(null); setIntent(null); intentRef.current = null;
    moved.current = false; start.current = null; point.current = null;
    onActiveChange(false);
  }, [onActiveChange]);
  const update = ({ active, over }: DragMoveEvent | DragOverEvent) => {
    const current = point.current;
    if (current && start.current && Math.hypot(current.x - start.current.x, current.y - start.current.y) > 2) moved.current = true;
    const data = over?.data.current as TaskDragTarget | undefined;
    const next = moved.current && over && data && current
      ? resolveTaskDrop(String(active.id), String(over.id), data, tasks, current.y, over.rect)
      : null;
    const previous = intentRef.current;
    if (previous?.targetId === next?.targetId && previous?.edge === next?.edge && previous?.beforeId === next?.beforeId && previous?.category === next?.category) return;
    intentRef.current = next; setIntent(next);
  };
  const expandCategory = intent && !intent.edge ? taskCategoryKey(intent.category || "") : null;
  useEffect(() => {
    if (expandCategory === null) return;
    const timer = setTimeout(() => onExpandCategory(expandCategory), 500);
    return () => clearTimeout(timer);
  }, [expandCategory, onExpandCategory]);
  const active = tasks.find((task) => task.id === activeId);
  const state = useMemo(() => ({ activeId, intent, enabled: !disabled }), [activeId, intent, disabled]);
  return <DndContext id="brain-tasks-drag" sensors={sensors} collisionDetection={collision}
    accessibility={{
      screenReaderInstructions: { draggable: "Hold to drag. Press Alt, Shift and Up or Down to move a task within its category. Change category in task details." },
      announcements: {
        onDragStart: ({ active }) => `${tasks.find((task) => task.id === active.id)?.title || "Task"} picked up.`,
        onDragOver: () => undefined,
        onDragEnd: () => undefined,
        onDragCancel: () => "Move canceled.",
      },
    }}
    onDragStart={({ active, activatorEvent }: DragStartEvent) => {
      start.current = coordinates(activatorEvent); point.current = start.current; moved.current = false;
      setActiveId(String(active.id)); setIntent(null); intentRef.current = null; onActiveChange(true);
    }}
    onDragMove={update} onDragOver={update}
    onDragCancel={clear}
    onDragEnd={({ active }) => { const target = moved.current ? intentRef.current : null; clear(); if (target) onMove(String(active.id), target); }}>
    <TaskDragState.Provider value={state}>
      {children}
      {typeof document !== "undefined" && createPortal(<>
        <DragOverlay dropAnimation={null} style={{ zIndex: "var(--z-modal)" }}>
          {active && <div className="tasks-drag-overlay" data-testid="tasks-drag-overlay" aria-hidden inert>{renderOverlay(active)}</div>}
        </DragOverlay>
        <TasksDragInsertion />
      </>, document.body)}
    </TaskDragState.Provider>
  </DndContext>;
}

export function useTaskDragRow(task: TaskView, enabled: boolean, preview = false, rowKey = task.id) {
  const state = useTasksDragState();
  const disabled = !state.enabled || !enabled;
  const data: TaskDragTarget = { kind: "task", taskId: task.id, category: task.category || null };
  const id = preview ? `task-preview:${task.id}` : rowKey === task.id ? task.id : `task-history:${rowKey}`;
  const { setNodeRef: setDraggableRef, setActivatorNodeRef, listeners, attributes } = useDraggable({ id, data, disabled });
  const { setNodeRef: setDroppableRef } = useDroppable({ id: `task-row:${id}`, data, disabled });
  const setNodeRef = useCallback((node: HTMLElement | null) => { setDraggableRef(node); setDroppableRef(node); }, [setDraggableRef, setDroppableRef]);
  return {
    setNodeRef, setActivatorNodeRef, listeners, attributes: disabled ? {} : attributes,
    dragging: state.activeId === task.id,
    anyDragging: state.activeId !== null,
  };
}

export function useTaskCategoryDrop(category: string, surface: "rail" | "group") {
  const state = useTasksDragState();
  const id = `task-category:${surface}:${taskCategoryKey(category)}`;
  const { setNodeRef } = useDroppable({ id, disabled: !state.enabled, data: { kind: "category", category: category || null, surface } satisfies TaskDragTarget });
  return { setNodeRef, dropInto: state.intent?.targetId === id, dragging: state.activeId !== null };
}

export function TasksCategoryDrop({ category, children }: { category: string; children: ReactNode }) {
  const { setNodeRef, dropInto } = useTaskCategoryDrop(category, "group");
  return <section ref={setNodeRef} className="tasks-workspace-group" data-drop-into={dropInto ? "" : undefined}>{children}</section>;
}

/** The full boundary stays below the lifted row; only the leading gutter
 * dot and short stem rise above it, so the cue never crosses preview text. */
function TasksDragInsertion() {
  const { intent } = useTasksDragState();
  const { droppableContainers } = useDndContext();
  const layer = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const targetId = intent?.targetId;
  const edge = intent?.edge;
  useLayoutEffect(() => {
    if (!targetId || !edge) return;
    const node = layer.current;
    const leading = marker.current;
    if (!node || !leading) return;
    node.style.visibility = "hidden";
    leading.style.visibility = "hidden";
    let frame = 0;
    let previous = "";
    const follow = () => {
      const target = droppableContainers.get(targetId)?.node.current;
      const rect = target?.isConnected ? target.getBoundingClientRect() : null;
      if (!rect || rect.width === 0 || rect.height === 0) {
        node.style.visibility = "hidden";
        leading.style.visibility = "hidden";
        frame = requestAnimationFrame(follow);
        return;
      }
      const position = `${rect.left},${rect.top},${rect.width},${rect.height}`;
      if (position !== previous) {
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        const dotX = Math.max(4, rect.left - 12);
        leading.style.left = `${dotX}px`;
        leading.style.top = `${(edge === "before" ? rect.top : rect.bottom) - 1}px`;
        leading.style.width = `${Math.max(0, rect.left - dotX)}px`;
        previous = position;
      }
      node.style.visibility = "visible";
      leading.style.visibility = "visible";
      // One geometry read during the gesture follows autoscroll and layout
      // changes without making every task rerender with each scroll frame.
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [targetId, edge, droppableContainers]);
  return edge ? <>
    <div ref={layer} className="tasks-drag-insertion" aria-hidden><TreeInsertion edge={edge} /></div>
    <div ref={marker} className="tasks-drag-marker" aria-hidden />
  </> : null;
}
