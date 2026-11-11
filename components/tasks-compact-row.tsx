"use client";

import { useRef, useState } from "react";
import type { TaskView } from "@/lib/tasks/model";
import { TaskCheckbox } from "./tasks-checkbox";
import { dayLabel, doneTimeOf, whenLabel } from "./tasks-lists";
import { Icon } from "./ui/icon";
import { TaskCategoryGlyph } from "./tasks-category-picker";
import { TasksContextMenu, type TasksContextAction } from "./tasks-context-menu";

export function TasksCompactRow({ task, rowKey, historic, selected, today, offsetMinutes, reduce, pageTitle, categoryIcon, showCategory, showPlan, onOpen, onSelect, onComplete, onReopen, onOpenPage, onDelete, onContextActionSettled }: {
  task: TaskView; rowKey: string; historic?: boolean; selected: boolean; today: string; offsetMinutes: number; reduce: boolean;
  pageTitle?: string; categoryIcon?: string; showCategory?: boolean; showPlan?: boolean;
  onOpen: (task: TaskView, invoker: HTMLElement) => void; onSelect: (key: string) => void;
  onComplete: (task: TaskView, refusal?: string) => Promise<void>; onReopen: (task: TaskView, refusal?: string) => Promise<void>;
  onOpenPage?: (pageId: string) => void;
  onDelete?: (task: TaskView, invoker: HTMLElement | null) => void;
  onContextActionSettled?: (key: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const overdueDeadline = !task.done && !!task.deadline && task.deadline < today;
  const overduePlan = !task.done && !!task.when && task.when !== "someday" && task.when < today;
  const hasPlan = !!task.when && (showPlan || overduePlan || task.evening || task.time);
  const hasMeta = showCategory && !!task.category || task.deadline || hasPlan || task.page || task.repeat || task.doneAt;
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
  return <TasksContextMenu actions={contextActions}><li tabIndex={-1} className="tasks-compact-item" data-task-id={task.id} data-row-key={rowKey} data-done={task.done ? "" : undefined} data-selected={selected ? "" : undefined} aria-busy={pending || undefined}>
    <div className="tasks-compact-row">
      <TaskCheckbox checked={task.done} label={`${task.done ? "Restore" : "Complete"} ${task.title}`} reduce={reduce} staticCheck={historic} onToggle={() => void toggle()} />
      <button type="button" className="tasks-compact-open" aria-haspopup="dialog" aria-label={task.title} disabled={historic} onFocus={() => onSelect(rowKey)} onClick={(event) => { onSelect(rowKey); onOpen(task, event.currentTarget); }}>
        <span className="tasks-compact-title text-table" dir="auto">{task.title}</span>
        {hasMeta && <span className="tasks-compact-meta text-caption">
          {showCategory && task.category && <span><TaskCategoryGlyph icon={categoryIcon} />{task.category}</span>}
          {task.deadline && <span data-overdue={overdueDeadline ? "" : undefined}><Icon name="calendar-date" size={12} />{overdueDeadline ? "Deadline overdue" : "Deadline"} · {dayLabel(task.deadline)}</span>}
          {hasPlan && <span data-overdue={overduePlan ? "" : undefined}>{overduePlan ? "Planned date overdue" : "Planned"} · {whenLabel(task.when, today)}{task.evening ? " · This Evening" : ""}{task.time ? ` · ${task.time}` : ""}</span>}
          {task.page && <span><Icon name="document-text" size={12} />{task.detachedAt ? "Source line removed" : "Note"}</span>}
          {task.repeat && <span><Icon name="restart" size={12} />Repeats</span>}
          {task.done && task.updatedByName ? <span>Done by {task.updatedByName}</span> : task.doneAt ? <span>{doneTimeOf(task.doneAt, offsetMinutes)}</span> : null}
        </span>}
      </button>
    </div>
  </li></TasksContextMenu>;
}
