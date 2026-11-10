"use client";

import * as Popover from "@radix-ui/react-popover";
import { useRef, useState } from "react";
import { normalizeTaskCategoryName, taskCategoryKey } from "@/lib/tasks/details";
import type { TaskCategory } from "./tasks-client";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { useLayerSignal } from "./use-layer-signal";

export function TaskCategoryGlyph({ icon }: { icon?: string }) {
  return <span className="tree-row-glyph" aria-hidden>{icon || <Icon name="document-text" size={16} />}</span>;
}

const normalized = normalizeTaskCategoryName;
const keyOf = taskCategoryKey;

export function TasksCategoryPicker({ value, categories, onSelect, onCreate, onOpenChange }: {
  value?: string;
  categories: readonly TaskCategory[];
  onSelect: (name: string | undefined) => void;
  onCreate: (name: string) => Promise<TaskCategory>;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useLayerSignal(open, onOpenChange);
  const name = normalized(query);
  const exact = categories.find((entry) => keyOf(entry.name) === keyOf(name));
  const current = categories.find((entry) => keyOf(entry.name) === keyOf(value || ""));
  const filtered = categories.filter((entry) => keyOf(entry.name).includes(keyOf(query)));
  function close() { setOpen(false); setQuery(""); setError(null); }
  function choose(category: string | undefined) { onSelect(category); close(); }
  async function create() {
    if (!name || pending) return;
    if (exact) { choose(exact.name); return; }
    setPending(true);
    try { const saved = await onCreate(name); choose(saved.name); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t create this category. Try again."); }
    finally { setPending(false); }
  }
  return <Popover.Root open={open} onOpenChange={(next) => { if (pending) return; if (next) setOpen(true); else close(); }}>
    <Popover.Trigger asChild><Button type="button" variant="quiet" className="tasks-detail-property" aria-label={`Category: ${value || "No category"}`}><TaskCategoryGlyph icon={current?.icon} /><span>{value || "No category"}</span><Icon name="alt-arrow-down" size={14} /></Button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={16} className="brain-menu tasks-picker tasks-category-picker z-[var(--z-modal)]" aria-label="Choose or create a category" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }} onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!pending) close(); }}>
      <div className="tasks-picker-panel">
        <Field ref={input} on="glass" className="tasks-picker-field" aria-label="Category name" placeholder="Category name" maxLength={200} value={query} disabled={pending} onChange={(event) => { setQuery(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void create(); } }} />
        <ScrollEdge variant="fade" className="tasks-picker-list" scrollerProps={{ role: "group", "aria-label": "Categories" }}>
          {filtered.map((entry) => <button key={entry.name} type="button" className="brain-menu-item focus-inset" aria-pressed={value === entry.name} disabled={pending} onClick={() => choose(entry.name)}><TaskCategoryGlyph icon={entry.icon} /><span className="min-w-0 flex-1 truncate">{entry.name}</span>{value === entry.name && <Icon name="check" size={14} />}</button>)}
          {name && !exact && <button type="button" className="brain-menu-item tasks-create-category focus-inset" disabled={pending} onClick={() => void create()}><Icon name="add" size={16} /><span className="min-w-0 truncate">{pending ? "Creating…" : error ? "Try again" : `Create “${name}”`}</span></button>}
          {value && !query && <><div className="brain-menu-sep" /><button type="button" className="brain-menu-item focus-inset" onClick={() => choose(undefined)}>Remove category</button></>}
        </ScrollEdge>
        {error && <p role="alert" className="tasks-picker-error text-caption">{error}</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
