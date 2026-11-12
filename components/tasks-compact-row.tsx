"use client";

import { useRef, useState } from "react";
import type { TaskView } from "@/lib/tasks/model";
import { TaskCheckbox } from "./tasks-checkbox";
import { dayLabel, whenLabel } from "./tasks-lists";
import { Icon } from "./ui/icon";
import { TaskCategoryGlyph } from "./tasks-category-picker";
import { TasksContextMenu, type TasksContextAction } from "./tasks-context-menu";
import { useTaskDragRow } from "./tasks-drag";

export function TasksCompactRow({ task, rowKey, historic, selected, today, reduce, pageTitle, categoryIcon, showCategory, showPlan, onOpen, onSelect, onComplete, onReopen, onOpenPage, onDelete, onContextActionSettled, preview = false }: {
  task: TaskView; rowKey: string; historic?: boolean; selected: boolean; today: string; reduce: boolean;
  pageTitle?: string; categoryIcon?: string; showCategory?: boolean; showPlan?: boolean;
  onOpen: (task: TaskView, invoker: HTMLElement) => void; onSelect: (key: string) => void;
  onComplete: (task: TaskView, refusal?: string) => Promise<void>; onReopen: (task: TaskView, refusal?: string) => Promise<void>;
  onOpenPage?: (pageId: string) => void;
  onDelete?: (task: TaskView, invoker: HTMLElement | null) => void;
  onContextActionSettled?: (key: string) => void;
  preview?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, dragging, anyDragging } = useTaskDragRow(task, !preview && !pending && !task.done && rowKey === task.id, preview, rowKey);
  const deadlineInPast = !!task.deadline && task.deadline < today;
  const overdueDeadline = !task.done && deadlineInPast;
  const plannedInPast = !!task.when && task.when !== "someday" && task.when < today;
  const overduePlan = !task.done && plannedInPast;
  const hasPlan = !!task.when && (showPlan || plannedInPast || task.evening || task.time);
  const hasMeta = showCategory && !!task.category || task.deadline || hasPlan || task.page || task.repeat;
  async function toggle(fromContext = false) {
    if (pendingRef.current || historic) return;
    pendingRef.current = true;
    setPending(true);
    try { const linked = task.page && !task.detachedAt; if (task.done) await onReopen(task, linked ? `Couldn't untick in ${pageTitle || "that note"}` : undefined); else await onComplete(task, linked ? `Couldn't tick in ${pageTitle || "that note"}` : undefined); }
    catch { /* The shared actions own the refusal toast and restore. */ }
    finally { pendingRef.current = false; setPending(false); if (fromContext) onContextActionSettled?.(rowKey); }
  }
  // Every logbook projection, including the latest undoable occurrence,
  // shares its id with the live series. Its context menu must never edit it.
  const contextActions: TasksContextAction[] = historic || rowKey !== task.id ? [
    { key: "occurrence", icon: "check-read-linear", label: "Past occurrence", disabled: true, onSelect: () => {} },
  ] : [
    { key: "open", icon: "document-text-linear", label: "Open task", onSelect: (invoker) => { if (invoker) onOpen(task, invoker); } },
    { key: "complete", icon: task.done ? "restart-linear" : "check-read-linear", label: task.done ? "Mark incomplete" : "Complete task", disabled: pending, onSelect: () => void toggle(true) },
    ...(task.page && onOpenPage ? [{ key: "source", icon: "link-linear", label: "Open source page", onSelect: () => onOpenPage(task.page!) }] : []),
    ...(onDelete ? [{ key: "delete", icon: "trash-bin-trash-linear", label: "Delete task…", divider: true, disabled: pending, onSelect: (invoker: HTMLElement | null) => onDelete(task, invoker) }] : []),
  ];
  return <TasksContextMenu actions={preview ? [] : contextActions} disabled={anyDragging}><li ref={setNodeRef} tabIndex={-1} className="tasks-compact-item" data-dragging={dragging && !preview ? "" : undefined} data-task-id={preview ? undefined : task.id} data-row-key={preview ? undefined : rowKey} data-done={task.done ? "" : undefined} data-selected={selected ? "" : undefined} aria-busy={pending || undefined}>
    <div className="tasks-compact-row">
      <TaskCheckbox checked={task.done} label={`${task.done ? "Restore" : "Complete"} ${task.title}`} reduce={reduce} staticCheck={historic || preview} onToggle={() => void toggle()} />
      <button ref={setActivatorNodeRef} {...attributes} {...listeners} onMouseDown={(event) => { if (event.button === 0 && !event.ctrlKey) listeners?.onMouseDown?.(event); }} type="button" className="tasks-compact-open" aria-haspopup="dialog" aria-label={task.title} disabled={historic || preview} onFocus={() => onSelect(rowKey)} onClick={(event) => { onSelect(rowKey); onOpen(task, event.currentTarget); }}>
        <span className="tasks-compact-title text-table" dir="auto">{task.title}</span>
        {hasMeta && <span className="tasks-compact-meta text-caption">
          {showCategory && task.category && <span><TaskCategoryGlyph icon={categoryIcon} />{task.category}</span>}
          {task.deadline && <span data-overdue={overdueDeadline ? "" : undefined}><Icon name="calendar-date" size={12} />{deadlineInPast ? "Deadline overdue" : "Deadline"} · {dayLabel(task.deadline)}</span>}
          {hasPlan && <span data-overdue={overduePlan ? "" : undefined}>{!plannedInPast && "Planned · "}{whenLabel(task.when, today)}{task.evening ? " · This Evening" : ""}{!task.done && task.time ? ` · ${task.time}` : ""}</span>}
          {task.page && <span><Icon name="document-text" size={12} />{task.detachedAt ? "Source line removed" : "Note"}</span>}
          {task.repeat && <span><Icon name="restart" size={12} />Repeats</span>}
        </span>}
      </button>
    </div>
  </li></TasksContextMenu>;
}
