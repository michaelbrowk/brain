"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { isLinkedTask, type TaskView } from "@/lib/tasks/model";
import { doneDayOf, listOf, logbookRows } from "@/lib/tasks/lists";
import { taskCategoryKey } from "@/lib/tasks/details";
import type { TasksListState } from "./shell/helpers";
import { surfaceTakesKeys } from "./shell/surface-keys";
import { useTaskActions } from "./tasks-actions";
import { createTask, createTaskCategory, deleteTask, listTaskCategories, mutateTasks, patchTask, reloadTasks, updateTaskCategory, useTasks, type TaskCategory, type TaskPatch } from "./tasks-client";
import { onTaskCommand } from "./tasks-commands";
import { TasksNavigation, TasksRail, viewLabel } from "./tasks-list-menu";
import { TasksCompactRow } from "./tasks-compact-row";
import { TasksTaskDialog, type TaskDialogDraft } from "./tasks-task-dialog";
import type { TaskPageOption } from "./tasks-linked-pages";
import { type TaskCounts, type TasksView, type TaskRow } from "./tasks-lists";
import { tomorrowOf, whenValueFor } from "./tasks-row";
import type { WhenValue } from "./tasks-when-picker";
import { EmojiPicker } from "./emoji-picker";
import { Button, IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { Empty } from "./ui/empty";
import type { ToastOptions } from "./ui/primitives";
import { LAYER_IN_DOCUMENT } from "./use-layer-signal";

export type { TaskFieldPatch } from "./tasks-actions";
export type { TaskCounts } from "./tasks-lists";
export interface TasksSurfaceProps {
  list?: TasksListState | null;
  onSelectList?: (list: TasksListState | null) => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  refreshToken?: number;
  captureRequest?: number;
  onCaptureHandled?: (request: number) => void;
  pageTitleOf?: (pageId: string) => string | undefined;
  pages?: readonly TaskPageOption[];
  onOpenPage?: (pageId: string) => void;
  onDialogOpenChange?: (open: boolean) => void;
}
interface EditorState { key: number; task?: TaskView; category?: string; when: WhenValue }
const noPages: readonly TaskPageOption[] = [];

export function TasksSurface({ list = null, onSelectList, onToast, refreshToken = 0, captureRequest = 0, onCaptureHandled, pageTitleOf, pages = noPages, onOpenPage, onDialogOpenChange }: TasksSurfaceProps) {
  const state = useTasks(refreshToken);
  const today = state.day?.today || "";
  const offsetMinutes = state.day?.offsetMinutes || 0;
  const reduce = useReducedMotion() ?? false;
  const view: TasksView = useMemo(() => typeof list === "object" && list !== null ? { kind: "category", category: list.category } : { kind: "list", list: list || "today" }, [list]);
  const actions = useTaskActions({ today, offsetMinutes, onToast });
  const [catalog, setCatalog] = useState<TaskCategory[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ completed: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const surface = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const serial = useRef(0);
  const handledCapture = useRef(0);
  const pendingNamedTask = useRef<string | null>(null);
  const layerKeys = useRef(new WeakSet<KeyboardEvent>());
  const categories = useMemo(() => {
    const merged = new Map(catalog.map((entry) => [taskCategoryKey(entry.name), entry]));
    for (const task of state.tasks) if (task.category && !merged.has(taskCategoryKey(task.category))) merged.set(taskCategoryKey(task.category), { name: task.category });
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, state.tasks]);
  const navigationCategories = useMemo(() => state.tasks.some((task) => !task.category) ? [...categories, { name: "" }] : categories, [categories, state.tasks]);
  const categoryFor = useCallback((name?: string) => categories.find((entry) => taskCategoryKey(entry.name) === taskCategoryKey(name || "")), [categories]);
  const matches = useCallback((task: TaskView) => view.kind === "category" ? taskCategoryKey(task.category || "") === taskCategoryKey(view.category) : view.list === "all" || listOf(task, today, offsetMinutes) === view.list, [view, today, offsetMinutes]);
  const active = useMemo(() => state.tasks.filter((task) => !task.done && matches(task)).sort((a, b) => {
    const late = (task: TaskView) => !!(task.deadline && task.deadline < today || task.when && task.when !== "someday" && task.when < today);
    return Number(late(b)) - Number(late(a)) || a.created.localeCompare(b.created);
  }), [state.tasks, matches, today]);
  const groups = useMemo(() => {
    const result = new Map<string, { name: string; tasks: TaskView[] }>();
    for (const task of active) { const key = taskCategoryKey(task.category || ""); const group = result.get(key); if (group) group.tasks.push(task); else result.set(key, { name: categoryFor(task.category)?.name || task.category || "No category", tasks: [task] }); }
    return [...result.entries()].map(([key, group]) => ({ key, ...group }));
  }, [active, categoryFor]);
  const completed = useMemo(() => logbookRows(state.tasks, today, offsetMinutes).filter((row) => {
    if (view.kind === "category") return taskCategoryKey(row.task.category || "") === taskCategoryKey(view.category);
    if (view.list === "all" || view.list === "logbook") return true;
    if (view.list === "today") return !!row.task.doneAt && doneDayOf(row.task.doneAt, offsetMinutes) === today;
    return listOf({ ...row.task, done: false }, today, offsetMinutes) === view.list;
  }), [state.tasks, today, offsetMinutes, view]);
  const drawn: TaskRow[] = useMemo(() => [...active.map((task) => ({ key: task.id, task, untickable: true })), ...(!collapsed.completed ? completed : [])], [active, completed, collapsed.completed]);

  useEffect(() => { let mounted = true; void listTaskCategories().then((entries) => { if (mounted) setCatalog(entries); }).catch(() => { /* Task-derived categories stay available if the catalog cannot load. */ }); return () => { mounted = false; }; }, [refreshToken]);
  useEffect(() => { onDialogOpenChange?.(editor !== null); return () => onDialogOpenChange?.(false); }, [editor, onDialogOpenChange]);
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [list]);
  const openTask = useCallback((task?: TaskView, invoker?: HTMLElement) => {
    returnFocus.current = invoker || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setEditor({ key: ++serial.current, task, category: task?.category || (view.kind === "category" ? view.category || undefined : undefined), when: task ? { when: task.when || null, evening: !!task.evening, time: task.time || null } : { when: view.kind === "list" && view.list === "today" ? today : view.kind === "list" && view.list === "upcoming" ? tomorrowOf(today) : view.kind === "list" && view.list === "someday" ? "someday" : null, evening: false, time: null } });
  }, [view, today]);
  useEffect(() => { if (!today || !captureRequest || handledCapture.current === captureRequest) return; handledCapture.current = captureRequest; onCaptureHandled?.(captureRequest); queueMicrotask(() => openTask()); }, [captureRequest, today, openTask, onCaptureHandled]);
  useEffect(() => {
    function openNamed() {
      const id = new URLSearchParams(window.location.search).get("task") || pendingNamedTask.current;
      if (!id || !today || state.loading) return;
      const task = state.tasks.find((entry) => entry.id === id);
      if (task) { pendingNamedTask.current = null; openTask(task); }
      const url = new URL(window.location.href); url.searchParams.delete("task"); window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    queueMicrotask(openNamed); window.addEventListener("popstate", openNamed);
    return () => window.removeEventListener("popstate", openNamed);
  }, [state.tasks, state.loading, today, openTask]);
  const moveTask = useCallback(async (task: TaskView, when: string, label: string) => { try { await actions.rescheduleTask(task, whenValueFor(task, when), label); } finally { actions.releaseFold(task.id); } }, [actions]);
  useEffect(() => onTaskCommand((command) => { const row = drawn.find((entry) => entry.key === selectedId); if (!row?.untickable || row.task.done) return; void moveTask(row.task, command === "move-today" ? today : "someday", command === "move-today" ? "Today" : "Someday").catch(() => {}); }), [drawn, selectedId, today, moveTask]);
  useEffect(() => {
    const capture = (event: KeyboardEvent) => { if (document.querySelector(LAYER_IN_DOCUMENT)) layerKeys.current.add(event); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || layerKeys.current.has(event) || editor || !surfaceTakesKeys(surface.current)) return;
      if (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable]")) return;
      const meta = event.metaKey || event.ctrlKey;
      const rows = drawn.filter((entry) => entry.untickable);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const at = rows.findIndex((entry) => entry.key === selectedId); const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]; if (next) { setSelectedId(next.key); surface.current?.querySelector<HTMLButtonElement>(`[data-row-key="${CSS.escape(next.key)}"] .tasks-compact-open`)?.focus(); } return; }
      if (!meta && !event.altKey && event.key.toLowerCase() === "n") { event.preventDefault(); openTask(); return; }
      const selected = rows.find((entry) => entry.key === selectedId); if (!selected || selected.task.done) return;
      if (meta && event.key === "Enter") { event.preventDefault(); void actions.completeTask(selected.task).catch(() => {}); return; }
      const when = meta && event.key === "]" ? tomorrowOf(today) : !meta && event.key.toLowerCase() === "t" ? today : !meta && event.key.toLowerCase() === "s" ? "someday" : null;
      if (when) { event.preventDefault(); void moveTask(selected.task, when, when === today ? "Today" : when === "someday" ? "Someday" : "Tomorrow").catch(() => {}); }
    };
    window.addEventListener("keydown", capture, true); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", capture, true); window.removeEventListener("keydown", key); };
  }, [editor, drawn, selectedId, today, actions, moveTask, openTask]);
  function restoreFocus() { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else { const mobile = surface.current?.querySelector<HTMLButtonElement>(".tasks-narrow-navigation button"); if (mobile && getComputedStyle(mobile.parentElement!).display !== "none") mobile.focus(); else heading.current?.focus(); } }
  async function createCategory(name: string) { const saved = await createTaskCategory(name); setCatalog((entries) => [...entries.filter((entry) => taskCategoryKey(entry.name) !== taskCategoryKey(saved.name)), saved]); return saved; }
  async function setIcon(name: string, icon: string | null) { try { const saved = await updateTaskCategory(name, icon); setCatalog((entries) => [...entries.filter((entry) => taskCategoryKey(entry.name) !== taskCategoryKey(saved.name)), saved]); } catch (error) { onToast?.(error instanceof Error ? error.message : "Couldn’t update this icon", { urgent: true }); } }
  function emoji(name: string, large = false) { const icon = categoryFor(name)?.icon; return <EmojiPicker hasIcon={!!icon} onPick={(next) => void setIcon(name, next)} onRemove={() => void setIcon(name, null)}><IconButton type="button" size={large ? 36 : 28} className={large ? "tasks-category-emoji tasks-category-emoji-large" : "tasks-category-emoji"} aria-label={`${icon ? "Change" : "Add"} category icon: ${name}`}><span aria-hidden>{icon || <Icon name="document-text" size={large ? 24 : 16} />}</span></IconButton></EmojiPicker>; }
  async function save(draft: TaskDialogDraft) {
    const task = draft.baseline || editor?.task;
    let saved: TaskView;
    if (task) {
      const patch: TaskPatch = { body: draft.body, bodyRev: draft.bodyRev };
      if (!isLinkedTask(task) && draft.title !== task.title) patch.title = draft.title;
      if ((task.category || null) !== (draft.category || null)) patch.category = draft.category || null;
      if ((task.when || null) !== draft.when.when) patch.when = draft.when.when;
      if (!!task.evening !== draft.when.evening) patch.evening = draft.when.evening ? true : null;
      if ((task.time || null) !== draft.when.time) patch.time = draft.when.time;
      if ((task.deadline || null) !== draft.deadline) patch.deadline = draft.deadline;
      if (JSON.stringify(task.repeat || null) !== JSON.stringify(draft.repeat)) patch.repeat = draft.repeat;
      if (JSON.stringify(task.relatedPageIds || []) !== JSON.stringify(draft.relatedPageIds)) patch.relatedPageIds = draft.relatedPageIds;
      saved = await patchTask(task.id, patch);
      mutateTasks((entries) => entries.map((entry) => entry.id === saved.id ? saved : entry));
    } else {
      saved = await createTask({ title: draft.title, body: draft.body, relatedPageIds: draft.relatedPageIds, ...(draft.category ? { category: draft.category } : {}), ...(draft.when.when ? { when: draft.when.when } : {}), ...(draft.when.evening ? { evening: true } : {}), ...(draft.when.time ? { time: draft.when.time } : {}), ...(draft.deadline ? { deadline: draft.deadline } : {}), ...(draft.repeat ? { repeat: draft.repeat } : {}) });
      mutateTasks((entries) => [saved, ...entries]); actions.markInserted(saved.id);
    }
    onToast?.(task ? "Changes saved" : "Task created");
  }
  async function remove() { if (!editor?.task) return; const id = editor.task.id; await deleteTask(id); mutateTasks((entries) => entries.filter((entry) => entry.id !== id)); onToast?.("Task deleted"); }
  function row(entry: TaskRow, finished = false) { return <TasksCompactRow key={entry.key} task={entry.task} rowKey={entry.key} historic={!entry.untickable} selected={selectedId === entry.key} today={today} offsetMinutes={offsetMinutes} reduce={reduce} pageTitle={entry.task.page ? pageTitleOf?.(entry.task.page) || pages.find((page) => page.id === entry.task.page)?.title : undefined} categoryIcon={categoryFor(entry.task.category)?.icon} showCategory={finished && view.kind !== "category"} showPlan={view.kind === "category" || view.list !== "today"} onOpen={openTask} onSelect={setSelectedId} onComplete={actions.completeTask} onReopen={actions.reopenTask} />; }
  const label = view.kind === "category" ? categoryFor(view.category)?.name || view.category || "No category" : viewLabel(view);
  return <section ref={surface} aria-label="Tasks" data-testid="tasks-surface" className="brain-tasks tasks-workspace">
    <TasksRail view={view} categories={navigationCategories} onSelect={(next) => onSelectList?.(next)} onNew={() => openTask()} />
    <div className="tasks-narrow-navigation"><TasksNavigation view={view} categories={navigationCategories} onSelect={(next) => onSelectList?.(next)} /></div>
    <div className="tasks-workspace-scroll" ref={scroller}><div className="tasks-workspace-canvas">
      <header className="tasks-workspace-header">{view.kind === "category" && view.category && emoji(view.category, true)}<h1 ref={heading} tabIndex={-1} className="text-title">{label}</h1></header>
      {state.error && <div className="tasks-workspace-message"><Empty icon="checklist-linear" title="Tasks could not load" hint={state.error} /><Button variant="quiet" onClick={() => reloadTasks()}>Try again</Button></div>}
      {!state.loading && !state.error && groups.length === 0 && <div className="tasks-workspace-empty"><Empty icon="checklist-linear" title="Nothing here" /></div>}
      {groups.map((group) => <section key={group.key} className="tasks-workspace-group">{view.kind !== "category" && <div className="tasks-group-heading">{group.key && emoji(group.name)}<button type="button" aria-expanded={!collapsed[group.key]} onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))}><h2 className="text-subheading">{group.name}</h2><Icon name={collapsed[group.key] ? "alt-arrow-right" : "alt-arrow-down"} size={14} /></button></div>}{!collapsed[group.key] && <ul>{group.tasks.map((task) => row({ key: task.id, task, untickable: true }))}</ul>}</section>)}
      {completed.length > 0 && <section className="tasks-workspace-completed"><button type="button" className="tasks-completed-toggle text-control" aria-expanded={!collapsed.completed} onClick={() => setCollapsed((current) => ({ ...current, completed: !current.completed }))}><Icon name={collapsed.completed ? "alt-arrow-right" : "alt-arrow-down"} size={14} />Completed<span className="text-caption">{completed.length}</span></button>{!collapsed.completed && <ul>{completed.map((entry) => row(entry, true))}</ul>}</section>}
    </div></div>
    <button type="button" className="brain-mobile-new tasks-tablet-new fixed brain-touch-min focus-inset" data-hidden={editor ? "" : undefined} inert={editor ? true : undefined} aria-label="Add task" onClick={() => openTask()}><span className="brain-mobile-new-circle"><Icon name="add" size={17} /></span></button>
    {editor && <TasksTaskDialog key={editor.key} task={editor.task} category={editor.category} when={editor.when} today={today} categories={categories} pages={pages} onCreateCategory={createCategory} onSave={save} onDelete={editor.task ? remove : undefined} onClose={() => setEditor(null)} onOpenPage={onOpenPage} onReturnFocus={restoreFocus} />}
  </section>;
}
export function emptyFor(
  view: TasksView,
  counts: TaskCounts,
): { icon: "checklist-linear"; title: string; hint?: string } {
  if (view.kind === "category") {
    return { icon: "checklist-linear", title: "Nothing here" };
  }
  if (view.list === "today") {
    if (counts.doneToday > 0) {
      return {
        icon: "checklist-linear",
        title: "Done for today",
        hint: `${counts.doneToday} completed`,
      };
    }
    return {
      icon: "checklist-linear",
      title: "Nothing planned today",
      hint:
        counts.upcomingThisWeek > 0
          ? `Upcoming has ${counts.upcomingThisWeek} this week`
          : "Add one above",
    };
  }
  if (view.list === "inbox") {
    return {
      icon: "checklist-linear",
      title: "Inbox is clear",
      hint: "Checkboxes in notes and MCP land here",
    };
  }
  if (view.list === "upcoming") {
    return { icon: "checklist-linear", title: "Nothing scheduled" };
  }
  if (view.list === "someday") {
    return { icon: "checklist-linear", title: "Nothing parked" };
  }
  return {
    icon: "checklist-linear",
    title: "Nothing done yet",
    hint: "Completed tasks land here, by day",
  };
}
