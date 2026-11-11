"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState } from "react";
import { isLinkedTask, type TaskRepeat, type TaskView } from "@/lib/tasks/model";
import { readTaskDetails, type TaskCategory } from "./tasks-client";
import { dayLabel } from "./tasks-lists";
import { TasksCategoryPicker } from "./tasks-category-picker";
import { TasksLinkedPages, type TaskPageOption } from "./tasks-linked-pages";
import { TasksRepeatMenu } from "./tasks-repeat-menu";
import { TasksWhenPicker, type WhenValue } from "./tasks-when-picker";
import { Button } from "./ui/button";
import { DialogBody, DialogCloseButton } from "./ui/dialog-header";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Icon } from "./ui/icon";

export interface TaskDialogDraft {
  baseline?: TaskView;
  title: string;
  category?: string;
  when: WhenValue;
  deadline: string | null;
  repeat: TaskRepeat | null;
  body: string;
  bodyRev?: string;
  relatedPageIds: string[];
}

function whenLabel(value: WhenValue) {
  const day = value.when === "someday" ? "Someday" : value.when ? dayLabel(value.when) : "When";
  return [day, value.evening ? "This Evening" : "", value.time || ""].filter(Boolean).join(" · ");
}

/** The dialog owns a draft. Only Save/Create writes it; the source checkbox
 * and completion still belong to the existing task actions. */
export function TasksTaskDialog({ task, category: initialCategory, when: initialWhen, today, categories, pages, onCreateCategory, onClose, onSave, onDelete, onOpenPage, onReturnFocus }: {
  task?: TaskView;
  category?: string;
  when: WhenValue;
  today: string;
  categories: readonly TaskCategory[];
  pages: readonly TaskPageOption[];
  onCreateCategory: (name: string) => Promise<TaskCategory>;
  onClose: () => void;
  onSave: (draft: TaskDialogDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  onOpenPage?: (pageId: string) => void;
  onReturnFocus: () => void;
}) {
  const formId = useId();
  const [baseline, setBaseline] = useState(task);
  const [title, setTitle] = useState(task?.title || "");
  const [category, setCategory] = useState(initialCategory);
  const [when, setWhen] = useState(initialWhen);
  const [deadline, setDeadline] = useState<string | null>(task?.deadline || null);
  const [repeat, setRepeat] = useState<TaskRepeat | null>(task?.repeat || null);
  const [body, setBody] = useState("");
  const [bodyRev, setBodyRev] = useState<string>();
  const [relatedPageIds, setRelatedPageIds] = useState<string[]>([...new Set(task?.relatedPageIds || [])]);
  const [loading, setLoading] = useState(!!task);
  const [loadVersion, setLoadVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const layers = useRef(new Set<string>());
  const linked = !!baseline && isLinkedTask(baseline);
  const source = task?.page ? pages.find((page) => page.id === task.page) : undefined;
  function layer(name: string, open: boolean) { if (open) layers.current.add(name); else layers.current.delete(name); }
  function grow(node: HTMLTextAreaElement | null) { if (node) { node.style.height = "auto"; node.style.height = Math.max(node.name === "title" ? 31 : 98, node.scrollHeight) + "px"; } }
  useEffect(() => {
    if (!task) return;
    let active = true;
    void readTaskDetails(task.id).then((details) => {
      if (!active) return;
      setBaseline(details.task); setTitle(details.task.title); setCategory(details.task.category);
      setWhen({ when: details.task.when || null, evening: !!details.task.evening, time: details.task.time || null });
      setDeadline(details.task.deadline || null); setRepeat(details.task.repeat || null);
      setRelatedPageIds([...new Set(details.task.relatedPageIds || [])]);
      setBody(details.body); setBodyRev(details.bodyRev); setLoading(false); setError(null);
    }).catch((failure: unknown) => {
      if (!active) return;
      setError(failure instanceof Error ? failure.message : "Couldn’t load this task. Try again.");
    });
    return () => { active = false; };
  }, [task, loadVersion]);
  useEffect(() => { grow(titleRef.current); grow(notesRef.current); }, [body, title]);
  function close() { if (!pending) onClose(); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || loading) return;
    const fields = new FormData(event.currentTarget);
    const nextTitle = String(fields.get("title") || "").trim();
    if (!nextTitle) { setError("Enter a task title."); titleRef.current?.focus(); return; }
    setPending(true); setError(null);
    try {
      await onSave({ baseline, title: nextTitle, category, when, deadline, repeat, body: String(fields.get("body") || ""), bodyRev, relatedPageIds });
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t save this task. Your changes are still here."); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!onDelete || pending) return;
    setPending(true); setError(null);
    try { await onDelete(); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t delete this task. Try again."); }
    finally { setPending(false); }
  }
  const primary = (className: string) => <Button className={className} variant="ink" type="submit" form={formId} disabled={pending || loading || !title.trim()}>{pending ? "Saving…" : task ? "Save" : "Create"}</Button>;
  const draftTask: TaskView = { id: "draft", title, created: "", updated: "", done: false, ...task, when: when.when || undefined, repeat: repeat || undefined };
  return <Dialog.Root open onOpenChange={(next) => { if (!next) close(); }}><Dialog.Portal>
    <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
    <Dialog.Content ref={contentRef} className="brain-dialog brain-sheet tasks-detail fixed left-1/2 top-1/2 z-[var(--z-modal)] outline-none" aria-describedby={undefined}
      onOpenAutoFocus={(event) => { event.preventDefault(); if (task) contentRef.current?.focus(); else titleRef.current?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
      onEscapeKeyDown={(event) => { event.preventDefault(); if (!layers.current.size && !deleteOpen) close(); }}
      onInteractOutside={(event) => { if (pending || layers.current.size || deleteOpen) event.preventDefault(); }}
      onKeyDown={(event) => { if (!layers.current.size && !deleteOpen && (event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit(); } }}>
      <div className="tasks-detail-title-header flex items-start gap-2 px-5 pb-3 pt-4">
        <Dialog.Title className="sr-only">{title.trim() || "New task"}</Dialog.Title>
        <textarea ref={titleRef} form={formId} name="title" aria-label="Task title" className="tasks-inline-title text-subheading" value={title} readOnly={linked} disabled={pending || loading} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" rows={1} maxLength={500} />
        {primary("tasks-detail-primary-mobile")}<DialogCloseButton label="Close task" disabled={pending} />
      </div>
      <DialogBody className="tasks-detail-body"><form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset disabled={pending || loading}>
          {linked && <p className="tasks-detail-hint text-caption">The title comes from its source note.</p>}
          <div className="tasks-detail-properties">
            <div><span className="tasks-detail-label text-table">Category</span><TasksCategoryPicker value={category} categories={categories} onSelect={setCategory} onCreate={onCreateCategory} onOpenChange={(open) => layer("category", open)} /></div>
            <div><span className="tasks-detail-label text-table">When</span><TasksWhenPicker modal value={when} today={today} onPick={(value) => { setWhen(value); if (value.when === "someday") setDeadline(null); }} onOpenChange={(open) => layer("when", open)} ariaLabel="When" trigger={<Button type="button" variant="quiet" className="tasks-detail-property" aria-label={`When: ${whenLabel(when)}`}><Icon name="calendar-date" size={16} /><span>{whenLabel(when)}</span><Icon name="alt-arrow-down" size={14} /></Button>} /></div>
            {when.when !== "someday" && <div><span className="tasks-detail-label text-table">Deadline</span><TasksWhenPicker modal mode="deadline" value={{ when: deadline, evening: false, time: null }} today={today} onPick={(value) => setDeadline(value.when)} onOpenChange={(open) => layer("deadline", open)} ariaLabel="Deadline" trigger={<Button type="button" variant="quiet" className="tasks-detail-property" aria-label={`Deadline: ${deadline ? dayLabel(deadline) : "No deadline"}`}><Icon name="flag" size={16} /><span>{deadline ? dayLabel(deadline) : "No deadline"}</span><Icon name="alt-arrow-down" size={14} /></Button>} /></div>}
            {!linked && !task?.detachedAt && !task?.done && <div><span className="tasks-detail-label text-table">Repeat</span><TasksRepeatMenu task={draftTask} today={today} onSet={setRepeat} onOpenChange={(open) => layer("repeat", open)} /></div>}
          </div>
          <div><label className="tasks-detail-label text-table" htmlFor={formId + "-body"}>Notes</label><div className="field field-glass tasks-textarea"><textarea ref={notesRef} id={formId + "-body"} name="body" aria-label="Task notes" value={body} onChange={(event) => setBody(event.target.value)} placeholder={loading ? "Loading notes…" : "Add details…"} rows={4} /></div></div>
          <TasksLinkedPages value={relatedPageIds} pages={pages} onChange={setRelatedPageIds} onOpenChange={(open) => layer("pages", open)} />
          {task?.page && <div className="tasks-detail-source"><span className="tasks-detail-label text-table">Source</span><Button type="button" variant="quiet" className="tasks-detail-property" onClick={() => { onClose(); onOpenPage?.(task.page!); }}><TaskCategoryGlyphFallback /><span>{source?.title || "Open source note"}</span><Icon name="arrow-right-up" size={14} /></Button>{task.detachedAt && <p className="tasks-detail-hint text-caption">The original task line was removed from this note.</p>}</div>}
        </fieldset>
        {error && <div className="tasks-detail-error text-table" role="alert"><p>{error}</p>{loading && <Button type="button" variant="quiet" onClick={() => setLoadVersion((version) => version + 1)}>Try again</Button>}</div>}
      </form></DialogBody>
      <div className="tasks-detail-footer">{task && onDelete && <Button ref={deleteRef} type="button" variant="destructive" disabled={pending || loading} onClick={() => setDeleteOpen(true)}>Delete task</Button>}<span className="flex-1" /><Button type="button" variant="quiet" disabled={pending} onClick={close}>Cancel</Button>{primary("tasks-detail-primary-desktop")}</div>
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete this task?" confirmLabel="Delete task" onConfirm={() => void remove()} returnFocus={() => deleteRef.current} />
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

function TaskCategoryGlyphFallback() { return <Icon name="document-text" size={16} />; }
